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
  role?: string | null;                  // onboarding answers, used to prefill the wizard
  companySize?: string | null;
  totpEnabled?: boolean;                 // authenticator app required at sign-in
  recoveryLeft?: number;
}
interface Space { slug: string; name: string; role: string; members?: number; inviteCode?: string }
interface Member {
  id: string; name: string; email: string; photoUrl?: string; role: string; isMe: boolean;
  joinedAt?: string; lastSeenAt?: string | null;
  canManage?: boolean;  // the server's verdict: may I change or remove this person?
  canPromote?: boolean; // owner only — may I make them an admin?
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const TOKEN_KEY = "nexspace-token";
const token = () => localStorage.getItem(TOKEN_KEY);
const authHeaders = () => ({
  "Content-Type": "application/json",
  ...(token() ? { Authorization: "Bearer " + token()! } : {}),
});
const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

/**
 * A row of single-character boxes that behaves like one field: digits advance,
 * backspace steps back, a pasted code spreads across them, and `onComplete`
 * fires as soon as the last box is filled. Shared by the email code, the
 * authenticator step, and enrolment.
 */
function wireCodeBoxes(boxes: HTMLInputElement[], onComplete: (code: string) => void) {
  const last = boxes.length - 1;
  boxes.forEach((box, i) => {
    box.oninput = () => {
      box.value = box.value.replace(/\D/g, "").slice(0, 1);
      if (box.value && i < last) boxes[i + 1].focus();
      if (boxes.every((b) => b.value)) onComplete(boxes.map((b) => b.value).join(""));
    };
    box.onkeydown = (e) => {
      if (e.key === "Backspace" && !box.value && i > 0) boxes[i - 1].focus();
    };
    box.onpaste = (e) => {
      const text = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "").slice(0, boxes.length);
      if (!text) return;
      e.preventDefault();
      boxes.forEach((b, k) => (b.value = text[k] ?? ""));
      boxes[Math.min(text.length, last)].focus();
      if (text.length === boxes.length) onComplete(text);
    };
  });
}

const roleLabel = (r: string) =>
  r === "owner" ? "เจ้าของ" : r === "admin" ? "ผู้ดูแล" : r === "guest" ? "ผู้เยี่ยมชม" : "สมาชิก";

/** "เมื่อสักครู่" / "5 นาทีที่แล้ว" / "3 วันที่แล้ว" — coarse on purpose */
const sinceLabel = (iso?: string | null) => {
  if (!iso) return "ยังไม่เคยเข้า";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 6) return "กำลังใช้งาน";
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  if (mins < 1440) return `${Math.floor(mins / 60)} ชม.ที่แล้ว`;
  const days = Math.floor(mins / 1440);
  return days < 30 ? `${days} วันที่แล้ว` : new Date(iso).toLocaleDateString("th-TH");
};

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
  let pendingTotp = "";        // session token awaiting an authenticator code
  let mySpaces: Space[] = [];

  const setErr = (id: string, m: string) => { const e = $(id); if (e) e.textContent = m; };

  const showStep = (id: "auth-step" | "code-step" | "totp-step" | "char-step") => {
    for (const s of ["auth-step", "code-step", "totp-step", "char-step"]) {
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
    // `totp` means Google verified the account but it also has an authenticator:
    // this token stays out of localStorage until the code step promotes it.
    const half = h.get("totp");
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      history.replaceState(null, "", location.pathname + location.search);
    } else if (half) {
      pendingTotp = half;
      history.replaceState(null, "", location.pathname + location.search);
    } else if (h.get("auth_error")) {
      const reason = h.get("auth_error") ?? "";
      history.replaceState(null, "", location.pathname + location.search);
      // the API passes Google's own error code through, so the message can say
      // what to fix instead of just "it failed"
      const MSG: Record<string, string> = {
        access_denied: "Google ปฏิเสธการเข้าสู่ระบบ — แอปยังไม่ได้เผยแพร่ ให้เพิ่มอีเมลนี้ใน Test users หรือกด Publish app",
        admin_policy_enforced: "ผู้ดูแล Google Workspace ขององค์กรบล็อกแอปนี้ไว้",
        redirect_uri_mismatch: "Redirect URI ไม่ตรงกับที่ลงทะเบียนใน Google Cloud Console",
        invalid_client: "Client ID หรือ Client secret ไม่ถูกต้อง",
        invalid_grant: "รหัสจาก Google หมดอายุหรือถูกใช้แล้ว — ลองอีกครั้ง",
        token_exchange: "แลกโทเคนกับ Google ไม่สำเร็จ — ตรวจ Client secret",
        no_code: "Google ไม่ได้ส่งรหัสยืนยันกลับมา",
        no_email: "บัญชี Google นี้ไม่มีอีเมล",
      };
      setErr("auth-err", MSG[reason] ?? `เข้าสู่ระบบด้วย Google ไม่สำเร็จ (${reason})`);
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
      if (d.totpRequired) return toTotp(d.pendingToken);
      localStorage.setItem(TOKEN_KEY, d.token);
      user = d.user;
      afterSignIn();
    } catch { setErr("code-err", "เชื่อมต่อ API ไม่ได้"); }
  };

  wireCodeBoxes(codeInputs(), () => void verifyCode());

  $("code-resend")!.onclick = async () => {
    setErr("code-err", "");
    try { await requestCode(pendingEmail); setErr("code-err", "ส่งรหัสใหม่แล้ว"); }
    catch (e) { setErr("code-err", (e as Error).message); }
  };
  $("code-cancel")!.onclick = () => { codeInputs().forEach((i) => (i.value = "")); showStep("auth-step"); };
  $("a-guest")!.onclick = () => { user = null; toChar(null); };

  // -------------------------------------------- second factor: authenticator app
  const totpBoxes = () => Array.from(document.querySelectorAll<HTMLInputElement>("#totp-boxes input"));

  /** the 6 boxes and the recovery-code field are two ways to answer the same step */
  const showRecoveryField = (on: boolean) => {
    $("totp-boxes")!.style.display = on ? "none" : "flex";
    $("totp-rc")!.style.display = on ? "block" : "none";
    $("totp-rc-go")!.style.display = on ? "block" : "none";
    $("totp-rc-toggle")!.textContent = on ? "กลับไปใช้รหัสจากแอป" : "ทำโทรศัพท์หาย? ใช้รหัสสำรอง";
    $("totp-sub")!.textContent = on
      ? "กรอกรหัสสำรองที่คุณเก็บไว้ตอนเปิดใช้งาน — ใช้ได้รหัสละครั้ง"
      : "กรอกรหัส 6 หลักจากแอป Authenticator ของคุณ";
    setErr("totp-err", "");
    (on ? $<HTMLInputElement>("totp-rc") : totpBoxes()[0])?.focus();
  };

  const toTotp = (pending: string) => {
    pendingTotp = pending;
    totpBoxes().forEach((i) => (i.value = ""));
    const rc = $<HTMLInputElement>("totp-rc");
    if (rc) rc.value = "";
    showStep("totp-step");
    showRecoveryField(false);
  };

  const submitTotp = async (code: string) => {
    if (!code) return;
    // a reload during this step drops the pending token — start over rather than
    // sit there doing nothing when the button is pressed
    if (!pendingTotp) {
      setErr("auth-err", "หมดเวลายืนยันตัวตน — เข้าสู่ระบบใหม่อีกครั้ง");
      return showStep("auth-step");
    }
    setErr("totp-err", "");
    try {
      const r = await fetch(`${API}/auth/totp/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pendingTotp, code }),
      });
      const d = await r.json().catch(() => ({} as any));
      if (!r.ok) {
        totpBoxes().forEach((i) => (i.value = ""));
        totpBoxes()[0]?.focus();
        // a spent pending token is gone for good — send them back to the start
        if (r.status === 429 || d.error === "session expired") {
          pendingTotp = "";
          setErr("auth-err", r.status === 429
            ? "กรอกรหัสผิดหลายครั้งเกินไป — เข้าสู่ระบบใหม่อีกครั้ง"
            : "หมดเวลายืนยันตัวตน — เข้าสู่ระบบใหม่อีกครั้ง");
          return showStep("auth-step");
        }
        const left = typeof d.attemptsLeft === "number" ? ` (เหลือ ${d.attemptsLeft} ครั้ง)` : "";
        return setErr("totp-err",
          d.reused ? "รหัสนี้ถูกใช้ไปแล้ว — รอรหัสถัดไปในแอป"
          : `รหัสไม่ถูกต้อง${left}`);
      }
      localStorage.setItem(TOKEN_KEY, d.token);
      pendingTotp = "";
      user = d.user;
      afterSignIn();
    } catch { setErr("totp-err", "เชื่อมต่อ API ไม่ได้"); }
  };

  wireCodeBoxes(totpBoxes(), (code) => void submitTotp(code));

  $("totp-rc-toggle")!.onclick = () => showRecoveryField($("totp-rc")!.style.display === "none");
  $("totp-rc-go")!.onclick = () => void submitTotp($<HTMLInputElement>("totp-rc")?.value.trim() ?? "");
  $<HTMLInputElement>("totp-rc")!.onkeydown = (e) => {
    if (e.key === "Enter") void submitTotp(($("totp-rc") as HTMLInputElement).value.trim());
  };
  $("totp-cancel")!.onclick = () => { pendingTotp = ""; showStep("auth-step"); };

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

  $("sp-create")!.onclick = () => startWizard($<HTMLInputElement>("sp-newname")?.value.trim() ?? "");

  // ------------------------------------------------------ create-space wizard
  type Step =
    | { key: "role" | "companySize" | "useCase"; q: string; opts: string[]; other?: boolean }
    | { key: "name"; q: string };

  const STEPS: Step[] = [
    { key: "role", q: "บทบาทของคุณตรงกับข้อไหนมากที่สุด?",
      opts: ["ผู้ก่อตั้ง", "ผู้บริหาร", "ผู้อำนวยการ", "ผู้จัดการ", "สมาชิกทีม"] },
    { key: "companySize", q: "บริษัทของคุณมีขนาดเท่าไหร่?",
      opts: ["1 - 10", "11 - 50", "51 - 200", "201 - 1,000", "1,000+"] },
    { key: "useCase", q: "คุณจะใช้ออฟฟิศเสมือนนี้เป็นหลักอย่างไร?", other: true,
      opts: ["พื้นที่ทำงานประจำวันของทีม", "พื้นที่ทำงานสัปดาห์ละ 1-2 ครั้ง",
             "อีเวนต์ครั้งเดียว (เช่น Hackathon)", "อีเวนต์ประจำ (เช่น Workshop)", "อื่น ๆ (ระบุ)"] },
    { key: "name", q: "ตั้งชื่อ Space ของคุณ" },
  ];

  const answers: Record<string, string> = {};
  const otherKey = (key: string) => `${key}__other`;
  const isOther = (v: string) => v.startsWith("อื่น ๆ");
  let stepIx = 0;
  let allowGuests = true;

  const wizEls = () => ({
    overlay: $("wiz-overlay")!, bar: $("wiz-bar")!, q: $("wiz-q")!,
    opts: $("wiz-opts")!, other: $<HTMLInputElement>("wiz-other")!,
    back: $("wiz-back")!, next: $<HTMLButtonElement>("wiz-next")!,
  });

  const startWizard = (presetName = "") => {
    stepIx = 0;
    answers.name = presetName;
    // questions about the person are asked once — reuse what the account already knows
    if (user?.role) answers.role = user.role;
    if (user?.companySize) answers.companySize = user.companySize;
    if (spaces) spaces.style.display = "none";
    wizEls().overlay.style.display = "flex";
    // skip straight past any question already answered
    while (stepIx < STEPS.length - 1 && answers[STEPS[stepIx].key]) stepIx++;
    renderStep();
  };

  const closeWizard = () => {
    wizEls().overlay.style.display = "none";
    void showSpaces();
  };

  const renderStep = () => {
    const e = wizEls();
    const step = STEPS[stepIx];
    setErr("wiz-err", "");
    e.bar.style.width = `${(stepIx / STEPS.length) * 100}%`;
    e.q.textContent = step.q;
    e.back.style.visibility = stepIx === 0 ? "hidden" : "visible";
    e.opts.innerHTML = "";
    e.other.style.display = "none";
    e.other.value = "";

    if (step.key === "name") {
      // final step: name + guest access
      const input = document.createElement("input");
      input.type = "text";
      input.id = "wiz-name";
      input.placeholder = "เช่น บริษัท A";
      input.value = answers.name ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dfe1e6;border-radius:10px;font-size:14px;outline:none";
      input.oninput = () => { answers.name = input.value.trim(); e.next.disabled = !answers.name; };
      const label = document.createElement("label");
      label.className = "wiz-check";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = allowGuests;
      cb.onchange = () => (allowGuests = cb.checked);
      label.append(cb, document.createTextNode("ให้คนที่ไม่ได้สมัครสมาชิก (Guest) เข้าได้"));
      e.opts.append(input, label);
      e.next.textContent = "สร้าง Space";
      e.next.disabled = !answers.name;
      input.focus();
      return;
    }

    e.next.textContent = "ถัดไป →";
    for (const opt of step.opts) {
      const b = document.createElement("button");
      b.className = "wiz-opt" + (answers[step.key] === opt ? " on" : "");
      b.textContent = opt;
      b.onclick = () => {
        answers[step.key] = opt;
        e.opts.querySelectorAll(".wiz-opt").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        if (step.other && isOther(opt)) { e.other.style.display = "block"; e.other.focus(); }
        else e.other.style.display = "none";
        e.next.disabled = false;
      };
      e.opts.appendChild(b);
    }
    // going back must restore both the highlighted pill and any typed detail,
    // so the detail is kept alongside the chosen label rather than replacing it
    if (step.other && answers[step.key] && isOther(answers[step.key])) {
      e.other.style.display = "block";
      e.other.value = answers[otherKey(step.key)] ?? "";
    }
    e.next.disabled = !answers[step.key];
  };

  $("wiz-back")!.onclick = () => { if (stepIx > 0) { stepIx--; renderStep(); } };
  $("wiz-cancel")!.onclick = closeWizard;

  $("wiz-next")!.onclick = async () => {
    const step = STEPS[stepIx];
    if (step.key !== "name") {
      // keep the typed detail next to the chosen label so Back can restore both
      if (wizEls().other.style.display !== "none") {
        answers[otherKey(step.key)] = wizEls().other.value.trim();
      }
      stepIx++;
      return renderStep();
    }
    if (!answers.name) return setErr("wiz-err", "ใส่ชื่อ Space ก่อน");
    const btn = wizEls().next;
    btn.disabled = true;
    setErr("wiz-err", "");
    try {
      const r = await fetch(`${API}/workspaces`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({
          name: answers.name, allowGuests,
          role: answers.role, companySize: answers.companySize,
          // an "other" pick is reported as what they actually typed
          useCase: isOther(answers.useCase ?? "")
            ? (answers[otherKey("useCase")] || answers.useCase)
            : answers.useCase,
        }),
      });
      const d = await r.json();
      if (!r.ok) { btn.disabled = false; return setErr("wiz-err", d.error || "สร้างไม่สำเร็จ"); }
      wizEls().bar.style.width = "100%";
      enterSpace(d.workspace);
    } catch { btn.disabled = false; setErr("wiz-err", "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้"); }
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

  // ----------------------------------------------- 2FA settings (account level)
  // Four states share one dialog: off -> scanning -> codes shown -> on.
  type SecState = "off" | "scan" | "codes" | "on";
  let secCodes: string[] = [];

  const secBoxes = () => Array.from(document.querySelectorAll<HTMLInputElement>("#sec-boxes input"));

  const setSecState = (s: SecState) => {
    const vis: Record<SecState, string[]> = {
      off:   ["sec-off", "sec-start"],
      scan:  ["sec-scan", "sec-confirm"],
      codes: ["sec-codes", "sec-done"],
      on:    ["sec-on", "sec-disable", "sec-regen"],
    };
    for (const id of ["sec-off", "sec-scan", "sec-codes", "sec-on",
                      "sec-start", "sec-confirm", "sec-done", "sec-disable", "sec-regen"]) {
      const el = $(id);
      if (el) el.style.display = vis[s].includes(id) ? "" : "none";
    }
    // once the codes are on screen, closing without reading them is the mistake
    $("sec-close")!.style.display = s === "codes" ? "none" : "";
    setErr("sec-err", "");
  };

  const renderSecCodes = () => {
    const box = $("sec-codes-list");
    if (!box) return;
    box.innerHTML = "";
    for (const c of secCodes) {
      const span = document.createElement("span");
      span.textContent = c;
      box.appendChild(span);
    }
  };

  const openSecurity = () => {
    const m = $("sec-modal");
    if (m) m.style.display = "grid";
    const ask = $<HTMLInputElement>("sec-ask");
    if (ask) ask.value = "";
    secBoxes().forEach((i) => (i.value = ""));
    if (user?.totpEnabled) {
      $("sec-left")!.textContent = String(user.recoveryLeft ?? 0);
      setSecState("on");
    } else setSecState("off");
  };

  /** refresh the cached profile so the dialog and the badge agree */
  const applyUser = (u: User | undefined) => { if (u) user = { ...user, ...u } as User; };

  const secCall = async (path: string, body?: unknown) => {
    const r = await fetch(`${API}/me/totp/${path}`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(body ?? {}),
    });
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok) {
      throw new Error(
        d.error === "invalid code" ? "รหัสไม่ถูกต้อง"
        : d.error === "already enabled" ? "เปิดใช้งานอยู่แล้ว"
        : d.error === "start setup first" ? "เริ่มขั้นตอนตั้งค่าใหม่อีกครั้ง"
        : d.error || "ทำรายการไม่สำเร็จ");
    }
    return d;
  };

  $("sp-security")!.onclick = openSecurity;
  $("sec-close")!.onclick = () => { const m = $("sec-modal"); if (m) m.style.display = "none"; };

  $("sec-start")!.onclick = async () => {
    setErr("sec-err", "");
    try {
      const d = await secCall("setup");
      $<HTMLImageElement>("sec-qr")!.src = d.qr;
      // grouped in fours: much easier to type by hand than a 32-char run
      $<HTMLInputElement>("sec-secret")!.value = (d.secret as string).replace(/(.{4})(?=.)/g, "$1 ");
      setSecState("scan");
      secBoxes()[0]?.focus();
    } catch (e) { setErr("sec-err", (e as Error).message); }
  };

  $("sec-copy")!.onclick = () => {
    void navigator.clipboard?.writeText($<HTMLInputElement>("sec-secret")!.value.replace(/\s/g, ""));
    setErr("sec-err", "คัดลอกรหัสแล้ว");
  };

  const confirmEnable = async (code: string) => {
    setErr("sec-err", "");
    try {
      const d = await secCall("enable", { code });
      applyUser(d.user);
      secCodes = d.recoveryCodes ?? [];
      renderSecCodes();
      setSecState("codes");
    } catch (e) {
      secBoxes().forEach((i) => (i.value = ""));
      secBoxes()[0]?.focus();
      setErr("sec-err", (e as Error).message);
    }
  };

  wireCodeBoxes(secBoxes(), (code) => void confirmEnable(code));
  $("sec-confirm")!.onclick = () => void confirmEnable(secBoxes().map((b) => b.value).join(""));

  $("sec-codes-copy")!.onclick = () => {
    void navigator.clipboard?.writeText(secCodes.join("\n"));
    setErr("sec-err", "คัดลอกรหัสสำรองแล้ว");
  };

  $("sec-codes-save")!.onclick = () => {
    const text = `รหัสสำรอง NexSpace — ${user?.email ?? ""}\n`
      + `ใช้ได้รหัสละ 1 ครั้ง เมื่อไม่มีแอป Authenticator\n\n${secCodes.join("\n")}\n`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = "nexspace-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $("sec-done")!.onclick = () => {
    secCodes = [];
    $("sec-left")!.textContent = String(user?.recoveryLeft ?? 0);
    setSecState("on");
  };

  $("sec-disable")!.onclick = async () => {
    const code = $<HTMLInputElement>("sec-ask")?.value.trim() ?? "";
    if (!code) return setErr("sec-err", "กรอกรหัสเพื่อยืนยัน");
    try {
      applyUser((await secCall("disable", { code })).user);
      setSecState("off");
    } catch (e) { setErr("sec-err", (e as Error).message); }
  };

  $("sec-regen")!.onclick = async () => {
    const code = $<HTMLInputElement>("sec-ask")?.value.trim() ?? "";
    if (!code) return setErr("sec-err", "กรอกรหัสเพื่อยืนยัน");
    try {
      const d = await secCall("recovery", { code });
      applyUser(d.user);
      secCodes = d.recoveryCodes ?? [];
      renderSecCodes();
      setSecState("codes");
    } catch (e) { setErr("sec-err", (e as Error).message); }
  };

  // --------------------------------------------- workspace settings/members
  let editing: Space | null = null;
  let myRole = "member";

  const closeModal = () => { const m = $("ws-modal"); if (m) m.style.display = "none"; };

  let allMembers: Member[] = [];

  const setRole = async (m: Member, role: string) => {
    setErr("wm-err", "");
    const r = await fetch(`${API}/workspaces/${editing!.slug}/members/${m.id}`, {
      method: "PATCH", headers: authHeaders(), body: JSON.stringify({ role }),
    });
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok) return setErr("wm-err", d.error === "forbidden" ? "คุณไม่มีสิทธิ์เปลี่ยนสิทธิ์ของคนนี้"
      : d.error || "เปลี่ยนสิทธิ์ไม่สำเร็จ");
    setErr("wm-err", `${m.name} เป็น${roleLabel(role)}แล้ว`);
    void loadMembers();
  };

  const removeMember = async (m: Member) => {
    if (!confirm(m.isMe ? "ออกจาก workspace นี้?" : `นำ ${m.name} ออกจาก workspace?`)) return;
    setErr("wm-err", "");
    const r = await fetch(`${API}/workspaces/${editing!.slug}/members/${m.id}`, {
      method: "DELETE", headers: authHeaders(),
    });
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok) return setErr("wm-err", d.error === "forbidden" ? "คุณไม่มีสิทธิ์นำคนนี้ออก"
      : d.error === "the owner cannot be removed" ? "นำเจ้าของออกไม่ได้"
      : d.error || "นำออกไม่สำเร็จ");
    if (m.isMe) { closeModal(); void showSpaces(); } else void loadMembers();
  };

  const closeMenus = () => document.querySelectorAll(".wm-menu").forEach((el) => el.remove());
  // one click anywhere else dismisses an open menu
  document.addEventListener("click", closeMenus);

  type MenuItem = { label: string; icon: string; run: () => void; danger?: boolean };

  /**
   * What this row may actually do, from the permissions the server reported.
   * Nothing is listed that the server would refuse — in particular the owner
   * gets no "leave" entry, because a workspace cannot be left ownerless.
   */
  const menuItems = (m: Member): MenuItem[] => {
    const items: MenuItem[] = [];
    // one entry per destination role, so "ตั้งเป็นสมาชิก" and "ถอดสิทธิ์ผู้ดูแล"
    // can't both appear on an admin row doing the very same thing
    const to = (role: string, label: string, allowed: boolean) => {
      if (!allowed || m.role === role) return;
      const rank: Record<string, number> = { admin: 2, member: 1, guest: 0 };
      items.push({ label, icon: rank[role] > (rank[m.role] ?? 1) ? "↑" : "↓", run: () => void setRole(m, role) });
    };

    to("admin", "ตั้งเป็นผู้ดูแล", !!m.canPromote);
    to("member", m.role === "admin" ? "ถอดสิทธิ์ผู้ดูแล" : "ตั้งเป็นสมาชิก", !!m.canManage);
    to("guest", "ลดเป็นผู้เยี่ยมชม", !!m.canManage);

    if (m.role !== "owner" && (m.canManage || m.isMe)) {
      items.push({
        label: m.isMe ? "ออกจาก Workspace" : "นำออกจาก Workspace",
        icon: "⊘", danger: true, run: () => void removeMember(m),
      });
    }
    return items;
  };

  const buildMenu = (items: MenuItem[]) => {
    const menu = document.createElement("div");
    menu.className = "wm-menu";
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

  const renderMembers = () => {
    const box = $("wm-members");
    const count = $("wm-count");
    if (count) count.textContent = String(allMembers.length);
    if (!box) return;
    box.innerHTML = "";

    const q = ($<HTMLInputElement>("wm-search")?.value ?? "").trim().toLowerCase();
    const only = $<HTMLSelectElement>("wm-filter")?.value ?? "";
    const shown = allMembers.filter((m) =>
      (!only || m.role === only)
      && (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)));

    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "wm-empty";
      empty.textContent = allMembers.length ? "ไม่พบสมาชิกที่ตรงกับการค้นหา" : "ยังไม่มีสมาชิก";
      box.appendChild(empty);
      return;
    }

    for (const m of shown) {
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

      const chip = document.createElement("span");
      chip.className = `wm-role ${m.role}`;
      chip.textContent = roleLabel(m.role);

      const seen = document.createElement("span");
      seen.className = "wm-seen";
      seen.textContent = sinceLabel(m.lastSeenAt);
      if (m.joinedAt) seen.title = `เข้าร่วมเมื่อ ${new Date(m.joinedAt).toLocaleDateString("th-TH")}`;

      row.append(ava, info, chip, seen);

      // nothing actionable -> no menu button, rather than a menu that only refuses
      const items = menuItems(m);
      if (items.length) {
        const wrap = document.createElement("span");
        wrap.className = "wm-kebab";
        const btn = document.createElement("button");
        btn.textContent = "⋮";
        btn.title = "ตัวเลือก";
        btn.onclick = (e) => {
          e.stopPropagation();
          const open = wrap.querySelector(".wm-menu");
          closeMenus();
          if (!open) wrap.appendChild(buildMenu(items));
        };
        wrap.appendChild(btn);
        row.appendChild(wrap);
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
      allMembers = d.members ?? [];
      applyRolePermissions();
      renderMembers();
    } catch { setErr("wm-err", "เชื่อมต่อ API ไม่ได้"); }
  };

  /** hide what this role may not do, instead of letting the server refuse later */
  const applyRolePermissions = () => {
    const manager = myRole === "owner" || myRole === "admin";
    for (const id of ["wm-name", "wm-guests"]) {
      const el = $<HTMLInputElement>(id);
      if (el) el.disabled = !manager;
    }
    $("wm-save")!.style.display = manager ? "" : "none";
    $("wm-reset")!.style.display = manager ? "" : "none";
    // a workspace cannot be left ownerless, so the owner gets no leave button
    $("wm-leave")!.style.display = myRole === "owner" ? "none" : "";
    // guests must not be able to hand the invite link to anyone else
    const hideInvite = myRole === "guest";
    $("wm-invite-l")!.style.display = hideInvite ? "none" : "";
    $("wm-invite-row")!.style.display = hideInvite ? "none" : "flex";
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
    // apply what we already know, then again once the roster confirms the role
    applyRolePermissions();
    const search = $<HTMLInputElement>("wm-search");
    if (search) search.value = "";
    const filter = $<HTMLSelectElement>("wm-filter");
    if (filter) filter.value = "";
    void loadMembers();
  };

  $("wm-search")!.oninput = renderMembers;
  $("wm-filter")!.onchange = renderMembers;

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
    // Google signed us in but the account also has an authenticator
    if (pendingTotp) return toTotp(pendingTotp);
    if (!token()) return showStep("auth-step");
    try {
      const r = await fetch(`${API}/me`, { headers: authHeaders() });
      if (!r.ok) { localStorage.removeItem(TOKEN_KEY); return showStep("auth-step"); }
      user = (await r.json()).user;
      afterSignIn();
    } catch { showStep("auth-step"); } // offline -> let them sign in / go guest
  })();
}
