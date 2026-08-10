// Authenticator-app sign-in (TOTP, RFC 6238) — Google Authenticator, Authy,
// Microsoft Authenticator, 1Password and friends all speak the same otpauth:// URI.
import { randomInt } from "crypto";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { hashPassword, verifyPassword } from "./auth";

/** shown as the account name inside the authenticator app */
export const TOTP_ISSUER = process.env.TOTP_ISSUER || "NexSpace";

export const newTotpSecret = () => generateSecret();

export const otpauthUri = (secret: string, email: string) =>
  generateURI({ issuer: TOTP_ISSUER, label: email, secret });

/** data: URI so the QR renders with no external request and no extra endpoint */
export const qrDataUrl = (uri: string) =>
  QRCode.toDataURL(uri, { margin: 1, width: 232, errorCorrectionLevel: "M" });

export type TotpCheck =
  | { valid: true; timeStep: number }
  | { valid: false; reused: boolean };

/**
 * otplib measures epochTolerance in SECONDS, not in 30s steps — passing `1` looks
 * like "±1 step" but really means ±1 second, which almost never reaches the
 * neighbouring code and leaves no room for clock drift at all. One full period
 * gives the usual ±1 step window.
 */
const DRIFT_SECONDS = 30;

/**
 * Verify a 6-digit code.
 *
 * `afterTimeStep` rejects any step already spent, so a code read over someone's
 * shoulder is useless even inside its own 30s window — we re-check without it
 * purely to tell "already used" apart from "wrong". verify() reports the step it
 * actually matched (not the current one), which is what makes recording it work.
 */
export async function checkTotp(
  secret: string,
  token: unknown,
  lastStep?: number | null,
): Promise<TotpCheck> {
  const t = String(token ?? "").replace(/\D/g, "");
  if (t.length !== 6) return { valid: false, reused: false };
  const r = await verify({
    secret, token: t, epochTolerance: DRIFT_SECONDS, afterTimeStep: lastStep ?? undefined,
  });
  if (r.valid) return { valid: true, timeStep: (r as { timeStep: number }).timeStep };
  if (lastStep == null) return { valid: false, reused: false };
  const again = await verify({ secret, token: t, epochTolerance: DRIFT_SECONDS });
  return { valid: false, reused: again.valid };
}

// ---- recovery codes ----
// A lost phone would otherwise lock the account out for good: there is no admin
// tool to clear 2FA. Eight single-use codes are shown once at enrolment.
export const RECOVERY_COUNT = 8;
const RC_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no i/l/o/0/1 — read aloud safely

export const newRecoveryCodes = () =>
  Array.from({ length: RECOVERY_COUNT }, () => {
    const s = Array.from({ length: 10 }, () => RC_ALPHABET[randomInt(RC_ALPHABET.length)]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`; // 31^10 ≈ 2^49 — well past guessing
  });

const normRecovery = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export const hashRecoveryCodes = async (codes: string[]) =>
  JSON.stringify(await Promise.all(codes.map((c) => hashPassword(normRecovery(c)))));

export const countRecoveryCodes = (json: string | null | undefined) => {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.length : 0;
  } catch { return 0; }
};

/**
 * Consume one recovery code. Returns the remaining hashes as JSON on a match
 * (single use), or null when nothing matched.
 */
export async function spendRecoveryCode(json: string | null | undefined, input: unknown) {
  const given = normRecovery(input);
  if (given.length !== 10) return null;
  let hashes: unknown;
  try { hashes = JSON.parse(json || "[]"); } catch { return null; }
  if (!Array.isArray(hashes)) return null;
  for (let i = 0; i < hashes.length; i++) {
    if (typeof hashes[i] === "string" && (await verifyPassword(given, hashes[i]))) {
      return JSON.stringify(hashes.filter((_, j) => j !== i));
    }
  }
  return null;
}
