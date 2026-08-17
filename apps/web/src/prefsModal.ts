// The settings dialog reached from the gear in the room's left rail: a left nav
// with one pane visible at a time, in the shape of Gather's Preferences window.
//
// "จัดการสมาชิก" mounts the shared memberPanel in its table variant; "ทั่วไป"
// edits the space itself. Both are gated on the role the server reports, so a
// member never sees controls their write would be refused.
import { API, authHeaders, authToken } from "./api";
import { mountMemberPanel, type MemberPanel } from "./memberPanel";
import { mountGuestPanel, type GuestPanel } from "./guestPanel";
import { inviteLink, themeOverride } from "./workspace";
import { colorMode, setColorMode, lang, setLang, type ColorMode } from "./appearance";
import { THEMES } from "./scenes/mapThemes";
import { ART_CREDITS } from "./artCredits";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

const TITLES: Record<string, string> = {
  members: "จัดการสมาชิก", guests: "จัดการแขก", general: "ทั่วไป", credits: "เครดิตงานศิลป์",
};
const PANES = Object.keys(TITLES);

export interface PrefsModal { open(pane?: string): void; close(): void; }

/**
 * @param slug     the workspace this room belongs to
 * @param isPublic the shared space has no workspace record, so there is nothing
 *                 to manage — the panes say so rather than showing an error
 */
export function setupPrefsModal(slug: string, isPublic: boolean): PrefsModal {
  const modal = $("prefs-modal");
  if (!modal) return { open() {}, close() {} };

  let panel: MemberPanel | null = null;
  let guests: GuestPanel | null = null;
  let myRole = "member";
  let inviteCode = "";
  let allowGuests = true;
  let creditsDrawn = false;

  const say = (text: string, kind: "ok" | "err" = "ok") => {
    const el = $("pf-gen-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", kind === "err");
  };

  const showPane = (pane: string) => {
    for (const p of PANES) {
      const el = $(`pane-${p}`);
      if (el) el.hidden = p !== pane;
    }
    modal.querySelectorAll<HTMLElement>(".pf-item").forEach((b) =>
      b.classList.toggle("active", b.dataset.pane === pane));
    $("pf-title")!.textContent = TITLES[pane] ?? "ตั้งค่า";
    if (pane === "members") mountMembers();
    if (pane === "guests") mountGuests();
    if (pane === "general") void loadGeneral();
    if (pane === "credits") drawCredits();
  };

  /**
   * Attribution required by the licences on the third-party art (OGA-BY, CC-BY,
   * CC-BY-SA, GPL). Built from artCredits.ts, which is generated from the
   * upstream sheet definitions rather than typed by hand.
   */
  const drawCredits = () => {
    const host = $("pf-credits");
    if (!host || creditsDrawn) return;
    creditsDrawn = true;
    for (const g of ART_CREDITS) {
      const card = document.createElement("div");
      card.className = "cr-card";
      const h = document.createElement("h3");
      h.textContent = g.title;
      const what = document.createElement("p");
      what.textContent = g.what;
      card.append(h, what);

      const row = (label: string, fill: (s: HTMLElement) => void) => {
        const r = document.createElement("div");
        r.className = "cr-row";
        const b = document.createElement("b");
        b.textContent = label;
        const s = document.createElement("span");
        fill(s);
        r.append(b, s);
        card.appendChild(r);
      };

      row(g.authors.length > 1 ? "ศิลปิน" : "ศิลปิน", (s) => { s.textContent = g.authors.join(", "); });
      row("สัญญาอนุญาต", (s) => {
        for (const l of g.licenses) {
          const chip = document.createElement("i");
          chip.className = "cr-lic";
          chip.textContent = l;
          s.appendChild(chip);
        }
      });
      if (g.urls.length || g.fullList) {
        row("แหล่งที่มา", (s) => {
          for (const u of g.urls) {
            const a = document.createElement("a");
            a.href = u.href; a.target = "_blank"; a.rel = "noopener noreferrer";
            a.textContent = u.label;
            s.appendChild(a);
          }
          if (g.fullList) {
            const a = document.createElement("a");
            a.href = g.fullList; a.target = "_blank"; a.rel = "noopener noreferrer";
            a.textContent = "รายการครบทุกชิ้น";
            s.appendChild(a);
          }
        });
      }
      host.appendChild(card);
    }
  };

  /** copy the room link; the invite code itself is only handed to members */
  const invite = async () => {
    const link = inviteLink();
    try {
      await navigator.clipboard.writeText(link);
      panelSay("คัดลอกลิงก์เชิญแล้ว — ส่งให้เพื่อนร่วมงานได้เลย");
    } catch { panelSay(link); }
  };

  const panelSay = (text: string) => {
    const el = $("pf-members")?.querySelector<HTMLElement>(".mp-msg");
    if (el) { el.textContent = text; el.classList.remove("err"); }
  };

  const mountMembers = () => {
    const host = $("pf-members");
    if (!host) return;
    if (isPublic) {
      host.className = "";
      host.innerHTML = "";
      const note = document.createElement("p");
      note.className = "pf-note";
      note.textContent = "พื้นที่สาธารณะนี้เข้าได้ทุกคน ไม่มีการกำหนดสิทธิ์ — สร้าง Space ของทีมเพื่อจัดการสมาชิก";
      host.appendChild(note);
      return;
    }
    if (panel) return void panel.reload(); // reopened: pick up changes from elsewhere
    panel = mountMemberPanel({
      host,
      slug,
      table: true,
      onInvite: () => void invite(),
      onCount: (n) => { const c = $("pf-count"); if (c) c.textContent = String(n); },
      onMyRole: (role) => { myRole = role; applyRole(); },
      onSelfRemoved: () => { location.href = location.pathname; },
    });
  };

  /**
   * Guest passes are the space's front door, so only owners and admins get the
   * pane. The public space has no workspace record to hang passes on at all.
   */
  const mountGuests = () => {
    const host = $("pf-guests-panel");
    if (!host) return;
    if (isPublic) {
      host.className = "";
      host.innerHTML = "";
      const note = document.createElement("p");
      note.className = "pf-note";
      note.textContent = "พื้นที่สาธารณะนี้เข้าได้ทุกคนอยู่แล้ว จึงไม่มีบัตรผู้เยี่ยมชม — สร้าง Space ของทีมเพื่อคุมทางเข้า";
      host.appendChild(note);
      return;
    }
    if (guests) return void guests.reload();
    guests = mountGuestPanel({ host, slug, openDoor: () => allowGuests });
  };

  /** hide what this role may not do instead of letting the server refuse later */
  const applyRole = () => {
    const manager = myRole === "owner" || myRole === "admin";
    // the pane itself refuses below admin; hiding the entry saves the dead end
    const navGuests = $("pf-nav-guests");
    if (navGuests) navGuests.style.display = manager && !isPublic ? "" : "none";
    for (const id of ["pf-name", "pf-guests"]) {
      const el = $<HTMLInputElement>(id);
      if (el) el.disabled = !manager;
    }
    $("pf-save")!.style.display = manager ? "" : "none";
    $("pf-reset")!.style.display = manager ? "" : "none";
    // a guest must not be able to pull more people in
    const hideInvite = myRole === "guest" || !inviteCode;
    $("pf-invite-row")!.style.display = hideInvite ? "none" : "flex";
    $("pf-gen-note")!.textContent = manager
      ? ""
      : "ต้องเป็นเจ้าของหรือผู้ดูแลจึงจะแก้ไขการตั้งค่าของ Space ได้";
  };

  /**
   * Language and colour mode belong to the person, not the space, so they are
   * wired once and stay live even where the workspace fields are refused — in
   * the public space, or for a member who may not rename anything.
   */
  const wirePersonal = () => {
    const color = $<HTMLSelectElement>("pf-color");
    if (color) {
      color.value = colorMode();
      color.onchange = () => setColorMode(color.value as ColorMode);
    }
    const language = $<HTMLSelectElement>("pf-lang");
    if (language) {
      language.value = lang();
      language.onchange = () => {
        // English is offered but disabled until the strings exist; a stray value
        // must not leave the app pointing at a language it cannot render
        if (language.value !== "th") return void (language.value = lang());
        setLang("th");
      };
    }
  };

  const loadGeneral = async () => {
    say("");
    wirePersonal();
    if (isPublic) {
      $("pf-gen-note")!.textContent = "พื้นที่สาธารณะนี้ไม่มีการตั้งค่าให้แก้ไข";
      for (const id of ["pf-name", "pf-guests"]) $<HTMLInputElement>(id)!.disabled = true;
      $("pf-save")!.style.display = "none";
      $("pf-invite-row")!.style.display = "none";
      return;
    }
    try {
      const r = await fetch(`${API}/workspaces/${encodeURIComponent(slug)}`, { headers: authHeaders() });
      const d = await r.json().catch(() => ({} as any));
      const w = d.workspace ?? {};
      myRole = w.role ?? myRole;
      inviteCode = w.inviteCode ?? "";
      allowGuests = !!w.allowGuests;
      const theme = w.theme ?? "classic";
      $<HTMLInputElement>("pf-name")!.value = w.name ?? slug;
      $<HTMLInputElement>("pf-guests")!.checked = !!w.allowGuests;
      $("pf-theme-name")!.textContent = THEMES[theme]?.label ?? theme;
      $<HTMLInputElement>("pf-invite")!.value = inviteCode ? inviteLink() : "—";
      applyRole();
      if (themeOverride()) say(`กำลังดูตัวอย่างธีม "${themeOverride()}" จาก URL — ไม่ใช่ธีมที่ Space นี้ใช้จริง`);
    } catch { say("โหลดการตั้งค่าไม่ได้", "err"); }
  };

  // ---- wiring ----
  modal.querySelectorAll<HTMLElement>(".pf-item").forEach((b) =>
    (b.onclick = () => showPane(b.dataset.pane || "members")));

  const close = () => { modal.style.display = "none"; };
  $("pf-close")!.onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display === "grid") close();
  });

  $("pf-copy")!.onclick = async () => {
    const btn = $("pf-copy")!;
    try { await navigator.clipboard.writeText($<HTMLInputElement>("pf-invite")!.value); btn.textContent = "คัดลอกแล้ว"; }
    catch { /* leave the link visible to copy by hand */ }
    setTimeout(() => (btn.textContent = "คัดลอก"), 1500);
  };

  $("pf-reset")!.onclick = async () => {
    if (!confirm("สร้างรหัสเชิญใหม่? ลิงก์เดิมที่แจกไปแล้วจะใช้ไม่ได้")) return;
    const r = await fetch(`${API}/workspaces/${encodeURIComponent(slug)}/invite/reset`,
      { method: "POST", headers: authHeaders() });
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok) return say(d.error === "forbidden" ? "คุณไม่มีสิทธิ์รีเซ็ตลิงก์เชิญ" : (d.error || "รีเซ็ตไม่สำเร็จ"), "err");
    inviteCode = d.inviteCode ?? inviteCode;
    say("สร้างรหัสเชิญใหม่แล้ว");
  };

  // the theme is deliberately not editable here — it is chosen once, when the
  // space is created, because changing it invalidates everyone's claimed desk
  $("pf-save")!.onclick = async () => {
    say("");
    const r = await fetch(`${API}/workspaces/${encodeURIComponent(slug)}`, {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({
        name: $<HTMLInputElement>("pf-name")!.value.trim(),
        allowGuests: $<HTMLInputElement>("pf-guests")!.checked,
      }),
    });
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok) return say(d.error === "forbidden" ? "คุณไม่มีสิทธิ์แก้ไข Space นี้"
      : (d.error || "บันทึกไม่สำเร็จ"), "err");
    say("บันทึกแล้ว");
    allowGuests = $<HTMLInputElement>("pf-guests")!.checked;
    // the sidebar header and the cached name should follow the rename
    const name = d.workspace?.name ?? $<HTMLInputElement>("pf-name")!.value.trim();
    const title = document.getElementById("sb-title");
    if (title && name) title.textContent = name;
    document.dispatchEvent(new CustomEvent("nexspace:ws-renamed", { detail: { name } }));
  };

  return {
    open(pane = "members") {
      modal.style.display = "grid";
      if (!authToken() && !isPublic) say("");
      showPane(pane);
    },
    close,
  };
}
