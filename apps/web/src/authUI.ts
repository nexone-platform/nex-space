// Sign-in (Google or a 6-digit email code), the spaces dashboard, workspace
// settings/members, and character select. Persists the session token in
// localStorage and hands {name, avatar, desk} to the game.
import { openAvatarEditor } from "./avatar/avatarEditor";
import { encodeAvatar, buildFrameCanvas, defaultDressedConfig, type LpcConfig } from "./avatar/avatarCompose";
import { WORKSPACE, HAS_WORKSPACE_PARAM, gotoWorkspace, wsKey, wsKeyFor } from "./workspace";

// In production the app is served by nginx, which reverse-proxies the API on the
// same origin (/auth, /me, /workspaces). Use same-origin relative URLs there so it
// works over any host/port/protocol; fall back to the local API port only in dev.
const API = ((import.meta as any).env?.VITE_API_URL as string)
  || ((import.meta as any).env?.DEV ? "http://localhost:3001" : "");

export interface StartInfo { name: string; avatar: string; desk: string; }
interface User {
  name: string; email: string;
  avatar: { avatarId?: string; lpc?: LpcConfig } | null;
  desks?: Record<string, string> | null; // workspace -> deskId
}
interface Space { slug: string; name: string; role: string; members?: number; inviteCode?: string }
interface Member { id: string; name: string; email: string; photoUrl?: string; role: string; isMe: boolean }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const TOKEN_KEY = "nexspace-token";
const token = () => localStorage.getItem(TOKEN_KEY);
const authHeaders = () => ({
  "Content-Type": "application/json",
  ...(token() ? { Authorization: "Bearer " + token()! } : {}),
});
const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();
const roleLabel = (r: string) => (r === "owner" ? "เจ้าของ" : r === "admin" ? "ผู้ดูแล" : "สมาชิก");

export function runAuthFlow(onReady: (s: StartInfo) => void) {
  const overlay = $("auth-overlay");
  const spaces = $("spaces-overlay");
  const emailInput = $<HTMLInputElement>("a-email");
  const cName = $<HTMLInputElement>("c-name");

  let user: User | null = null;
  let selected = "1";          // avatar handed to the game ("1".."7" or "lpc:{...}")
  let selectedTile = "1";
  let customConfig: LpcConfig | null = null;
  let pendingEmail = "";
  let mySpaces: Space[] = [];

  const setErr = (id: string, m: string) => { const e = $(id); if (e) e.textContent = m; };

  const showStep = (id: "auth-step" | "code-step" | "char-step") => {
    for (const s of ["auth-step", "code-step", "char-step"]) {
      const el = $(s);
      if (el) el.style.display = s === id ? "block" : "none";
    }
    if (overlay) overlay.style.display = "grid";
    if (spaces) spaces.style.display = "none";
  };

  // ---------------------------------------------------------------- sign in
  // Google hands the token back in the URL fragment; consume it before anything reads the URL.
  (() => {
    const h = new URLSearchParams(location.hash.slice(1));
    const t = h.get("token");
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      history.replaceState(null, "", location.pathname + location.search);
    } else if (h.get("auth_error")) {
      history.replaceState(null, "", location.pathname + location.search);
      setErr("auth-err", "เข้าสู่ระบบด้วย Google ไม่สำเร็จ");
    }
  })();

  // hide the Google button unless the server has credentials for it
  fetch(`${API}/auth/config`).then((r) => r.json()).then((c) => {
    const g = $("a-google");
    if (g && !c.google) g.style.display = "none";
  }).catch(() => {});

  // show which workspace an invite link leads to
  if (HAS_WORKSPACE_PARAM) {
    fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.workspace?.name) return;
        const sub = document.querySelector<HTMLElement>("#auth-step .sub");
        if (sub) sub.textContent = `เข้าสู่ workspace: ${d.workspace.name}`;
        localStorage.setItem(wsKey("nexspace-ws-name"), d.workspace.name);
      }).catch(() => {});
  }

  $("a-google")!.onclick = () => {
    location.href = `${API}/auth/google${HAS_WORKSPACE_PARAM ? `?w=${encodeURIComponent(WORKSPACE)}` : ""}`;
  };

  /** a thrown TypeError from fetch means the API is unreachable, not a bad request */
  const NET_ERR = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบว่า API ทำงานอยู่";

  const requestCode = async (email: string) => {
    let r: Response;
    try {
      r = await fetch(`${API}/auth/code/request`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
      });
    } catch { throw new Error(NET_ERR); }
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok) {
      throw new Error(
        d.error === "invalid email" ? "อีเมลไม่ถูกต้อง"
        : d.error === "could not send email" ? "ส่งอีเมลไม่สำเร็จ — ตรวจการตั้งค่า SMTP"
        : d.error || "ส่งรหัสไม่สำเร็จ");
    }
    return d as { delivered: boolean };
  };

  $("a-send-code")!.onclick = async () => {
    const email = emailInput?.value.trim() ?? "";
    setErr("auth-err", "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setErr("auth-err", "กรอกอีเมลให้ถูกต้อง");
    try {
      const d = await requestCode(email);
      pendingEmail = email;
      showStep("code-step");
      setErr("code-err", "");
      const sub = $("code-sub");
      if (sub) {
        sub.textContent = d.delivered
          ? `เราส่งรหัส 6 หลักไปที่ ${email} แล้ว หากไม่พบให้ตรวจในกล่องสแปม`
          : `ระบบยังไม่ได้ตั้งค่าอีเมล — ดูรหัสได้ที่ log ของเซิร์ฟเวอร์ (${email})`;
      }
      codeInputs()[0]?.focus();
    } catch (e) { setErr("auth-err", (e as Error).message); }
  };

  const codeInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>("#code-boxes input"));

  const verifyCode = async () => {
    const code = codeInputs().map((i) => i.value).join("");
    if (code.length < 6) return;
    setErr("code-err", "");
    try {
      const r = await fetch(`${API}/auth/code/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingEmail, code }),
      });
      const d = await r.json();
      if (!r.ok) {
        codeInputs().forEach((i) => (i.value = ""));
        codeInputs()[0]?.focus();
        return setErr("code-err",
          d.error === "invalid code" ? "รหัสไม่ถูกต้อง"
          : d.error === "code expired" ? "รหัสหมดอายุแล้ว — ขอรหัสใหม่"
          : d.error === "too many attempts" ? "กรอกผิดหลายครั้งเกินไป — ขอรหัสใหม่"
          : d.error || "ยืนยันรหัสไม่สำเร็จ");
      }
      localStorage.setItem(TOKEN_KEY, d.token);
      user = d.user;
      afterSignIn();
    } catch { setErr("code-err", "เชื่อมต่อ API ไม่ได้"); }
  };

  // 6 single-character boxes that behave like one field
  codeInputs().forEach((box, i, all) => {
    box.oninput = () => {
      box.value = box.value.replace(/\D/g, "").slice(0, 1);
      if (box.value && i < all.length - 1) all[i + 1].focus();
      if (all.every((b) => b.value)) void verifyCode();
    };
    box.onkeydown = (e) => {
      if (e.key === "Backspace" && !box.value && i > 0) all[i - 1].focus();
    };
    box.onpaste = (e) => {
      const text = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "").slice(0, 6);
      if (!text) return;
      e.preventDefault();
      all.forEach((b, k) => (b.value = text[k] ?? ""));
      all[Math.min(text.length, 5)].focus();
      if (text.length === 6) void verifyCode();
    };
  });

  $("code-resend")!.onclick = async () => {
    setErr("code-err", "");
    try { await requestCode(pendingEmail); setErr("code-err", "ส่งรหัสใหม่แล้ว"); }
    catch (e) { setErr("code-err", (e as Error).message); }
  };
  $("code-cancel")!.onclick = () => { codeInputs().forEach((i) => (i.value = "")); showStep("auth-step"); };
  $("a-guest")!.onclick = () => { user = null; toChar(null); };

  /** after a successful sign-in: invite links go straight in, otherwise pick a space */
  const afterSignIn = () => { if (HAS_WORKSPACE_PARAM) toChar(user); else void showSpaces(); };

  // ------------------------------------------------------- spaces dashboard
  const renderSpaces = () => {
    const grid = $("sp-grid");
    if (!grid) return;
    const q = ($<HTMLInputElement>("sp-search")?.value ?? "").toLowerCase();
    const list = mySpaces.filter((s) => !q || s.name.toLowerCase().includes(q));
    grid.innerHTML = "";
    if (!list.length) {
      const p = document.createElement("div");
      p.className = "sp-empty";
      p.textContent = mySpaces.length
        ? "ไม่พบ Space ที่ค้นหา"
        : "ยังไม่มี Space — กด “＋ สร้าง Space” หรือกรอกรหัสเชิญด้านบน";
      grid.appendChild(p);
      return;
    }
    for (const s of list) {
      const card = document.createElement("div");
      card.className = "sp-card";
      const thumb = document.createElement("div");
      thumb.className = "sp-thumb";
      thumb.textContent = initial(s.name);
      thumb.title = "เข้า Space นี้";
      thumb.onclick = () => enterSpace(s);
      const foot = document.createElement("div");
      foot.className = "sp-card-foot";
      const nm = document.createElement("div");
      nm.className = "sp-name";
      const b = document.createElement("b"); b.textContent = s.name;
      const sm = document.createElement("small");
      sm.textContent = roleLabel(s.role) + (s.members ? ` · ${s.members} คน` : "");
      nm.append(b, sm);
      const menu = document.createElement("button");
      menu.className = "sp-menu-btn";
      menu.textContent = "⋮";
      menu.title = "ตั้งค่า / สมาชิก";
      menu.onclick = (e) => { e.stopPropagation(); void openSettings(s); };
      foot.append(nm, menu);
      card.append(thumb, foot);
      grid.appendChild(card);
    }
  };

  const enterSpace = (s: Space) => {
    // cache under the TARGET slug — we're still on the previous workspace's page here
    localStorage.setItem(wsKeyFor(s.slug, "nexspace-ws-name"), s.name);
    gotoWorkspace(s.slug);
  };

  const showSpaces = async () => {
    if (overlay) overlay.style.display = "none";
    if (spaces) spaces.style.display = "flex";
    const who = $("sp-who");
    if (who) who.textContent = user?.email ?? "";
    setErr("sp-err", "");
    try {
      const r = await fetch(`${API}/workspaces`, { headers: authHeaders() });
      const d = await r.json();
      mySpaces = d.workspaces ?? [];
      renderSpaces();
    } catch { setErr("sp-err", "โหลดรายการ Space ไม่ได้"); }
  };

  $("sp-search")!.oninput = renderSpaces;

  $("sp-create")!.onclick = async () => {
    const field = $<HTMLInputElement>("sp-newname");
    const name = field?.value.trim() ?? "";
    if (!name) { setErr("sp-err", "ใส่ชื่อ Space ที่ต้องการสร้างก่อน"); field?.focus(); return; }
    setErr("sp-err", "");
    try {
      const r = await fetch(`${API}/workspaces`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ name, allowGuests: true }),
      });
      const d = await r.json();
      if (!r.ok) return setErr("sp-err", d.error || "สร้างไม่สำเร็จ");
      enterSpace(d.workspace);
    } catch { setErr("sp-err", "เชื่อมต่อ API ไม่ได้"); }
  };

  $("sp-join")!.onclick = async () => {
    const code = $<HTMLInputElement>("sp-code")?.value.trim() ?? "";
    if (!code) return setErr("sp-err", "ใส่รหัสเชิญก่อน");
    setErr("sp-err", "");
    try {
      const r = await fetch(`${API}/workspaces/join`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (!r.ok) return setErr("sp-err", d.error === "workspace not found" ? "ไม่พบรหัสเชิญนี้" : (d.error || "เข้าร่วมไม่สำเร็จ"));
      enterSpace(d.workspace);
    } catch { setErr("sp-err", "เชื่อมต่อ API ไม่ได้"); }
  };

  $("sp-logout")!.onclick = async () => {
    try { await fetch(`${API}/auth/logout`, { method: "POST", headers: authHeaders() }); } catch { /* ignore */ }
    localStorage.removeItem(TOKEN_KEY);
    location.href = location.pathname;
  };

  // --------------------------------------------- workspace settings/members
  let editing: Space | null = null;
  let myRole = "member";

  const closeModal = () => { const m = $("ws-modal"); if (m) m.style.display = "none"; };

  const renderMembers = (members: Member[]) => {
    const box = $("wm-members");
    const count = $("wm-count");
    if (count) count.textContent = String(members.length);
    if (!box) return;
    box.innerHTML = "";
    const canManage = myRole === "owner" || myRole === "admin";
    for (const m of members) {
      const row = document.createElement("div");
      row.className = "wm-member";
      const ava = document.createElement("span");
      ava.className = "wm-ava";
      if (m.photoUrl) {
        const img = document.createElement("img");
        img.src = m.photoUrl; img.alt = "";
        ava.appendChild(img);
      } else ava.textContent = initial(m.name);
      const info = document.createElement("span");
      info.className = "wm-mi";
      const b = document.createElement("b"); b.textContent = m.name + (m.isMe ? " (คุณ)" : "");
      const sm = document.createElement("small"); sm.textContent = m.email;
      info.append(b, sm);
      row.append(ava, info);

      if (m.role === "owner") {
        const tag = document.createElement("small");
        tag.style.color = "#8a8f98";
        tag.textContent = roleLabel("owner");
        row.appendChild(tag);
      } else if (myRole === "owner") {
        const sel = document.createElement("select");
        for (const r of ["admin", "member"]) {
          const o = document.createElement("option");
          o.value = r; o.textContent = roleLabel(r); o.selected = m.role === r;
          sel.appendChild(o);
        }
        sel.onchange = async () => {
          await fetch(`${API}/workspaces/${editing!.slug}/members/${m.id}`, {
            method: "PATCH", headers: authHeaders(), body: JSON.stringify({ role: sel.value }),
          });
          void loadMembers();
        };
        row.appendChild(sel);
      } else {
        const tag = document.createElement("small");
        tag.style.color = "#8a8f98";
        tag.textContent = roleLabel(m.role);
        row.appendChild(tag);
      }

      if (m.role !== "owner" && (canManage || m.isMe)) {
        const x = document.createElement("button");
        x.className = "wm-x";
        x.textContent = "✕";
        x.title = m.isMe ? "ออกจาก workspace" : "นำออก";
        x.onclick = async () => {
          if (!confirm(m.isMe ? "ออกจาก workspace นี้?" : `นำ ${m.name} ออกจาก workspace?`)) return;
          await fetch(`${API}/workspaces/${editing!.slug}/members/${m.id}`, {
            method: "DELETE", headers: authHeaders(),
          });
          if (m.isMe) { closeModal(); void showSpaces(); } else void loadMembers();
        };
        row.appendChild(x);
      }
      box.appendChild(row);
    }
  };

  const loadMembers = async () => {
    if (!editing) return;
    try {
      const r = await fetch(`${API}/workspaces/${editing.slug}/members`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) return setErr("wm-err", d.error || "โหลดสมาชิกไม่ได้");
      myRole = d.myRole;
      renderMembers(d.members ?? []);
    } catch { setErr("wm-err", "เชื่อมต่อ API ไม่ได้"); }
  };

  const openSettings = async (s: Space) => {
    editing = s;
    myRole = s.role;
    setErr("wm-err", "");
    const m = $("ws-modal");
    if (m) m.style.display = "grid";
    $("wm-title")!.textContent = s.name;
    $("wm-sub")!.textContent = `ลิงก์: ?w=${s.slug}`;
    // fresh copy so we get the invite code (only returned to members)
    try {
      const r = await fetch(`${API}/workspaces/${s.slug}`, { headers: authHeaders() });
      const d = await r.json();
      const w = d.workspace ?? s;
      $<HTMLInputElement>("wm-name")!.value = w.name ?? s.name;
      $<HTMLInputElement>("wm-guests")!.checked = !!w.allowGuests;
      $<HTMLInputElement>("wm-invite")!.value = w.inviteCode
        ? `${location.origin}${location.pathname}?w=${s.slug}` : "—";
      $<HTMLInputElement>("wm-invite")!.dataset.code = w.inviteCode ?? "";
    } catch { /* keep what we have */ }
    const owner = myRole === "owner" || myRole === "admin";
    for (const id of ["wm-name", "wm-guests"]) $<HTMLInputElement>(id)!.disabled = !owner;
    $("wm-save")!.style.display = owner ? "" : "none";
    $("wm-reset")!.style.display = owner ? "" : "none";
    void loadMembers();
  };

  $("wm-close")!.onclick = closeModal;
  $("ws-modal")!.onclick = (e) => { if (e.target === $("ws-modal")) closeModal(); };

  $("wm-copy")!.onclick = async () => {
    const v = $<HTMLInputElement>("wm-invite")!.value;
    try { await navigator.clipboard.writeText(v); $("wm-copy")!.textContent = "คัดลอกแล้ว"; }
    catch { /* ignore */ }
    setTimeout(() => ($("wm-copy")!.textContent = "คัดลอก"), 1500);
  };

  $("wm-reset")!.onclick = async () => {
    if (!editing || !confirm("สร้างรหัสเชิญใหม่? ลิงก์เดิมจะใช้ไม่ได้")) return;
    const r = await fetch(`${API}/workspaces/${editing.slug}/invite/reset`, { method: "POST", headers: authHeaders() });
    const d = await r.json();
    if (r.ok) setErr("wm-err", "สร้างรหัสเชิญใหม่แล้ว");
    else setErr("wm-err", d.error || "รีเซ็ตไม่สำเร็จ");
  };

  $("wm-leave")!.onclick = async () => {
    if (!editing || !confirm("ออกจาก workspace นี้?")) return;
    const me = (await (await fetch(`${API}/workspaces/${editing.slug}/members`, { headers: authHeaders() })).json())
      .members?.find((m: Member) => m.isMe);
    if (!me) return;
    const r = await fetch(`${API}/workspaces/${editing.slug}/members/${me.id}`, { method: "DELETE", headers: authHeaders() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setErr("wm-err", d.error === "the owner cannot be removed" ? "เจ้าของออกเองไม่ได้" : (d.error || "ออกไม่สำเร็จ"));
    closeModal();
    void showSpaces();
  };

  $("wm-save")!.onclick = async () => {
    if (!editing) return;
    setErr("wm-err", "");
    const body = {
      name: $<HTMLInputElement>("wm-name")!.value.trim(),
      allowGuests: $<HTMLInputElement>("wm-guests")!.checked,
    };
    const r = await fetch(`${API}/workspaces/${editing.slug}`, {
      method: "PATCH", headers: authHeaders(), body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) return setErr("wm-err", d.error || "บันทึกไม่สำเร็จ");
    closeModal();
    void showSpaces();
  };

  // -------------------------------------------------------- character select
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
    const init = customConfig ?? await defaultDressedConfig();
    const cfg = await openAvatarEditor(init, cName?.value || user?.name || "avatar");
    if (!cfg) return;
    customConfig = cfg;
    selected = encodeAvatar(cfg);
    setCustomThumb(cfg);
    highlight("custom");
  };

  const toChar = (u: User | null) => {
    if (u?.avatar?.lpc) { customConfig = u.avatar.lpc; selected = encodeAvatar(u.avatar.lpc); setCustomThumb(u.avatar.lpc); }
    else { void defaultDressedConfig().then(setCustomThumb); }
    if (u?.avatar?.avatarId && !u?.avatar?.lpc) selected = u.avatar.avatarId;
    showStep("char-step");
    const hello = $("char-hello");
    if (hello) hello.textContent = u ? `สวัสดี ${u.name}` : "โหมด Guest";
    if (cName) cName.value = u?.name ?? "";
    if (u?.avatar?.lpc) highlight("custom"); else selectPreset(selected);
  };

  document.querySelectorAll<HTMLElement>(".char-opt").forEach((el) => (el.onclick = () => {
    if (el.dataset.avatar === "custom") void openEditor();
    else selectPreset(el.dataset.avatar || "1");
  }));

  $("c-enter")!.onclick = () => {
    const name = cName?.value.trim() || user?.name || "Guest";
    if (token()) {
      const body = selectedTile === "custom" && customConfig ? { lpc: customConfig } : { avatarId: selected };
      fetch(`${API}/me/avatar`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) }).catch(() => {});
    }
    if (overlay) overlay.style.display = "none";
    if (spaces) spaces.style.display = "none";
    // desk is per workspace: members from their account, guests from this device
    const desk = user?.desks?.[WORKSPACE] || localStorage.getItem(wsKey("nexspace-desk")) || "";
    onReady({ name, avatar: selected, desk });
  };

  // ------------------------------------------------------------- entry point
  (async () => {
    if (!token()) return showStep("auth-step");
    try {
      const r = await fetch(`${API}/me`, { headers: authHeaders() });
      if (!r.ok) { localStorage.removeItem(TOKEN_KEY); return showStep("auth-step"); }
      user = (await r.json()).user;
      afterSignIn();
    } catch { showStep("auth-step"); } // offline -> let them sign in / go guest
  })();
}
