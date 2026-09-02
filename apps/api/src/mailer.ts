import nodemailer from "nodemailer";

// SMTP is optional. Without it the API still works — sign-in codes are printed
// to the server log instead of emailed, which is what you want in development.
const HOST = process.env.SMTP_HOST || "";
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";
const FROM = process.env.SMTP_FROM || USER || "NexSpace <no-reply@nexspace.local>";

export const mailEnabled = !!(HOST && USER && PASS);

/**
 * Bounded, on purpose.
 *
 * Without these, an SMTP port that is filtered rather than refused leaves the
 * socket hanging until something upstream gives up — nginx at sixty seconds,
 * answering the browser with an HTML gateway error. The caller then reports
 * "the invitation failed" for an invitation that was created perfectly well and
 * only lacked an email, which is the one thing it is designed to survive.
 *
 * Ten seconds is far longer than a working relay ever needs and far shorter
 * than any proxy in front of us.
 */
const transporter = mailEnabled
  ? nodemailer.createTransport({
      host: HOST, port: PORT, secure: PORT === 465,
      auth: { user: USER, pass: PASS },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    })
  : null;

/**
 * Is the relay actually reachable, and does it accept these credentials?
 *
 * Answered without sending anything, so it can be asked from a health check.
 * Distinguishes the three things that look identical from the outside: no
 * configuration, a port that never answers, and a password that is wrong.
 */
export async function mailCheck(): Promise<{ ok: boolean; detail: string }> {
  if (!transporter) return { ok: false, detail: "SMTP is not configured" };
  try {
    await transporter.verify();
    return { ok: true, detail: `${HOST}:${PORT} accepted the credentials` };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const hint = err.code === "ETIMEDOUT" || err.code === "ESOCKET"
      ? " — the port never answered, which usually means outbound SMTP is blocked from this host"
      : err.code === "EAUTH" ? " — the credentials were refused"
      : "";
    return { ok: false, detail: `${err.code || "error"}: ${err.message || String(e)}${hint}` };
  }
}

/** somebody's name and a space's name both go into HTML, and both are typed by hand */
const esc = (v: string) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export async function sendLoginCode(to: string, code: string) {
  if (!transporter) {
    console.log(`[mail] SMTP not configured — sign-in code for ${to}: ${code}`);
    return;
  }
  await transporter.sendMail({
    from: FROM,
    to,
    subject: `${code} คือรหัสเข้าสู่ระบบ NexSpace`,
    text: `รหัสเข้าสู่ระบบของคุณคือ ${code}\nรหัสนี้ใช้ได้ 10 นาที หากคุณไม่ได้ร้องขอ ให้ละเว้นอีเมลนี้`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:420px;margin:0 auto;padding:28px 24px;color:#1c1b22">
        <h2 style="margin:0 0 6px;font-size:19px">เข้าสู่ระบบ NexSpace</h2>
        <p style="margin:0 0 20px;color:#6b7280;font-size:14px">กรอกรหัส 6 หลักนี้ในหน้าเข้าสู่ระบบ</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:9px;text-align:center;
                    padding:16px;border-radius:12px;background:#f2f3f6;color:#2bb3a3">${code}</div>
        <p style="margin:20px 0 0;color:#8a8f98;font-size:12.5px">
          รหัสใช้ได้ 10 นาที · หากคุณไม่ได้ร้องขอ ให้ละเว้นอีเมลนี้
        </p>
      </div>`,
  });
}

/**
 * "Come and join us."
 *
 * Plain about three things, because an invitation somebody was not expecting is
 * indistinguishable from a phishing attempt: who asked, which space, and that
 * the link only works for this address. The link expires, and the mail says so
 * — a link with no stated life is one people sit on for a month and then report
 * as broken.
 */
export async function sendInvite(opts: {
  to: string;
  space: string;
  invitedBy: string;
  link: string;
  days: number;
}) {
  const { to, space, invitedBy, link, days } = opts;
  const subject = `${invitedBy} เชิญคุณเข้าร่วม ${space} บน NexSpace`;
  const lines = [
    `${invitedBy} เชิญคุณเข้าร่วมพื้นที่ทำงาน "${space}" บน NexSpace`,
    ``,
    `เปิดลิงก์นี้เพื่อเข้าร่วม: ${link}`,
    ``,
    `ลิงก์นี้ใช้ได้กับอีเมล ${to} เท่านั้น และหมดอายุใน ${days} วัน`,
    `หากคุณไม่รู้จักผู้เชิญ ให้ละเว้นอีเมลนี้ — ไม่มีอะไรเกิดขึ้นถ้าคุณไม่กด`,
  ];
  if (!transporter) {
    console.log(`[mail] SMTP not configured — invitation for ${to} not sent. Link: ${link}`);
    return false;
  }
  await transporter.sendMail({
    from: FROM,
    to,
    subject,
    text: lines.join("\n"),
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:460px;margin:0 auto;padding:28px 24px;color:#1c1b22">
        <h2 style="margin:0 0 6px;font-size:19px">${esc(invitedBy)} เชิญคุณเข้าร่วม ${esc(space)}</h2>
        <p style="margin:0 0 22px;color:#6b7280;font-size:14px">
          พื้นที่ทำงานเสมือนบน NexSpace — เดินไปคุยกับเพื่อนร่วมงานได้เหมือนอยู่ออฟฟิศเดียวกัน
        </p>
        <a href="${esc(link)}" style="display:block;text-align:center;text-decoration:none;
           padding:13px;border-radius:11px;background:#2bb3a3;color:#fff;font-weight:600;font-size:15px">
          เข้าร่วม ${esc(space)}
        </a>
        <p style="margin:22px 0 0;color:#8a8f98;font-size:12.5px;line-height:1.6">
          ลิงก์นี้ใช้ได้กับอีเมล <b>${esc(to)}</b> เท่านั้น และหมดอายุใน ${days} วัน<br>
          หากคุณไม่รู้จักผู้เชิญ ให้ละเว้นอีเมลนี้ — ไม่มีอะไรเกิดขึ้นถ้าคุณไม่กด
        </p>
      </div>`,
  });
  return true;
}
