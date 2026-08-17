// Sign-in (Google or a 6-digit email code), the spaces dashboard, workspace
// settings/members, and character select. Persists the session token in
// localStorage and hands {name, avatar, desk} to the game.
import { openAvatarEditor } from "./avatar/avatarEditor";
import { encodeAvatar, buildFrameCanvas, defaultDressedConfig, type LpcConfig } from "./avatar/avatarCompose";
import { WORKSPACE, HAS_WORKSPACE_PARAM, gotoWorkspace, wsKey, wsKeyFor, rememberTheme,
         GUEST_CODE } from "./workspace";
import { API, TOKEN_KEY, authToken as token, authHeaders } from "./api";
import { mountMemberPanel, roleLabel, type PanelMember } from "./memberPanel";
import { THEMES } from "./scenes/mapThemes";
import { renderThemePreview } from "./themePreview";
import { t } from "./i18n";

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
interface Space { slug: string; name: string; role: string; members?: number; inviteCode?: string; theme?: string }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
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
    const tok = h.get("token");
    // `totp` means Google verified the account but it also has an authenticator:
    // this token stays out of localStorage until the code step promotes it.
    const half = h.get("totp");
    if (tok) {
      localStorage.setItem(TOKEN_KEY, tok);
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
        access_denied: t("Google ปฏิเสธการเข้าสู่ระบบ — แอปยังไม่ได้เผยแพร่ ให้เพิ่มอีเมลนี้ใน Test users หรือกด Publish app"),
        admin_policy_enforced: t("ผู้ดูแล Google Workspace ขององค์กรบล็อกแอปนี้ไว้"),
        redirect_uri_mismatch: t("Redirect URI ไม่ตรงกับที่ลงทะเบียนใน Google Cloud Console"),
        invalid_client: t("Client ID หรือ Client secret ไม่ถูกต้อง"),
        invalid_grant: t("รหัสจาก Google หมดอายุหรือถูกใช้แล้ว — ลองอีกครั้ง"),
        token_exchange: t("แลกโทเคนกับ Google ไม่สำเร็จ — ตรวจ Client secret"),
        no_code: t("Google ไม่ได้ส่งรหัสยืนยันกลับมา"),
        no_email: t("บัญชี Google นี้ไม่มีอีเมล"),
      };
      setErr("auth-err", MSG[reason] ?? t("เข้าสู่ระบบด้วย Google ไม่สำเร็จ ({reason})", { reason }));
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
        if (!d?.workspace) return;
        // cache the layout before the game boots, so an invite link lands on the
        // right map first time instead of loading the default and reloading
        if (d.workspace.theme) rememberTheme(WORKSPACE, d.workspace.theme);
        if (!d.workspace.name) return;
        const sub = document.querySelector<HTMLElement>("#auth-step .sub");
        if (sub) sub.textContent = t("เข้าสู่ workspace: {name}", { name: d.workspace.name });
        localStorage.setItem(wsKey("nexspace-ws-name"), d.workspace.name);
      }).catch(() => {});
  }

  $("a-google")!.onclick = () => {
    location.href = `${API}/auth/google${HAS_WORKSPACE_PARAM ? `?w=${encodeURIComponent(WORKSPACE)}` : ""}`;
  };

  /** a thrown TypeError from fetch means the API is unreachable, not a bad request */
  const NET_ERR = t("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบว่า API ทำงานอยู่");

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
        d.error === "invalid email" ? t("อีเมลไม่ถูกต้อง")
        : d.error === "could not send email" ? t("ส่งอีเมลไม่สำเร็จ — ตรวจการตั้งค่า SMTP")
        : d.error || t("ส่งรหัสไม่สำเร็จ"));
    }
    return d as { delivered: boolean };
  };

  $("a-send-code")!.onclick = async () => {
    const email = emailInput?.value.trim() ?? "";
    setErr("auth-err", "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setErr("auth-err", t("กรอกอีเมลให้ถูกต้อง"));
    try {
      const d = await requestCode(email);
      pendingEmail = email;
      showStep("code-step");
      setErr("code-err", "");
      const sub = $("code-sub");
      if (sub) {
        sub.textContent = d.delivered
          ? t("เราส่งรหัส 6 หลักไปที่ {email} แล้ว หากไม่พบให้ตรวจในกล่องสแปม", { email })
          : t("ระบบยังไม่ได้ตั้งค่าอีเมล — ดูรหัสได้ที่ log ของเซิร์ฟเวอร์ ({email})", { email });
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
          d.error === "invalid code" ? t("รหัสไม่ถูกต้อง")
          : d.error === "code expired" ? t("รหัสหมดอายุแล้ว — ขอรหัสใหม่")
          : d.error === "too many attempts" ? t("กรอกผิดหลายครั้งเกินไป — ขอรหัสใหม่")
          : d.error || t("ยืนยันรหัสไม่สำเร็จ"));
      }
      if (d.totpRequired) return toTotp(d.pendingToken);
      localStorage.setItem(TOKEN_KEY, d.token);
      user = d.user;
      afterSignIn();
    } catch { setErr("code-err", t("เชื่อมต่อ API ไม่ได้")); }
  };

  wireCodeBoxes(codeInputs(), () => void verifyCode());

  $("code-resend")!.onclick = async () => {
    setErr("code-err", "");
    try { await requestCode(pendingEmail); setErr("code-err", t("ส่งรหัสใหม่แล้ว")); }
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
    $("totp-rc-toggle")!.textContent = on ? t("กลับไปใช้รหัสจากแอป") : t("ทำโทรศัพท์หาย? ใช้รหัสสำรอง");
    $("totp-sub")!.textContent = on
      ? t("กรอกรหัสสำรองที่คุณเก็บไว้ตอนเปิดใช้งาน — ใช้ได้รหัสละครั้ง")
      : t("กรอกรหัส 6 หลักจากแอป Authenticator ของคุณ");
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
      setErr("auth-err", t("หมดเวลายืนยันตัวตน — เข้าสู่ระบบใหม่อีกครั้ง"));
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
            ? t("กรอกรหัสผิดหลายครั้งเกินไป — เข้าสู่ระบบใหม่อีกครั้ง")
            : t("หมดเวลายืนยันตัวตน — เข้าสู่ระบบใหม่อีกครั้ง"));
          return showStep("auth-step");
        }
        const left = typeof d.attemptsLeft === "number" ? " " + t("(เหลือ {n} ครั้ง)", { n: d.attemptsLeft }) : "";
        return setErr("totp-err",
          d.reused ? t("รหัสนี้ถูกใช้ไปแล้ว — รอรหัสถัดไปในแอป")
          : t("รหัสไม่ถูกต้อง") + left);
      }
      localStorage.setItem(TOKEN_KEY, d.token);
      pendingTotp = "";
      user = d.user;
      afterSignIn();
    } catch { setErr("totp-err", t("เชื่อมต่อ API ไม่ได้")); }
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
        ? t("ไม่พบ Space ที่ค้นหา")
        : t("ยังไม่มี Space — กด “＋ สร้าง Space” หรือกรอกรหัสเชิญด้านบน");
      grid.appendChild(p);
      return;
    }
    for (const s of list) {
      const card = document.createElement("div");
      card.className = "sp-card";
      const thumb = document.createElement("div");
      thumb.className = "sp-thumb";
      thumb.textContent = initial(s.name);
      thumb.title = t("เข้า Space นี้");
      thumb.onclick = () => enterSpace(s);
      const foot = document.createElement("div");
      foot.className = "sp-card-foot";
      const nm = document.createElement("div");
      nm.className = "sp-name";
      const b = document.createElement("b"); b.textContent = s.name;
      const sm = document.createElement("small");
      sm.textContent = roleLabel(s.role) + (s.members ? " " + t("· {n} คน", { n: s.members }) : "");
      nm.append(b, sm);
      const menu = document.createElement("button");
      menu.className = "sp-menu-btn";
      menu.textContent = "⋮";
      menu.title = t("ตั้งค่า / สมาชิก");
      menu.onclick = (e) => { e.stopPropagation(); void openSettings(s); };
      foot.append(nm, menu);
      card.append(thumb, foot);
      grid.appendChild(card);
    }
  };

  const enterSpace = (s: Space) => {
    // cache under the TARGET slug — we're still on the previous workspace's page here
    localStorage.setItem(wsKeyFor(s.slug, "nexspace-ws-name"), s.name);
    if (s.theme) rememberTheme(s.slug, s.theme);
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
    } catch { setErr("sp-err", t("โหลดรายการ Space ไม่ได้")); }
  };

  $("sp-search")!.oninput = renderSpaces;

  $("sp-create")!.onclick = () => startWizard($<HTMLInputElement>("sp-newname")?.value.trim() ?? "");

  // ------------------------------------------------------ create-space wizard
  type Step =
    | { key: "role" | "companySize" | "useCase"; q: string; opts: string[]; other?: boolean }
    | { key: "theme"; q: string }
    | { key: "name"; q: string };

  const STEPS: Step[] = [
    { key: "role", q: t("บทบาทของคุณตรงกับข้อไหนมากที่สุด?"),
      opts: [t("ผู้ก่อตั้ง"), t("ผู้บริหาร"), t("ผู้อำนวยการ"), t("ผู้จัดการ"), t("สมาชิกทีม")] },
    { key: "companySize", q: t("บริษัทของคุณมีขนาดเท่าไหร่?"),
      opts: ["1 - 10", "11 - 50", "51+"] },
    { key: "useCase", q: t("คุณจะใช้ออฟฟิศเสมือนนี้เป็นหลักอย่างไร?"), other: true,
      opts: [t("พื้นที่ทำงานประจำวันของทีม"), t("พื้นที่ทำงานสัปดาห์ละ 1-2 ครั้ง"),
             t("อีเวนต์ครั้งเดียว (เช่น Hackathon)"), t("อีเวนต์ประจำ (เช่น Workshop)"), t("อื่น ๆ (ระบุ)")] },
    // asked here and only here: the layout decides where the desks are, and
    // changing it later would cancel every desk the team had claimed
    { key: "theme", q: t("เลือกแผนผังออฟฟิศของคุณ") },
    { key: "name", q: t("ตั้งชื่อ Space ของคุณ") },
  ];

  const answers: Record<string, string> = {};
  const otherKey = (key: string) => `${key}__other`;
  const isOther = (v: string) => v.startsWith(t("อื่น ๆ"));
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
    // a tall step (the theme previews) can leave the body scrolled past the
    // question, so every step starts at the top
    const body = document.querySelector<HTMLElement>(".wiz-body");
    if (body) body.scrollTop = 0;
    e.bar.style.width = `${(stepIx / STEPS.length) * 100}%`;
    e.q.textContent = step.q;
    e.back.style.visibility = stepIx === 0 ? "hidden" : "visible";
    e.opts.innerHTML = "";
    e.other.style.display = "none";
    e.other.value = "";

    if (step.key === "theme") {
      // defaulted at render, not in startWizard: pre-answering it there would
      // make the skip-what-is-already-answered loop jump straight past this step
      if (!answers.theme) answers.theme = "classic";
      e.next.textContent = t("ถัดไป →");
      const row = document.createElement("div");
      row.className = "wiz-themes";
      for (const [id, theme] of Object.entries(THEMES)) {
        const card = document.createElement("button");
        card.className = "wiz-theme" + (answers.theme === id ? " on" : "");
        const shot = document.createElement("span");
        shot.className = "wiz-shot";     // shimmering until the preview is drawn
        const name = document.createElement("b");
        name.textContent = t(theme.label);
        card.append(shot, name);
        card.onclick = () => {
          answers.theme = id;
          row.querySelectorAll(".wiz-theme").forEach((x) => x.classList.remove("on"));
          card.classList.add("on");
        };
        row.appendChild(card);

        // drawn from the theme's own data, so it can never show a stale layout
        void renderThemePreview(theme, 360).then((canvas) => {
          if (!shot.isConnected) return; // stepped away before it finished
          shot.appendChild(canvas);
          card.classList.add("ready");
        }).catch(() => card.classList.add("ready"));
      }
      e.opts.appendChild(row);
      const note = document.createElement("p");
      note.style.cssText = "margin:14px 0 0;font-size:12.5px;color:#8a8f98;line-height:1.6";
      note.textContent = t("ทุกคนใน Space จะใช้แผนผังนี้ร่วมกัน และเลือกได้เฉพาะตอนสร้างเท่านั้น");
      e.opts.appendChild(note);
      e.next.disabled = false;
      return;
    }

    if (step.key === "name") {
      // final step: name + guest access
      const input = document.createElement("input");
      input.type = "text";
      input.id = "wiz-name";
      input.placeholder = t("เช่น บริษัท A");
      input.value = answers.name ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dfe1e6;border-radius:10px;font-size:14px;outline:none";
      input.oninput = () => { answers.name = input.value.trim(); e.next.disabled = !answers.name; };
      const label = document.createElement("label");
      label.className = "wiz-check";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = allowGuests;
      cb.onchange = () => (allowGuests = cb.checked);
      label.append(cb, document.createTextNode(t("ให้คนที่ไม่ได้สมัครสมาชิก (Guest) เข้าได้")));
      e.opts.append(input, label);
      e.next.textContent = t("สร้าง Space");
      e.next.disabled = !answers.name;
      input.focus();
      return;
    }

    e.next.textContent = t("ถัดไป →");
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
    if (step.key === "theme") { stepIx++; return renderStep(); }
    if (step.key !== "name") {
      // keep the typed detail next to the chosen label so Back can restore both
      if (wizEls().other.style.display !== "none") {
        answers[otherKey(step.key)] = wizEls().other.value.trim();
      }
      stepIx++;
      return renderStep();
    }
    if (!answers.name) return setErr("wiz-err", t("ใส่ชื่อ Space ก่อน"));
    const btn = wizEls().next;
    btn.disabled = true;
    setErr("wiz-err", "");
    try {
      const r = await fetch(`${API}/workspaces`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({
          name: answers.name, allowGuests, theme: answers.theme || "classic",
          role: answers.role, companySize: answers.companySize,
          // an "other" pick is reported as what they actually typed
          useCase: isOther(answers.useCase ?? "")
            ? (answers[otherKey("useCase")] || answers.useCase)
            : answers.useCase,
        }),
      });
      const d = await r.json();
      if (!r.ok) { btn.disabled = false; return setErr("wiz-err", d.error || t("สร้างไม่สำเร็จ")); }
      wizEls().bar.style.width = "100%";
      enterSpace(d.workspace);
    } catch { btn.disabled = false; setErr("wiz-err", t("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")); }
  };

  $("sp-join")!.onclick = async () => {
    const code = $<HTMLInputElement>("sp-code")?.value.trim() ?? "";
    if (!code) return setErr("sp-err", t("ใส่รหัสเชิญก่อน"));
    setErr("sp-err", "");
    try {
      const r = await fetch(`${API}/workspaces/join`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (!r.ok) return setErr("sp-err", d.error === "workspace not found" ? t("ไม่พบรหัสเชิญนี้") : (d.error || t("เข้าร่วมไม่สำเร็จ")));
      enterSpace(d.workspace);
    } catch { setErr("sp-err", t("เชื่อมต่อ API ไม่ได้")); }
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
        d.error === "invalid code" ? t("รหัสไม่ถูกต้อง")
        : d.error === "already enabled" ? t("เปิดใช้งานอยู่แล้ว")
        : d.error === "start setup first" ? t("เริ่มขั้นตอนตั้งค่าใหม่อีกครั้ง")
        : d.error || t("ทำรายการไม่สำเร็จ"));
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
    setErr("sec-err", t("คัดลอกรหัสแล้ว"));
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
    setErr("sec-err", t("คัดลอกรหัสสำรองแล้ว"));
  };

  $("sec-codes-save")!.onclick = () => {
    const text = t("รหัสสำรอง NexSpace — {email}", { email: user?.email ?? "" }) + "\n"
      + t("ใช้ได้รหัสละ 1 ครั้ง เมื่อไม่มีแอป Authenticator") + "\n\n" + secCodes.join("\n") + "\n";
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
    if (!code) return setErr("sec-err", t("กรอกรหัสเพื่อยืนยัน"));
    try {
      applyUser((await secCall("disable", { code })).user);
      setSecState("off");
    } catch (e) { setErr("sec-err", (e as Error).message); }
  };

  $("sec-regen")!.onclick = async () => {
    const code = $<HTMLInputElement>("sec-ask")?.value.trim() ?? "";
    if (!code) return setErr("sec-err", t("กรอกรหัสเพื่อยืนยัน"));
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

  // the member list and its per-row permission menu live in memberPanel so the
  // in-room settings sidebar can mount the very same thing
  const openMembers = (slug: string) => {
    mountMemberPanel({
      host: $("wm-members")!,
      slug,
      onCount: (n) => { $("wm-count")!.textContent = String(n); },
      onMyRole: (r) => { myRole = r; applyRolePermissions(); },
      onSelfRemoved: () => { closeModal(); void showSpaces(); },
    });
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
    $("wm-sub")!.textContent = t("ลิงก์: ?w={slug}", { slug: s.slug });
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
    openMembers(s.slug);
  };

  $("wm-close")!.onclick = closeModal;
  $("ws-modal")!.onclick = (e) => { if (e.target === $("ws-modal")) closeModal(); };

  $("wm-copy")!.onclick = async () => {
    const v = $<HTMLInputElement>("wm-invite")!.value;
    try { await navigator.clipboard.writeText(v); $("wm-copy")!.textContent = t("คัดลอกแล้ว"); }
    catch { /* ignore */ }
    setTimeout(() => ($("wm-copy")!.textContent = t("คัดลอก")), 1500);
  };

  $("wm-reset")!.onclick = async () => {
    if (!editing || !confirm(t("สร้างรหัสเชิญใหม่? ลิงก์เดิมจะใช้ไม่ได้"))) return;
    const r = await fetch(`${API}/workspaces/${editing.slug}/invite/reset`, { method: "POST", headers: authHeaders() });
    const d = await r.json();
    if (r.ok) setErr("wm-err", t("สร้างรหัสเชิญใหม่แล้ว"));
    else setErr("wm-err", d.error || t("รีเซ็ตไม่สำเร็จ"));
  };

  $("wm-leave")!.onclick = async () => {
    if (!editing || !confirm(t("ออกจาก workspace นี้?"))) return;
    const me = (await (await fetch(`${API}/workspaces/${editing.slug}/members`, { headers: authHeaders() })).json())
      .members?.find((m: PanelMember) => m.isMe);
    if (!me) return;
    const r = await fetch(`${API}/workspaces/${editing.slug}/members/${me.id}`, { method: "DELETE", headers: authHeaders() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setErr("wm-err", d.error === "the owner cannot be removed" ? t("เจ้าของออกเองไม่ได้") : (d.error || t("ออกไม่สำเร็จ")));
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
    if (!r.ok) return setErr("wm-err", d.error || t("บันทึกไม่สำเร็จ"));
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

  /**
   * A ?g= link names its visitor, so greet them with that name rather than
   * "Guest" — the room's name tag then matches the row in จัดการแขก that let
   * them in, which is what makes the visit list worth reading.
   */
  let guestPass: { name: string; state: string } | null = null;
  const loadGuestPass = async () => {
    if (!GUEST_CODE) return;
    try {
      const r = await fetch(`${API}/guest-pass/${encodeURIComponent(GUEST_CODE)}`);
      if (!r.ok) return;
      const d = await r.json();
      guestPass = { name: String(d.name ?? ""), state: String(d.state ?? "") };
      const note = $("a-guest");
      if (note && guestPass.state === "active") note.textContent = t("เข้าเป็นผู้เยี่ยมชม — {name}", { name: guestPass.name });
      else if (guestPass.state) setErr("auth-err", t("บัตรผู้เยี่ยมชมนี้ใช้ไม่ได้แล้ว — ขอลิงก์ใหม่จากผู้ดูแล"));
    } catch { /* the room join is the real gate; a failed lookup only costs the name */ }
  };

  const toChar = (u: User | null) => {
    if (u?.avatar?.lpc) { customConfig = u.avatar.lpc; selected = encodeAvatar(u.avatar.lpc); setCustomThumb(u.avatar.lpc); }
    else { void defaultDressedConfig().then(setCustomThumb); }
    if (u?.avatar?.avatarId && !u?.avatar?.lpc) selected = u.avatar.avatarId;
    showStep("char-step");
    const hello = $("char-hello");
    const pass = !u && guestPass?.state === "active" ? guestPass : null;
    if (hello) hello.textContent = u ? t("สวัสดี {name}", { name: u.name }) : pass ? t("ผู้เยี่ยมชม · {name}", { name: pass.name }) : t("โหมด Guest");
    if (cName) cName.value = u?.name ?? pass?.name ?? "";
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
    if (!token()) { showStep("auth-step"); return void loadGuestPass(); }
    try {
      const r = await fetch(`${API}/me`, { headers: authHeaders() });
      if (!r.ok) { localStorage.removeItem(TOKEN_KEY); return showStep("auth-step"); }
      user = (await r.json()).user;
      afterSignIn();
    } catch { showStep("auth-step"); } // offline -> let them sign in / go guest
  })();
}
