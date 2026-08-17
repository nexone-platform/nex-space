// Per-member permissions. Mounted twice: in the dashboard's workspace settings
// dialog, and in the settings panel of the in-room sidebar.
//
// The server is the authority on who may act on whom — every row arrives with
// canManage/canPromote and this only draws the entries those allow. Nothing here
// is offered that a write would refuse.
import { API, authHeaders, authToken } from "./api";
import { t, locale } from "./i18n";

export interface PanelMember {
  id: string; name: string; email: string; photoUrl?: string; role: string; isMe: boolean;
  joinedAt?: string; lastSeenAt?: string | null;
  canManage?: boolean;
  canPromote?: boolean;
}

export const roleLabel = (r: string) =>
  t(r === "owner" ? "เจ้าของ" : r === "admin" ? "ผู้ดูแล" : r === "guest" ? "ผู้เยี่ยมชม" : "สมาชิก");

const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

/** coarse on purpose — "5 นาทีที่แล้ว" reads better than a timestamp */
export const sinceLabel = (iso?: string | null) => {
  if (!iso) return t("ยังไม่เคยเข้า");
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 6) return t("กำลังใช้งาน");
  if (mins < 60) return t("{n} นาทีที่แล้ว", { n: mins });
  if (mins < 1440) return t("{n} ชม.ที่แล้ว", { n: Math.floor(mins / 60) });
  const days = Math.floor(mins / 1440);
  return days < 30 ? t("{n} วันที่แล้ว", { n: days }) : new Date(iso).toLocaleDateString(locale());
};

export interface MemberPanelOptions {
  /** the panel builds its own markup inside this element */
  host: HTMLElement;
  slug: string;
  /** stacked rows for a narrow container such as the 250px sidebar */
  compact?: boolean;
  /** sortable Name / Role / Last active column headings above the rows */
  table?: boolean;
  /** shown as a person-plus button beside the search box */
  onInvite?(): void;
  onCount?(n: number): void;
  /** fires whenever the roster confirms this user's own role */
  onMyRole?(role: string): void;
  /** they removed themselves — the host decides where to send them */
  onSelfRemoved?(): void;
}

export interface MemberPanel { reload(): Promise<void>; }

// one open menu at a time, across every mounted panel
const closeMenus = () => document.querySelectorAll(".mp-menu").forEach((el) => el.remove());
document.addEventListener("click", closeMenus);

export function mountMemberPanel(o: MemberPanelOptions): MemberPanel {
  o.host.innerHTML = "";
  o.host.className = `mp${o.compact ? " mp-compact" : ""}${o.table ? " mp-table" : ""}`;

  type SortKey = "name" | "role" | "seen";
  let sortKey: SortKey = "name";
  let sortAsc = true;

  /** clickable Name / Role / Last active headings (table variant only) */
  function buildHead() {
    const head = document.createElement("div");
    head.className = "mp-head";
    // a real spacer, not padding: the heading columns must be the same flex
    // children as the row's, or the two shrink differently and stop lining up
    const avaCol = document.createElement("span");
    avaCol.className = "mp-h-ava";
    head.appendChild(avaCol);
    const col = (key: SortKey, label: string, cls: string) => {
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
        head.replaceWith(buildHead());
        render();
      };
      wrap.appendChild(b);
      return wrap;
    };
    head.append(col("name", t("ชื่อ"), "mp-h-name"), col("role", t("สิทธิ์"), "mp-h-role"),
                col("seen", t("ใช้งานล่าสุด"), "mp-h-seen"));
    const gap = document.createElement("span");
    gap.className = "mp-h-gap";
    head.appendChild(gap);
    return head;
  }

  const tools = document.createElement("div");
  tools.className = "mp-tools";
  const filter = document.createElement("select");
  for (const [v, label] of [["", t("ทุกสิทธิ์")], ["owner", t("เจ้าของ")], ["admin", t("ผู้ดูแล")],
                            ["member", t("สมาชิก")], ["guest", t("ผู้เยี่ยมชม")]]) {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = label;
    filter.appendChild(opt);
  }
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = t("ค้นหาชื่อหรืออีเมล…");
  search.autocomplete = "off";
  // filter first in table mode, matching the "View All … Search  ＋" header row
  tools.append(...(o.table ? [filter, search] : [search, filter]));
  if (o.onInvite) {
    const add = document.createElement("button");
    add.className = "mp-invite";
    add.title = t("เชิญคนเข้า workspace");
    add.textContent = "＋";
    add.onclick = () => o.onInvite!();
    tools.appendChild(add);
  }

  const msg = document.createElement("div");
  msg.className = "mp-msg";
  const list = document.createElement("div");
  list.className = "mp-list";
  o.host.append(tools, msg);
  if (o.table) o.host.appendChild(buildHead());
  o.host.appendChild(list);

  let members: PanelMember[] = [];
  let myRole = "member";

  const say = (text: string, kind: "ok" | "err" = "ok") => {
    msg.textContent = text;
    msg.classList.toggle("err", kind === "err");
  };

  const write = async (method: "PATCH" | "DELETE", id: string, body?: unknown) => {
    const r = await fetch(`${API}/workspaces/${encodeURIComponent(o.slug)}/members/${id}`, {
      method, headers: authHeaders(), body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({} as any));
    if (r.ok) return d;
    throw new Error(
      d.error === "forbidden" ? t("คุณไม่มีสิทธิ์ทำรายการนี้")
      : d.error === "cannot change the owner" ? t("เปลี่ยนสิทธิ์เจ้าของไม่ได้")
      : d.error === "cannot change your own role" ? t("เปลี่ยนสิทธิ์ของตัวเองไม่ได้")
      : d.error === "the owner cannot be removed" ? t("นำเจ้าของออกไม่ได้")
      : d.error === "not a member" ? t("คนนี้ไม่ได้อยู่ใน workspace แล้ว")
      : d.error || t("ทำรายการไม่สำเร็จ"));
  };

  const setRole = async (m: PanelMember, role: string) => {
    try {
      await write("PATCH", m.id, { role });
      say(t("{name} เป็น{role}แล้ว", { name: m.name, role: roleLabel(role) }));
      await reload();
    } catch (e) { say((e as Error).message, "err"); }
  };

  const remove = async (m: PanelMember) => {
    if (!confirm(m.isMe ? t("ออกจาก workspace นี้?") : t("นำ {name} ออกจาก workspace?", { name: m.name }))) return;
    try {
      await write("DELETE", m.id);
      if (m.isMe) return o.onSelfRemoved?.();
      say(t("นำ {name} ออกแล้ว", { name: m.name }));
      await reload();
    } catch (e) { say((e as Error).message, "err"); }
  };

  type MenuItem = { label: string; icon: string; run(): void; danger?: boolean };

  /**
   * One entry per destination role, so an admin row cannot show both
   * "ตั้งเป็นสมาชิก" and "ถอดสิทธิ์ผู้ดูแล" for the very same change. The owner
   * gets no leave entry either — a workspace cannot be left ownerless.
   */
  const menuItems = (m: PanelMember): MenuItem[] => {
    const items: MenuItem[] = [];
    const rank: Record<string, number> = { admin: 2, member: 1, guest: 0 };
    const to = (role: string, label: string, allowed?: boolean) => {
      if (!allowed || m.role === role) return;
      items.push({ label, icon: rank[role] > (rank[m.role] ?? 1) ? "↑" : "↓", run: () => void setRole(m, role) });
    };

    to("admin", t("ตั้งเป็นผู้ดูแล"), m.canPromote);
    to("member", m.role === "admin" ? t("ถอดสิทธิ์ผู้ดูแล") : t("ตั้งเป็นสมาชิก"), m.canManage);
    to("guest", t("ลดเป็นผู้เยี่ยมชม"), m.canManage);

    if (m.role !== "owner" && (m.canManage || m.isMe)) {
      items.push({
        label: m.isMe ? t("ออกจาก Workspace") : t("นำออกจาก Workspace"),
        icon: "⊘", danger: true, run: () => void remove(m),
      });
    }
    return items;
  };

  /**
   * Open upward when there is no room below. The sidebar's settings view is a
   * scroll container, so a menu hanging past its bottom edge is clipped away
   * rather than merely hidden — the lower rows would have had no usable menu.
   */
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
      if (it.danger && i > 0) menu.appendChild(document.createElement("hr"));
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
    const q = search.value.trim().toLowerCase();
    const only = filter.value;
    const shown = members.filter((m) =>
      (!only || m.role === only)
      && (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)));

    if (o.table) {
      const rank: Record<string, number> = { owner: 3, admin: 2, member: 1, guest: 0 };
      const by: Record<SortKey, (m: PanelMember) => number | string> = {
        name: (m) => m.name.toLowerCase(),
        role: (m) => rank[m.role] ?? -1,
        // never seen sorts oldest rather than newest
        seen: (m) => (m.lastSeenAt ? new Date(m.lastSeenAt).getTime() : 0),
      };
      shown.sort((a, b) => {
        const [x, y] = [by[sortKey](a), by[sortKey](b)];
        const c = typeof x === "string" ? String(x).localeCompare(String(y), "th") : Number(x) - Number(y);
        return sortAsc ? c : -c;
      });
    }

    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = members.length ? t("ไม่พบสมาชิกที่ตรงกับการค้นหา") : t("ยังไม่มีสมาชิก");
      list.appendChild(empty);
      return;
    }

    for (const m of shown) {
      const row = document.createElement("div");
      row.className = "mp-row";

      const ava = document.createElement("span");
      ava.className = "mp-ava";
      if (m.photoUrl) {
        const img = document.createElement("img");
        img.src = m.photoUrl; img.alt = "";
        ava.appendChild(img);
      } else ava.textContent = initial(m.name);

      const info = document.createElement("span");
      info.className = "mp-info";
      const name = document.createElement("b");
      name.textContent = m.name + (m.isMe ? " " + t("(คุณ)") : "");
      const mail = document.createElement("small");
      mail.textContent = m.email;
      info.append(name, mail);

      // sibling of the name block, not a child: wide containers keep it on the
      // same line, compact ones wrap it onto its own
      const meta = document.createElement("span");
      meta.className = "mp-meta";
      const chip = document.createElement("i");
      chip.className = `mp-role ${m.role}`;
      chip.textContent = roleLabel(m.role);
      const seen = document.createElement("i");
      seen.className = "mp-seen";
      seen.textContent = sinceLabel(m.lastSeenAt);
      if (m.joinedAt) seen.title = t("เข้าร่วมเมื่อ {date}", { date: new Date(m.joinedAt).toLocaleDateString(locale()) });
      // table mode keeps chip and seen as direct row children so they are the
      // very same flex columns the headings are; the list variant groups them
      if (o.table) {
        meta.remove();
        row.append(ava, info, chip, seen);
      } else {
        meta.append(chip, seen);
        row.append(ava, info, meta);
      }

      const items = menuItems(m);
      if (items.length) {
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
      } else if (o.table) {
        // hold the column open, or rows without a menu shift out of alignment
        const spacer = document.createElement("span");
        spacer.className = "mp-kebab";
        row.appendChild(spacer);
      }
      list.appendChild(row);
    }
  };

  const reload = async () => {
    if (!authToken()) {
      members = [];
      list.innerHTML = "";
      const note = document.createElement("div");
      note.className = "mp-empty";
      note.textContent = t("เข้าสู่ระบบเพื่อดูและจัดการสมาชิก");
      list.appendChild(note);
      tools.style.display = "none";
      o.onCount?.(0);
      return;
    }
    tools.style.display = "";
    try {
      const r = await fetch(`${API}/workspaces/${encodeURIComponent(o.slug)}/members`, { headers: authHeaders() });
      const d = await r.json().catch(() => ({} as any));
      if (!r.ok) {
        members = [];
        render();
        return say(d.error === "forbidden" ? t("คุณไม่ได้เป็นสมาชิกของ workspace นี้")
          : d.error === "not found" ? t("ไม่พบ workspace นี้")
          : d.error || t("โหลดสมาชิกไม่ได้"), "err");
      }
      members = d.members ?? [];
      myRole = d.myRole ?? "member";
      o.onMyRole?.(myRole);
      o.onCount?.(members.length);
      render();
    } catch { say(t("เชื่อมต่อ API ไม่ได้"), "err"); }
  };

  search.oninput = render;
  filter.onchange = render;
  void reload();

  return { reload };
}
