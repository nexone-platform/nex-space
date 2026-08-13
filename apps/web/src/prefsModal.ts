// The settings dialog reached from the gear in the room's left rail: a left nav
// with one pane visible at a time, in the shape of Gather's Preferences window.
//
// "จัดการสมาชิก" mounts the shared memberPanel in its table variant; "ทั่วไป"
// edits the space itself. Both are gated on the role the server reports, so a
// member never sees controls their write would be refused.
import { API, authHeaders, authToken } from "./api";
import { mountMemberPanel, type MemberPanel } from "./memberPanel";
import { inviteLink, rememberTheme, themeOverride } from "./workspace";
import { THEMES } from "./scenes/mapThemes";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

const TITLES: Record<string, string> = { members: "จัดการสมาชิก", general: "ทั่วไป" };

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
  let myRole = "member";
  let inviteCode = "";
  let savedTheme = "classic";

  // one option per layout the client can actually render
  const themeSelect = $<HTMLSelectElement>("pf-theme");
  if (themeSelect && !themeSelect.options.length) {
    for (const [id, t] of Object.entries(THEMES)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = t.label;
      themeSelect.appendChild(opt);
    }
  }

  const say = (text: string, kind: "ok" | "err" = "ok") => {
    const el = $("pf-gen-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", kind === "err");
  };

  const showPane = (pane: string) => {
    for (const p of ["members", "general"]) {
      const el = $(`pane-${p}`);
      if (el) el.hidden = p !== pane;
    }
    modal.querySelectorAll<HTMLElement>(".pf-item").forEach((b) =>
      b.classList.toggle("active", b.dataset.pane === pane));
    $("pf-title")!.textContent = TITLES[pane] ?? "ตั้งค่า";
    if (pane === "members") mountMembers();
    if (pane === "general") void loadGeneral();
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

  /** hide what this role may not do instead of letting the server refuse later */
  const applyRole = () => {
    const manager = myRole === "owner" || myRole === "admin";
    for (const id of ["pf-name", "pf-guests", "pf-theme"]) {
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

  const loadGeneral = async () => {
    say("");
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
      savedTheme = w.theme ?? "classic";
      $<HTMLInputElement>("pf-name")!.value = w.name ?? slug;
      $<HTMLInputElement>("pf-guests")!.checked = !!w.allowGuests;
      if (themeSelect) themeSelect.value = THEMES[savedTheme] ? savedTheme : "classic";
      $<HTMLInputElement>("pf-invite")!.value = inviteCode ? inviteLink() : "—";
      applyRole();
      if (themeOverride()) say(`กำลังดูตัวอย่างธีม "${themeOverride()}" จาก URL — ยังไม่ได้บันทึกให้ทีม`);
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

  $("pf-save")!.onclick = async () => {
    say("");
    const theme = themeSelect?.value || savedTheme;
    const themeChanged = theme !== savedTheme;
    if (themeChanged && !confirm(
      `เปลี่ยนแผนผังเป็น "${THEMES[theme]?.label ?? theme}"?\n\n`
      + "ทุกคนใน Space นี้จะถูกโหลดห้องใหม่ และโต๊ะที่จองไว้ในแผนผังเดิมจะถูกยกเลิก")) return;

    const r = await fetch(`${API}/workspaces/${encodeURIComponent(slug)}`, {
      method: "PATCH", headers: authHeaders(),
      body: JSON.stringify({
        name: $<HTMLInputElement>("pf-name")!.value.trim(),
        allowGuests: $<HTMLInputElement>("pf-guests")!.checked,
        theme,
      }),
    });
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok) return say(d.error === "forbidden" ? "คุณไม่มีสิทธิ์แก้ไข Space นี้"
      : d.error === "unknown theme" ? "ไม่รู้จักธีมนี้"
      : (d.error || "บันทึกไม่สำเร็จ"), "err");
    say("บันทึกแล้ว");

    if (themeChanged) {
      // the map is chosen at boot, so the new layout needs a fresh load. Other
      // people's tabs notice the change from their own workspace fetch.
      savedTheme = theme;
      rememberTheme(slug, theme);
      say("บันทึกแล้ว — กำลังโหลดแผนผังใหม่…");
      setTimeout(() => location.reload(), 700);
      return;
    }
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
