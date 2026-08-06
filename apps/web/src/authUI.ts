// Login / register + character-select overlay. Talks to the API (apps/api),
// persists the JWT in localStorage, and hands {name, avatar} to the game.
import { openAvatarEditor } from "./avatar/avatarEditor";
import { encodeAvatar, buildFrameCanvas, defaultDressedConfig, type LpcConfig } from "./avatar/avatarCompose";
import { WORKSPACE, HAS_WORKSPACE_PARAM, gotoWorkspace, wsKey } from "./workspace";

// In production the app is served by nginx, which reverse-proxies the API on the
// same origin (/auth, /me). Use same-origin relative URLs there so it works over
// any host/port/protocol; fall back to the local API port only in dev.
const API = ((import.meta as any).env?.VITE_API_URL as string)
  || ((import.meta as any).env?.DEV ? "http://localhost:3001" : "");

export interface StartInfo { name: string; avatar: string; desk: string; }
interface User {
  name: string; email: string;
  avatar: { avatarId?: string; lpc?: LpcConfig } | null;
  desks?: Record<string, string> | null; // workspace -> deskId
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

export function runAuthFlow(onReady: (s: StartInfo) => void) {
  const overlay = $("auth-overlay");
  const err = $("auth-err");
  const nameInput = $<HTMLInputElement>("a-name");
  const emailInput = $<HTMLInputElement>("a-email");
  const passInput = $<HTMLInputElement>("a-pass");
  const submitBtn = $("a-submit");
  const passToggle = $("a-pass-toggle");
  const cName = $<HTMLInputElement>("c-name");

  // show/hide password toggle (eye icon)
  const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  if (passToggle && passInput) {
    passToggle.innerHTML = EYE;
    passToggle.onclick = () => {
      const show = passInput.type === "password";
      passInput.type = show ? "text" : "password";
      passToggle.innerHTML = show ? EYE_OFF : EYE;
      passToggle.title = show ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน";
      passInput.focus();
    };
  }
  let mode: "login" | "register" = "login";
  let user: User | null = null;
  let selected = "1";          // avatar value handed to the game ("1".."7" or "lpc:{...}")
  let selectedTile = "1";      // which grid tile is highlighted ("1".."7" or "custom")
  let customConfig: LpcConfig | null = null;

  const setErr = (m: string) => { if (err) err.textContent = m; };
  const setWsErr = (m: string) => { const e = $("ws-err"); if (e) e.textContent = m; };
  const authHeaders = () => {
    const t = localStorage.getItem("nexspace-token");
    return { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) };
  };

  // tell people opening an invite link which workspace they're joining
  if (HAS_WORKSPACE_PARAM) {
    fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const sub = document.querySelector<HTMLElement>("#auth-step .sub");
        if (sub && d?.workspace?.name) sub.textContent = `เข้าสู่ workspace: ${d.workspace.name}`;
        if (d?.workspace?.name) localStorage.setItem(wsKey("nexspace-ws-name"), d.workspace.name);
      })
      .catch(() => {});
  }

  // ---- workspace picker -------------------------------------------------
  const showStep = (id: "auth-step" | "ws-step" | "char-step") => {
    for (const s of ["auth-step", "ws-step", "char-step"]) {
      const el = $(s);
      if (el) el.style.display = s === id ? "block" : "none";
    }
  };

  const renderWorkspaces = (list: { slug: string; name: string; role: string; members?: number }[]) => {
    const box = $("ws-list");
    if (!box) return;
    box.innerHTML = "";
    if (!list.length) {
      const p = document.createElement("div");
      p.className = "ws-empty";
      p.textContent = "ยังไม่ได้อยู่ workspace ไหน — สร้างใหม่หรือใช้รหัสเชิญด้านล่าง";
      box.appendChild(p);
      return;
    }
    for (const w of list) {
      const b = document.createElement("button");
      b.className = "ws-item";
      const ico = document.createElement("span");
      ico.className = "ws-ico";
      ico.textContent = (w.name.trim()[0] ?? "?").toUpperCase();
      const meta = document.createElement("span");
      meta.className = "ws-meta";
      const nm = document.createElement("b"); nm.textContent = w.name;
      const sm = document.createElement("small");
      sm.textContent = `${w.role === "owner" ? "เจ้าของ" : w.role === "admin" ? "ผู้ดูแล" : "สมาชิก"}`
        + (w.members ? ` · ${w.members} คน` : "");
      meta.append(nm, sm);
      b.append(ico, meta);
      b.onclick = () => {
        localStorage.setItem(wsKey("nexspace-ws-name"), w.name);
        gotoWorkspace(w.slug);
      };
      box.appendChild(b);
    }
  };

  const toWorkspaces = async () => {
    showStep("ws-step");
    setWsErr("");
    try {
      const r = await fetch(`${API}/workspaces`, { headers: authHeaders() });
      const d = await r.json();
      renderWorkspaces(d.workspaces ?? []);
    } catch { setWsErr("โหลดรายการ workspace ไม่ได้"); }
  };

  $("ws-create")!.onclick = async () => {
    const name = $<HTMLInputElement>("ws-name")?.value.trim() ?? "";
    const allowGuests = $<HTMLInputElement>("ws-guests")?.checked ?? true;
    if (!name) return setWsErr("ใส่ชื่อบริษัท/ทีมก่อน");
    setWsErr("");
    try {
      const r = await fetch(`${API}/workspaces`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ name, allowGuests }),
      });
      const d = await r.json();
      if (!r.ok) return setWsErr(d.error || "สร้างไม่สำเร็จ");
      localStorage.setItem(wsKey("nexspace-ws-name"), d.workspace.name);
      gotoWorkspace(d.workspace.slug);
    } catch { setWsErr("เชื่อมต่อ API ไม่ได้"); }
  };

  $("ws-join")!.onclick = async () => {
    const code = $<HTMLInputElement>("ws-code")?.value.trim() ?? "";
    if (!code) return setWsErr("ใส่รหัสเชิญก่อน");
    setWsErr("");
    try {
      const r = await fetch(`${API}/workspaces/join`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (!r.ok) return setWsErr(d.error === "workspace not found" ? "ไม่พบรหัสเชิญนี้" : (d.error || "เข้าร่วมไม่สำเร็จ"));
      gotoWorkspace(d.workspace.slug);
    } catch { setWsErr("เชื่อมต่อ API ไม่ได้"); }
  };

  const setMode = (m: "login" | "register") => {
    mode = m;
    $("tab-login")?.classList.toggle("active", m === "login");
    $("tab-register")?.classList.toggle("active", m === "register");
    if (nameInput) nameInput.style.display = m === "register" ? "block" : "none";
    if (submitBtn) submitBtn.textContent = m === "register" ? "สมัคร" : "เข้าสู่ระบบ";
    setErr("");
  };

  const highlight = (tile: string) => {
    selectedTile = tile;
    document.querySelectorAll<HTMLElement>(".char-opt").forEach((el) =>
      el.classList.toggle("sel", el.dataset.avatar === tile));
  };
  const selectPreset = (a: string) => { selected = a; highlight(a); };

  const setCustomThumb = (cfg: LpcConfig) => {
    const img = $<HTMLImageElement>("c-custom-img");
    if (img) void buildFrameCanvas(cfg, "down", 2).then((c) => { img.src = c.toDataURL(); });
  };

  const openEditor = async () => {
    const initial = customConfig ?? await defaultDressedConfig();
    const cfg = await openAvatarEditor(initial, cName?.value || user?.name || "avatar");
    if (!cfg) return;
    customConfig = cfg;
    selected = encodeAvatar(cfg);
    setCustomThumb(cfg);
    highlight("custom");
  };

  const toChar = (u: User | null) => {
    if (u?.avatar?.lpc) { customConfig = u.avatar.lpc; selected = encodeAvatar(u.avatar.lpc); setCustomThumb(u.avatar.lpc); }
    else { void defaultDressedConfig().then(setCustomThumb); } // preview a generic avatar on the "create your own" tile
    if (u?.avatar?.avatarId && !u?.avatar?.lpc) selected = u.avatar.avatarId;
    showStep("char-step");
    const hello = $("char-hello"); if (hello) hello.textContent = u ? `สวัสดี ${u.name}` : "โหมด Guest";
    if (cName) cName.value = u?.name ?? "";
    if (u?.avatar?.lpc) highlight("custom"); else selectPreset(selected);
  };

  $("tab-login")!.onclick = () => setMode("login");
  $("tab-register")!.onclick = () => setMode("register");
  document.querySelectorAll<HTMLElement>(".char-opt").forEach((el) => (el.onclick = () => {
    if (el.dataset.avatar === "custom") void openEditor();
    else selectPreset(el.dataset.avatar || "1");
  }));

  submitBtn!.onclick = async () => {
    setErr("");
    const email = emailInput?.value.trim() ?? "";
    const password = passInput?.value ?? "";
    const name = nameInput?.value.trim() ?? "";
    if (!email || !password) return setErr("กรอกอีเมลและรหัสผ่าน");
    try {
      const r = await fetch(API + (mode === "register" ? "/auth/register" : "/auth/login"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, name }),
      });
      const data = await r.json();
      if (!r.ok) return setErr(data.error || "เกิดข้อผิดพลาด");
      localStorage.setItem("nexspace-token", data.token);
      user = data.user;
      // arriving via an invite link goes straight in; otherwise pick a workspace
      if (HAS_WORKSPACE_PARAM) toChar(user); else void toWorkspaces();
    } catch { setErr("เชื่อมต่อ API ไม่ได้ — ลองเข้าแบบ Guest"); }
  };

  $("a-guest")!.onclick = () => { user = null; toChar(null); };

  $("c-enter")!.onclick = () => {
    const name = cName?.value.trim() || user?.name || "Guest";
    const token = localStorage.getItem("nexspace-token");
    if (token) {
      const body = selectedTile === "custom" && customConfig ? { lpc: customConfig } : { avatarId: selected };
      fetch(API + "/me/avatar", {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body),
      }).catch(() => {});
    }
    if (overlay) overlay.style.display = "none";
    // desk is per workspace: members from their account, guests from this device
    const desk = user?.desks?.[WORKSPACE] || localStorage.getItem(wsKey("nexspace-desk")) || "";
    onReady({ name, avatar: selected, desk });
  };

  // auto-resume a saved session
  (async () => {
    const token = localStorage.getItem("nexspace-token");
    if (!token) return;
    try {
      const r = await fetch(API + "/me", { headers: { Authorization: "Bearer " + token } });
      if (r.ok) {
        user = (await r.json()).user;
        if (HAS_WORKSPACE_PARAM) toChar(user); else void toWorkspaces();
      } else localStorage.removeItem("nexspace-token");
    } catch { /* offline -> stay on login */ }
  })();

  setMode("login");
}
