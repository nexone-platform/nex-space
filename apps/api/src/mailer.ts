import nodemailer from "nodemailer";

/**
 * Getting an email out of this deployment.
 *
 * Two ways, because one of them is not always available. Plenty of hosts —
 * this one included — drop outbound connections on every SMTP port to keep
 * compromised boxes from becoming relays, and there is nothing an application
 * can do about it from the inside. Port 443 is never blocked, so a provider's
 * own HTTP API is the way through.
 *
 * `RESEND_API_KEY` therefore wins when it is set. The SMTP settings still work
 * and are still the right answer for a deployment that can reach a relay, or
 * for a provider that offers nothing else.
 *
 * Neither configured is a supported state: sign-in codes go to the log and
 * invitations still exist, carrying a link to pass on by hand.
 */
const HOST = process.env.SMTP_HOST || "";
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
/** MAIL_FROM is the honest name now that the transport may not be SMTP at all */
const FROM = process.env.MAIL_FROM || process.env.SMTP_FROM || USER || "NexSpace <no-reply@nexspace.local>";

const smtpReady = !!(HOST && USER && PASS);
export const mailEnabled = !!RESEND_KEY || smtpReady;
/** which way this deployment actually gets mail out, for anything that reports */
export const mailTransport = RESEND_KEY ? "resend-api" : smtpReady ? "smtp" : "none";

/** the same ceiling both ways: far longer than a working relay, far shorter than any proxy */
const MAIL_TIMEOUT_MS = 10_000;

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
const transporter = smtpReady
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
  if (RESEND_KEY) {
    // A read, not a send: it proves the key works and that port 443 is open,
    // without putting a message in anybody's inbox.
    try {
      const r = await fetch("https://api.resend.com/domains", {
        headers: { authorization: `Bearer ${RESEND_KEY}` },
        signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
      });
      if (r.ok) return { ok: true, detail: `resend HTTP API accepted the key · sending as ${FROM}` };
      return { ok: false, detail: `resend answered ${r.status} — the API key was refused` };
    } catch (e) {
      return { ok: false, detail: `could not reach api.resend.com: ${(e as Error).message}` };
    }
  }
  if (!transporter) return { ok: false, detail: "no mail transport is configured" };
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

/**
 * What every message here needs, regardless of how it leaves.
 *
 * `replyTo` is optional and worth setting wherever a real person is behind the
 * message. Mail from a no-reply address that cannot be answered is one of the
 * things spam classifiers count against a sender, and it is also just rude.
 */
type Letter = { to: string; subject: string; text: string; html: string; replyTo?: string };

/**
 * Hand it to whichever transport this deployment has.
 *
 * Returns false rather than throwing when there is nowhere to send it: the
 * caller's job is to carry on and say the email did not go, not to fail the
 * thing the email was about.
 */
async function deliver(letter: Letter): Promise<boolean> {
  if (RESEND_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [letter.to], subject: letter.subject, text: letter.text, html: letter.html,
        ...(letter.replyTo ? { reply_to: [letter.replyTo] } : {}),
      }),
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
    });
    if (!r.ok) {
      // Their message names the real problem — an unverified sending domain,
      // usually — and repeating it verbatim beats inventing a summary.
      const said = await r.text().catch(() => "");
      throw new Error(`resend answered ${r.status}: ${said.slice(0, 300)}`);
    }
    return true;
  }
  if (!transporter) return false;
  await transporter.sendMail({ from: FROM, ...letter });
  return true;
}

/** somebody's name and a space's name both go into HTML, and both are typed by hand */
const esc = (v: string) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export async function sendLoginCode(to: string, code: string) {
  if (!mailEnabled) {
    console.log(`[mail] no mail transport configured — sign-in code for ${to}: ${code}`);
    return;
  }
  await deliver({
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
 *
 * The same reasoning is why the destination is printed under the button and why
 * the inviter's own address is the Reply-To. A button whose words are "join" and
 * whose href is a long opaque URL is the shape of every phishing mail ever sent,
 * and a filter that has never heard of this domain has little else to go on.
 * Showing where the link goes, and letting the reader answer a real person, are
 * the two things that separate this from that — for the classifier and for the
 * human reading it.
 */
export async function sendInvite(opts: {
  to: string;
  space: string;
  invitedBy: string;
  /** the inviter's own address, so the reader can just hit reply */
  invitedByEmail?: string;
  link: string;
  days: number;
}) {
  const { to, space, invitedBy, invitedByEmail, link, days } = opts;
  const subject = `${invitedBy} เชิญคุณเข้าร่วม ${space} บน NexSpace`;
  const from = invitedByEmail ? `${invitedBy} (${invitedByEmail})` : invitedBy;
  const lines = [
    `${from} เชิญคุณเข้าร่วมพื้นที่ทำงาน "${space}" บน NexSpace`,
    ``,
    `เปิดลิงก์นี้เพื่อเข้าร่วม:`,
    link,
    ``,
    `ลิงก์นี้ใช้ได้กับอีเมล ${to} เท่านั้น และหมดอายุใน ${days} วัน`,
    `หากคุณไม่รู้จักผู้เชิญ ให้ละเว้นอีเมลนี้ — ไม่มีอะไรเกิดขึ้นถ้าคุณไม่กด`,
    ``,
    `NexSpace — พื้นที่ทำงานเสมือนของทีม · ส่งอัตโนมัติเพราะมีคนกรอกอีเมลนี้เพื่อเชิญคุณ`,
  ];
  if (!mailEnabled) {
    console.log(`[mail] no mail transport configured — invitation for ${to} not sent. Link: ${link}`);
    return false;
  }
  return deliver({
    to,
    subject,
    replyTo: invitedByEmail,
    text: lines.join("\n"),
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:460px;margin:0 auto;padding:28px 24px;color:#1c1b22">
        <h2 style="margin:0 0 6px;font-size:19px">${esc(invitedBy)} เชิญคุณเข้าร่วม ${esc(space)}</h2>
        <p style="margin:0 0 22px;color:#6b7280;font-size:14px">
          พื้นที่ทำงานเสมือนบน NexSpace — เดินไปคุยกับเพื่อนร่วมงานได้เหมือนอยู่ออฟฟิศเดียวกัน${
            invitedByEmail ? `<br>ผู้เชิญ: <b>${esc(invitedBy)}</b> &lt;${esc(invitedByEmail)}&gt;` : ""
          }
        </p>
        <a href="${esc(link)}" style="display:block;text-align:center;text-decoration:none;
           padding:13px;border-radius:11px;background:#2bb3a3;color:#fff;font-weight:600;font-size:15px">
          เข้าร่วม ${esc(space)}
        </a>
        <p style="margin:14px 0 0;color:#8a8f98;font-size:12px;line-height:1.5;word-break:break-all">
          ปุ่มไม่ทำงาน? เปิดลิงก์นี้แทน:<br>
          <a href="${esc(link)}" style="color:#6b7280">${esc(link)}</a>
        </p>
        <p style="margin:20px 0 0;color:#8a8f98;font-size:12.5px;line-height:1.6">
          ลิงก์นี้ใช้ได้กับอีเมล <b>${esc(to)}</b> เท่านั้น และหมดอายุใน ${days} วัน<br>
          หากคุณไม่รู้จักผู้เชิญ ให้ละเว้นอีเมลนี้ — ไม่มีอะไรเกิดขึ้นถ้าคุณไม่กด
        </p>
        <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e8e9ee;
                  color:#a3a7b0;font-size:11.5px;line-height:1.6">
          NexSpace — พื้นที่ทำงานเสมือนของทีม<br>
          ส่งอัตโนมัติเพราะมีคนกรอกอีเมลนี้เพื่อเชิญคุณเข้าทีม
        </p>
      </div>`,
  });
}
