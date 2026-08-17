// "จัดการแขก" — the guest passes issued for a space.
//
// A pass is one named visitor's way in without an account: it can expire, be
// revoked on its own, and records when it was last used. That is what this
// screen manages, and why it is a list of passes rather than a list of people —
// a visitor only exists here from the moment someone invites them.
//
// The tabs are the pass's own states. Archived is deliberately absent from
// "ทั้งหมด": archiving is how a pass leaves the working list without being
// forgotten, so showing it in both tabs would defeat it.
import { API, authHeaders, authToken } from "./api";
import { sinceLabel } from "./memberPanel";
import { guestLinkFor } from "./workspace";
import { t, locale } from "./i18n";

export type GuestState = "active" | "expired" | "revoked" | "archived";

export interface GuestPass {
  id: string; name: string; code: string; note?: string;
  state: GuestState;
  expiresAt?: string | null; lastSeenAt?: string | null;
  visits: number; createdAt?: string;
}

const STATE_LABEL: Record<GuestState, string> = {
  active: "ใช้งานอยู่", expired: "หมดอายุแล้ว", revoked: "ถูกเพิกถอน", archived: "เก็บถาวรแล้ว",
};

const TABS: { key: "all" | GuestState; label: string }[] = [
  { key: "all", label: "ทั้งหมด" },
  { key: "active", label: "ใช้งานอยู่" },
  { key: "expired", label: "หมดอายุแล้ว" },
  { key: "revoked", label: "ถูกเพิกถอนแล้ว" },
  { key: "archived", label: "เก็บถาวรแล้ว" },
];

/** the pass lengths the API accepts; null is a pass with no expiry */
const DURATIONS: { days: number | null; label: string }[] = [
  { days: 1, label: "1 วัน" },
  { days: 7, label: "7 วัน" },
  { days: 30, label: "30 วัน" },
  { days: 90, label: "90 วัน" },
  { days: null, label: "ไม่มีวันหมดอายุ" },
];

const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

const untilLabel = (p: GuestPass) => {
  if (p.state === "archived") return t("เก็บถาวรแล้ว");
  if (p.state === "revoked") return t("ถูกเพิกถอนแล้ว");
  if (!p.expiresAt) return t("ไม่มีวันหมดอายุ");
  const d = new Date(p.expiresAt);
  const left = d.getTime() - Date.now();
  if (left <= 0) return t("หมดอายุ {date}", { date: d.toLocaleDateString(locale()) });
  const hours = Math.floor(left / 3_600_000);
  // rounded up: a pass issued for 7 days has 167-and-a-bit hours left the moment
  // it exists, and "เหลือ 6 วัน" on a brand-new pass reads as a bug
  return hours < 24 ? t("เหลือ {n} ชม.", { n: Math.max(1, hours) })
    : t("เหลือ {n} วัน", { n: Math.ceil(hours / 24) });
};

export interface GuestPanelOptions {
  host: HTMLElement;
  slug: string;
  /**
   * Whether the space already admits anyone with the link — read when the form
   * opens, not at mount time, since the general pane can toggle it afterwards.
   */
  openDoor?(): boolean;
  onCount?(activeCount: number): void;
}

export interface GuestPanel { reload(): Promise<void>; }

const closeMenus = () => document.querySelectorAll(".mp-menu").forEach((el) => el.remove());
document.addEventListener("click", closeMenus);

export function mountGuestPanel(o: GuestPanelOptions): GuestPanel {
  o.host.innerHTML = "";
  o.host.className = "mp mp-table gp";

  let passes: GuestPass[] = [];
  let state: "all" | GuestState = "all";   // which tab is showing
  let sortKey: "name" | "seen" = "name";
  let sortAsc = true;
  let denied = false;

  // ---- chrome ----
  const tabs = document.createElement("div");
  tabs.className = "gp-tabs";
  const tabButtons = new Map<string, HTMLButtonElement>();
  for (const tab of TABS) {
    const b = document.createElement("button");
    b.textContent = t(tab.label);
    b.classList.toggle("active", state === tab.key);
    b.onclick = () => { state = tab.key; tabButtons.forEach((el, k) => el.classList.toggle("active", k === tab.key)); render(); };
    tabButtons.set(tab.key, b);
    tabs.appendChild(b);
  }

  const tools = document.createElement("div");
  tools.className = "mp-tools";
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = t("ค้นหา");
  search.autocomplete = "off";
  const add = document.createElement("button");
  add.className = "mp-invite";
  add.title = t("เชิญผู้เยี่ยมชมใหม่");
  add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"'
    + ' stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/>'
    + '<path d="M3 20a6 6 0 0 1 12 0"/><path d="M18 8v6M15 11h6"/></svg>';
  tools.append(search, add);

  const msg = document.createElement("div");
  msg.className = "mp-msg";
  const form = document.createElement("div");   // the invite form, shown on demand
  form.className = "gp-form";
  form.hidden = true;
  const list = document.createElement("div");
  list.className = "mp-list";

  o.host.append(tabs, tools, msg, form);
  let head = buildHead();
  o.host.append(head, list);

  const say = (text: string, kind: "ok" | "err" = "ok") => {
    msg.textContent = text;
    msg.classList.toggle("err", kind === "err");
  };

  /** ชื่อ / สถานะ / ใช้งานล่าสุด — the same flex columns the rows declare */
  function buildHead() {
    const el = document.createElement("div");
    el.className = "mp-head";
    const avaCol = document.createElement("span");
    avaCol.className = "mp-h-ava";
    el.appendChild(avaCol);
    const col = (key: "name" | "seen", label: string, cls: string) => {
      const wrap = document.createElement("span");
      wrap.className = cls;
      const b = document.createElement("button");
      b.classList.toggle("sorted", sortKey === key);
      const arrow = document.createElement("i");
      arrow.textContent = sortKey === key ? (sortAsc ? "▲" : "▼") : "▲";
      b.append(document.createTextNode(label), arrow);
      b.onclick = () => {
        if (sortKey === key) sortAsc = !sortAsc;
        else { sortKey = key; sortAsc = true; }
        const next = buildHead();
        head.replaceWith(next);
        head = next;
        render();
      };
      wrap.appendChild(b);
      return wrap;
    };
    const stateCol = document.createElement("span");
    stateCol.className = "mp-h-role";
    el.append(col("name", t("ชื่อ"), "mp-h-name"), stateCol, col("seen", t("ใช้งานล่าสุด"), "mp-h-seen"));
    const gap = document.createElement("span");
    gap.className = "mp-h-gap";
    el.appendChild(gap);
    return el;
  }

  // ---- writes ----
  const write = async (method: "POST" | "PATCH", path: string, body: unknown) => {
    const r = await fetch(`${API}/workspaces/${encodeURIComponent(o.slug)}/guests${path}`, {
      method, headers: authHeaders(), body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({} as any));
    if (r.ok) return d;
    throw new Error(
      d.error === "forbidden" ? t("ต้องเป็นเจ้าของหรือผู้ดูแลจึงจะจัดการผู้เยี่ยมชมได้")
      : d.error === "not found" ? t("ไม่พบบัตรผู้เยี่ยมชมนี้")
      : d.error === "name required" ? t("กรอกชื่อผู้เยี่ยมชมก่อน")
      : d.error || t("ทำรายการไม่สำเร็จ"));
  };

  const copyLink = async (p: GuestPass) => {
    const link = guestLinkFor(o.slug, p.code);
    try { await navigator.clipboard.writeText(link); say(t("คัดลอกลิงก์ของ {name} แล้ว", { name: p.name })); }
    catch { say(link); } // clipboard blocked: leave it on screen to copy by hand
  };

  const patch = async (p: GuestPass, body: Record<string, unknown>, done: string) => {
    try {
      await write("PATCH", `/${p.id}`, body);
      say(done);
      await reload();
    } catch (e) { say((e as Error).message, "err"); }
  };

  // ---- the invite form ----
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = t("ชื่อผู้เยี่ยมชม เช่น คุณสมชาย (ลูกค้า)");
  const daysSelect = document.createElement("select");
  for (const d of DURATIONS) {
    const opt = document.createElement("option");
    opt.value = d.days === null ? "" : String(d.days);
    opt.textContent = t(d.label);
    daysSelect.appendChild(opt);
  }
  daysSelect.value = "7";
  const create = document.createElement("button");
  create.className = "wm-btn wm-primary";
  create.textContent = t("สร้างลิงก์");
  const cancel = document.createElement("button");
  cancel.className = "wm-btn wm-ghost";
  cancel.textContent = t("ยกเลิก");
  const formRow = document.createElement("div");
  formRow.className = "gp-form-row";
  formRow.append(nameInput, daysSelect, create, cancel);
  const formNote = document.createElement("p");
  formNote.className = "pf-note";
  const made = document.createElement("div");  // the fresh link, ready to copy
  made.className = "gp-made";
  made.hidden = true;
  form.append(formRow, formNote, made);

  const showForm = (on: boolean) => {
    form.hidden = !on;
    made.hidden = true;
    if (!on) return;
    formNote.textContent = o.openDoor?.()
      ? t("Space นี้เปิดให้ผู้เยี่ยมชมเข้าได้อยู่แล้ว — บัตรยังมีประโยชน์เพราะระบุชื่อผู้มาเยี่ยม บันทึกการเข้า และเพิกถอนรายคนได้")
      : t("Space นี้ปิดรับผู้เยี่ยมชม — คนที่ได้รับบัตรนี้จะเข้าได้เฉพาะคนเดียว ตามอายุบัตรที่กำหนด");
    nameInput.value = "";
    nameInput.focus();
  };

  add.onclick = () => showForm(form.hidden);
  cancel.onclick = () => showForm(false);
  nameInput.onkeydown = (e) => { if (e.key === "Enter") create.click(); };

  create.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) return say(t("กรอกชื่อผู้เยี่ยมชมก่อน"), "err");
    create.disabled = true;
    try {
      const days = daysSelect.value === "" ? null : Number(daysSelect.value);
      const d = await write("POST", "", { name, days });
      const pass: GuestPass = d.guest;
      say(t("สร้างบัตรของ {name} แล้ว", { name: pass.name }));
      // hand the link over straight away — an invite nobody can send is useless
      made.hidden = false;
      made.innerHTML = "";
      const link = document.createElement("input");
      link.type = "text";
      link.readOnly = true;
      link.value = guestLinkFor(o.slug, pass.code);
      link.onclick = () => link.select();
      const copy = document.createElement("button");
      copy.className = "wm-btn wm-ghost";
      copy.textContent = t("คัดลอก");
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(link.value); copy.textContent = t("คัดลอกแล้ว"); }
        catch { link.select(); }
        setTimeout(() => (copy.textContent = t("คัดลอก")), 1500);
      };
      made.append(link, copy);
      nameInput.value = "";
      await reload();
    } catch (e) { say((e as Error).message, "err"); }
    finally { create.disabled = false; }
  };

  // ---- rows ----
  type MenuItem = { label: string; icon: string; run(): void; danger?: boolean };

  /**
   * Only what the pass's current state can actually do: a revoked pass offers
   * restoring rather than copying (its link is dead), and an expired one offers
   * a new length, since clearing a revocation would leave the date in the past.
   */
  const menuItems = (p: GuestPass): MenuItem[] => {
    const items: MenuItem[] = [];
    if (p.state === "archived") {
      items.push({ label: t("เอาออกจากที่เก็บถาวร"), icon: "↩", run: () => void patch(p, { archived: false }, t("กู้คืนบัตรของ {name} แล้ว", { name: p.name })) });
      return items;
    }
    if (p.state === "active") {
      items.push({ label: t("คัดลอกลิงก์เชิญ"), icon: "⧉", run: () => void copyLink(p) });
    }
    if (p.state === "revoked") {
      items.push({ label: t("คืนสิทธิ์เข้าใช้งาน"), icon: "↩", run: () => void patch(p, { revoked: false }, t("คืนสิทธิ์ {name} แล้ว", { name: p.name })) });
    }
    if (p.state === "expired" || p.state === "revoked") {
      for (const days of [7, 30]) {
        items.push({
          label: t("ต่ออายุ {n} วัน", { n: days }), icon: "⟳",
          run: () => void patch(p, { days, revoked: false }, t("ต่ออายุบัตรของ {name} อีก {n} วัน", { name: p.name, n: days })),
        });
      }
    }
    if (p.state === "active") {
      items.push({
        label: t("เพิกถอนบัตร"), icon: "⊘", danger: true,
        run: () => {
          if (!confirm(t("เพิกถอนบัตรของ {name}? ลิงก์เดิมจะใช้เข้าไม่ได้ทันที", { name: p.name }))) return;
          void patch(p, { revoked: true }, t("เพิกถอนบัตรของ {name} แล้ว", { name: p.name }));
        },
      });
    }
    items.push({
      label: t("เก็บถาวร"), icon: "🗄", danger: p.state === "active",
      run: () => void patch(p, { archived: true }, t("เก็บถาวรบัตรของ {name} แล้ว", { name: p.name })),
    });
    return items;
  };

  const flipIfClipped = (menu: HTMLElement, anchor: HTMLElement) => {
    let limit = window.innerHeight;
    for (let el = anchor.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") { limit = el.getBoundingClientRect().bottom; break; }
    }
    if (menu.getBoundingClientRect().bottom > limit) menu.classList.add("up");
  };

  const buildMenu = (items: MenuItem[]) => {
    const menu = document.createElement("div");
    menu.className = "mp-menu";
    menu.onclick = (e) => e.stopPropagation();
    items.forEach((it, i) => {
      if (it.danger && i > 0 && !items[i - 1].danger) menu.appendChild(document.createElement("hr"));
      const b = document.createElement("button");
      if (it.danger) b.className = "danger";
      b.textContent = `${it.icon}  ${it.label}`;
      b.onclick = () => { closeMenus(); it.run(); };
      menu.appendChild(b);
    });
    return menu;
  };

  const render = () => {
    list.innerHTML = "";
    if (denied) return;
    const q = search.value.trim().toLowerCase();
    const shown = passes.filter((p) =>
      (state === "all" ? p.state !== "archived" : p.state === state)
      && (!q || p.name.toLowerCase().includes(q)));

    const by = {
      name: (p: GuestPass) => p.name.toLowerCase(),
      // never used sorts oldest, the same way the member table treats it
      seen: (p: GuestPass) => (p.lastSeenAt ? new Date(p.lastSeenAt).getTime() : 0),
    };
    shown.sort((a, b) => {
      const [x, y] = [by[sortKey](a), by[sortKey](b)];
      const c = typeof x === "string" ? String(x).localeCompare(String(y), "th") : Number(x) - Number(y);
      return sortAsc ? c : -c;
    });

    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = passes.length ? t("ไม่พบผู้เยี่ยมชม") : t("ยังไม่มีผู้เยี่ยมชม — กดปุ่มขวาบนเพื่อสร้างลิงก์เชิญ");
      list.appendChild(empty);
      return;
    }

    for (const p of shown) {
      const row = document.createElement("div");
      row.className = "mp-row";

      const ava = document.createElement("span");
      ava.className = "mp-ava gp-ava";
      ava.textContent = initial(p.name);

      const info = document.createElement("span");
      info.className = "mp-info";
      const name = document.createElement("b");
      name.textContent = p.name;
      const sub = document.createElement("small");
      sub.textContent = p.visits
        ? t("{until} · เข้ามาแล้ว {n} ครั้ง", { until: untilLabel(p), n: p.visits })
        : t("{until} · ยังไม่เคยเข้า", { until: untilLabel(p) });
      info.append(name, sub);

      const chip = document.createElement("i");
      chip.className = `mp-role gp-${p.state}`;
      chip.textContent = t(STATE_LABEL[p.state]);

      const seen = document.createElement("i");
      seen.className = "mp-seen";
      seen.textContent = sinceLabel(p.lastSeenAt);
      if (p.createdAt) seen.title = t("สร้างเมื่อ {date}", { date: new Date(p.createdAt).toLocaleDateString(locale()) });

      row.append(ava, info, chip, seen);

      const items = menuItems(p);
      const wrap = document.createElement("span");
      wrap.className = "mp-kebab";
      const btn = document.createElement("button");
      btn.textContent = "⋮";
      btn.title = t("ตัวเลือก");
      btn.onclick = (e) => {
        e.stopPropagation();
        const open = wrap.querySelector(".mp-menu");
        closeMenus();
        if (open) return;
        const menu = buildMenu(items);
        wrap.appendChild(menu);
        flipIfClipped(menu, wrap);
      };
      wrap.appendChild(btn);
      row.appendChild(wrap);
      list.appendChild(row);
    }
  };

  const reload = async () => {
    if (!authToken()) {
      denied = true;
      passes = [];
      tools.style.display = "none";
      list.innerHTML = "";
      say(t("เข้าสู่ระบบเพื่อจัดการผู้เยี่ยมชม"), "err");
      return;
    }
    try {
      const r = await fetch(`${API}/workspaces/${encodeURIComponent(o.slug)}/guests`, { headers: authHeaders() });
      const d = await r.json().catch(() => ({} as any));
      if (!r.ok) {
        denied = true;
        passes = [];
        tools.style.display = "none";
        form.hidden = true;
        list.innerHTML = "";
        return say(d.error === "forbidden" ? t("ต้องเป็นเจ้าของหรือผู้ดูแลจึงจะจัดการผู้เยี่ยมชมได้")
          : d.error === "not found" ? t("ไม่พบ Space นี้")
          : d.error || t("โหลดรายชื่อผู้เยี่ยมชมไม่ได้"), "err");
      }
      denied = false;
      tools.style.display = "";
      passes = d.guests ?? [];
      o.onCount?.(passes.filter((p) => p.state === "active").length);
      render();
    } catch { say(t("เชื่อมต่อ API ไม่ได้"), "err"); }
  };

  search.oninput = render;
  void reload();

  return { reload };
}
