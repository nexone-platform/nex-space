// Login / register + character-select overlay. Talks to the API (apps/api),
// persists the JWT in localStorage, and hands {name, avatar} to the game.
import { openAvatarEditor } from "./avatar/avatarEditor";
import { encodeAvatar, buildFrameCanvas, defaultDressedConfig, type LpcConfig } from "./avatar/avatarCompose";

// In production the app is served by nginx, which reverse-proxies the API on the
// same origin (/auth, /me). Use same-origin relative URLs there so it works over
// any host/port/protocol; fall back to the local API port only in dev.
const API = ((import.meta as any).env?.VITE_API_URL as string)
  || ((import.meta as any).env?.DEV ? "http://localhost:3001" : "");

export interface StartInfo { name: string; avatar: string; desk: string; }
interface User { name: string; email: string; avatar: { avatarId?: string; lpc?: LpcConfig } | null; desk?: string | null; }

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
    if ($("auth-step")) $("auth-step")!.style.display = "none";
    if ($("char-step")) $("char-step")!.style.display = "block";
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
      user = data.user; toChar(user);
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
    // member desk comes from their account; guest desk from this device
    const desk = user?.desk || localStorage.getItem("nexspace-desk") || "";
    onReady({ name, avatar: selected, desk });
  };

  // auto-resume a saved session
  (async () => {
    const token = localStorage.getItem("nexspace-token");
    if (!token) return;
    try {
      const r = await fetch(API + "/me", { headers: { Authorization: "Bearer " + token } });
      if (r.ok) { user = (await r.json()).user; toChar(user); }
      else localStorage.removeItem("nexspace-token");
    } catch { /* offline -> stay on login */ }
  })();

  setMode("login");
}
