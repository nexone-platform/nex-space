import "dotenv/config";
import express from "express";
import cors from "cors";
import { prisma } from "./db";
import { hashPassword, verifyPassword, createSession, requireAuth, type AuthedRequest } from "./auth";

const port = Number(process.env.PORT) || 3001;
const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" })); // maps can be large

// `desk` is stored as a JSON map of workspace -> deskId, so a desk claimed in one
// workspace doesn't follow the user into another. Older rows hold a bare desk id.
const parseDesks = (raw: string | null | undefined): Record<string, string> => {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v as Record<string, string> : { main: String(v) };
  } catch { return { main: raw }; } // legacy: plain desk id
};

const safeUser = (u: { id: string; email: string; name: string; avatar: string | null; desk?: string | null }) => ({
  id: u.id, email: u.email, name: u.name,
  avatar: u.avatar ? JSON.parse(u.avatar) : null,
  desks: parseDesks(u.desk),
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- auth ----
app.post("/auth/register", async (req, res) => {
  const { email, name, password } = req.body ?? {};
  if (!email || !password || String(password).length < 6)
    return res.status(400).json({ error: "email + password (>=6) required" });
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: "email already registered" });
  const user = await prisma.user.create({
    data: { email, name: name || String(email).split("@")[0], passwordHash: await hashPassword(password) },
  });
  const token = await createSession(user.id);
  res.json({ token, user: safeUser(user) });
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = await prisma.user.findUnique({ where: { email: email ?? "" } });
  if (!user || !(await verifyPassword(password ?? "", user.passwordHash)))
    return res.status(401).json({ error: "invalid credentials" });
  const token = await createSession(user.id);
  res.json({ token, user: safeUser(user) });
});

app.post("/auth/logout", requireAuth, async (req: AuthedRequest, res) => {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (token) await prisma.session.delete({ where: { token } }).catch(() => {});
  res.json({ ok: true });
});

// ---- profile / avatar ----
app.get("/me", requireAuth, (req: AuthedRequest, res) => res.json({ user: safeUser(req.user!) }));

app.put("/me/avatar", requireAuth, async (req: AuthedRequest, res) => {
  const avatar = JSON.stringify(req.body ?? {});
  const user = await prisma.user.update({ where: { id: req.user!.id }, data: { avatar } });
  res.json({ user: safeUser(user) });
});

app.put("/me/desk", requireAuth, async (req: AuthedRequest, res) => {
  const { workspace, desk } = req.body ?? {};
  const ws = String(workspace || "main").slice(0, 32);
  const id = String(desk ?? "").slice(0, 32);
  const desks = parseDesks(req.user!.desk);
  if (id) desks[ws] = id;
  else delete desks[ws];
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { desk: JSON.stringify(desks) },
  });
  res.json({ user: safeUser(user) });
});

// ---- saved maps ----
app.get("/maps", requireAuth, async (req: AuthedRequest, res) => {
  const maps = await prisma.savedMap.findMany({
    where: { ownerId: req.user!.id },
    select: { id: true, name: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  res.json({ maps });
});

app.post("/maps", requireAuth, async (req: AuthedRequest, res) => {
  const { name, data } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  const map = await prisma.savedMap.create({
    data: { name, ownerId: req.user!.id, data: JSON.stringify(data ?? {}) },
  });
  res.json({ id: map.id });
});

app.get("/maps/:id", requireAuth, async (req: AuthedRequest, res) => {
  const map = await prisma.savedMap.findUnique({ where: { id: req.params.id } });
  if (!map || map.ownerId !== req.user!.id) return res.status(404).json({ error: "not found" });
  res.json({ id: map.id, name: map.name, data: JSON.parse(map.data), updatedAt: map.updatedAt });
});

app.put("/maps/:id", requireAuth, async (req: AuthedRequest, res) => {
  const existing = await prisma.savedMap.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.ownerId !== req.user!.id) return res.status(404).json({ error: "not found" });
  const { name, data } = req.body ?? {};
  const map = await prisma.savedMap.update({
    where: { id: req.params.id },
    data: { ...(name ? { name } : {}), ...(data !== undefined ? { data: JSON.stringify(data) } : {}) },
  });
  res.json({ id: map.id, updatedAt: map.updatedAt });
});

app.listen(port, () => console.log(`[api] NexSpace API on http://localhost:${port}  (db: ${process.env.DATABASE_URL})`));
