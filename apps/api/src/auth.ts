import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "./db";

const SESSION_DAYS = 7;

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await prisma.session.create({ data: { token, userId, expiresAt } });
  return token;
}

export async function userFromToken(token?: string) {
  if (!token) return null;
  const s = await prisma.session.findUnique({ where: { token }, include: { user: true } });
  if (!s) return null;
  if (s.expiresAt < new Date()) { await prisma.session.delete({ where: { token } }).catch(() => {}); return null; }
  return s.user;
}

// augment Express Request with the authed user
export interface AuthedRequest extends Request {
  user?: { id: string; email: string; name: string; avatar: string | null; desk: string | null };
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const user = await userFromToken(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  req.user = { id: user.id, email: user.email, name: user.name, avatar: user.avatar, desk: user.desk };
  next();
}
