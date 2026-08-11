import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "./db";

const SESSION_DAYS = 7;
/** a sign-in waiting on its authenticator code is short-lived on purpose */
const PENDING_MINUTES = 10;

const sessionExpiry = (pending: boolean) =>
  new Date(Date.now() + (pending ? PENDING_MINUTES * 6e4 : SESSION_DAYS * 864e5));

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

/**
 * `pendingTotp` marks a half-finished sign-in: the first factor passed but the
 * authenticator code has not been given yet. Such a token is rejected by
 * requireAuth and is only accepted by /auth/totp/verify.
 */
export async function createSession(userId: string, pendingTotp = false) {
  const token = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: { token, userId, pendingTotp, expiresAt: sessionExpiry(pendingTotp) },
  });
  return token;
}

/** promote a pending session to a full one once the second factor checks out */
export async function activateSession(token: string) {
  await prisma.session.update({
    where: { token },
    data: { pendingTotp: false, totpAttempts: 0, expiresAt: sessionExpiry(false) },
  });
}

/** the session row itself, pending or not — only the 2FA step should use this */
export async function sessionFromToken(token?: string) {
  if (!token) return null;
  const s = await prisma.session.findUnique({ where: { token }, include: { user: true } });
  if (!s) return null;
  if (s.expiresAt < new Date()) { await prisma.session.delete({ where: { token } }).catch(() => {}); return null; }
  return s;
}

export async function userFromToken(token?: string) {
  const s = await sessionFromToken(token);
  if (!s || s.pendingTotp) return null; // half-finished sign-in authorises nothing
  return s.user;
}

// augment Express Request with the authed user.
// Carry the whole row apart from the secrets — cherry-picking columns here meant
// new fields silently arrived as undefined in /me. totpSecret is dropped because
// it alone can mint valid codes; handlers that need it re-read the row.
// recoveryCodes stays because it holds bcrypt hashes, and /me reports how many
// are left — it is never serialised as-is.
type AuthedUser = Omit<
  NonNullable<Awaited<ReturnType<typeof userFromToken>>>,
  "passwordHash" | "totpSecret"
>;

export interface AuthedRequest extends Request {
  user?: AuthedUser;
}

/** how stale lastSeenAt may get before an authed request refreshes it */
const SEEN_REFRESH_MS = 5 * 60 * 1000;

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const user = await userFromToken(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { passwordHash: _pw, totpSecret: _s, ...safe } = user;
  req.user = safe;
  // "Last active" in the member list, without a write on every single request
  if (!user.lastSeenAt || Date.now() - user.lastSeenAt.getTime() > SEEN_REFRESH_MS) {
    prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
      .catch(() => {}); // never fail a request over presence bookkeeping
  }
  next();
}
