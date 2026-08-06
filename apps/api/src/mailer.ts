import nodemailer from "nodemailer";

// SMTP is optional. Without it the API still works — sign-in codes are printed
// to the server log instead of emailed, which is what you want in development.
const HOST = process.env.SMTP_HOST || "";
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";
const FROM = process.env.SMTP_FROM || USER || "NexSpace <no-reply@nexspace.local>";

export const mailEnabled = !!(HOST && USER && PASS);

const transporter = mailEnabled
  ? nodemailer.createTransport({ host: HOST, port: PORT, secure: PORT === 465, auth: { user: USER, pass: PASS } })
  : null;

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
