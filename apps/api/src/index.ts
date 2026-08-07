import "dotenv/config";
import express from "express";
import cors from "cors";
import { prisma } from "./db";
import { hashPassword, verifyPassword, createSession, requireAuth, userFromToken, type AuthedRequest } from "./auth";
import { sendLoginCode, mailEnabled } from "./mailer";

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

const safeUser = (u: {
  id: string; email: string; name: string; avatar: string | null;
  desk?: string | null; photoUrl?: string | null; role?: string | null; companySize?: string | null;
}) => ({
  id: u.id, email: u.email, name: u.name,
  avatar: u.avatar ? JSON.parse(u.avatar) : null,
  desks: parseDesks(u.desk),
  photoUrl: u.photoUrl ?? null,
  role: u.role ?? null,          // onboarding answers, used to prefill the wizard
  companySize: u.companySize ?? null,
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
  // accounts created via email code / Google have no password to check against
  if (!user || !user.passwordHash || !(await verifyPassword(password ?? "", user.passwordHash)))
    return res.status(401).json({ error: "invalid credentials" });
  const token = await createSession(user.id);
  res.json({ token, user: safeUser(user) });
});

// ---- sign in with a 6-digit email code ----
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();

app.get("/auth/config", (_req, res) =>
  res.json({ google: googleEnabled, mail: mailEnabled }));

app.post("/auth/code/request", async (req, res) => {
  const email = normEmail((req.body ?? {}).email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "invalid email" });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.loginCode.deleteMany({ where: { email } }); // only the newest code is valid
  await prisma.loginCode.create({
    data: { email, codeHash: await hashPassword(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  try {
    await sendLoginCode(email, code);
  } catch (e) {
    console.error("[auth] failed to send code:", e);
    return res.status(502).json({ error: "could not send email" });
  }
  res.json({ ok: true, delivered: mailEnabled });
});

app.post("/auth/code/verify", async (req, res) => {
  const email = normEmail((req.body ?? {}).email);
  const code = String((req.body ?? {}).code ?? "").trim();
  const row = await prisma.loginCode.findFirst({ where: { email }, orderBy: { createdAt: "desc" } });
  if (!row) return res.status(400).json({ error: "no code requested" });
  if (row.expiresAt < new Date()) {
    await prisma.loginCode.deleteMany({ where: { email } });
    return res.status(400).json({ error: "code expired" });
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    await prisma.loginCode.deleteMany({ where: { email } });
    return res.status(429).json({ error: "too many attempts" });
  }
  if (!(await verifyPassword(code, row.codeHash))) {
    await prisma.loginCode.update({ where: { id: row.id }, data: { attempts: row.attempts + 1 } });
    return res.status(401).json({ error: "invalid code" });
  }
  await prisma.loginCode.deleteMany({ where: { email } }); // single use
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: email.split("@")[0] },
  });
  res.json({ token: await createSession(user.id), user: safeUser(user) });
});

// ---- sign in with Google ----
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const googleEnabled = !!(GOOGLE_ID && GOOGLE_SECRET);

/** where Google sends the user back — same origin as the app, proxied to this API */
const redirectUri = (req: express.Request) =>
  process.env.OAUTH_REDIRECT_URL ||
  `${(req.header("x-forwarded-proto") || req.protocol)}://${req.header("x-forwarded-host") || req.get("host")}/auth/google/callback`;

/** where to hand the token back to the web app */
const appUrl = (req: express.Request) =>
  process.env.APP_URL ||
  `${(req.header("x-forwarded-proto") || req.protocol)}://${req.header("x-forwarded-host") || req.get("host")}/`;

app.get("/auth/google", (req, res) => {
  if (!googleEnabled) return res.status(501).send("Google sign-in is not configured");
  const params = new URLSearchParams({
    client_id: GOOGLE_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    state: String(req.query.w || ""), // carry the workspace slug through the round trip
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/auth/google/callback", async (req, res) => {
  if (!googleEnabled) return res.status(501).send("Google sign-in is not configured");
  const back = appUrl(req);
  const ws = String(req.query.state || "");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code || ""),
        client_id: GOOGLE_ID,
        client_secret: GOOGLE_SECRET,
        redirect_uri: redirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    const tok = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tok.access_token) throw new Error(tok.error || "token exchange failed");

    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const info = (await infoRes.json()) as { sub?: string; email?: string; name?: string; picture?: string };
    const email = normEmail(info.email);
    if (!email) throw new Error("google account has no email");

    // link by email so an existing account keeps its workspaces and avatar
    const user = await prisma.user.upsert({
      where: { email },
      update: { googleId: info.sub, photoUrl: info.picture },
      create: { email, name: info.name || email.split("@")[0], googleId: info.sub, photoUrl: info.picture },
    });
    const token = await createSession(user.id);
    // hash fragment: the token never lands in server logs or the Referer header
    res.redirect(`${back}${ws ? `?w=${encodeURIComponent(ws)}` : ""}#token=${encodeURIComponent(token)}`);
  } catch (e) {
    console.error("[auth] google sign-in failed:", e);
    res.redirect(`${back}#auth_error=google`);
  }
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

// ---- workspaces ----
// Slugs stay ASCII: they ride in the ?w= URL, key the LiveKit room name, and the
// client normalises to [a-z0-9-] — a Thai slug would be rewritten there and drop
// people into the wrong workspace. Display names keep their original script.
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 32);

const randomCode = () => Math.random().toString(36).slice(2, 10);

/** first free slug: "acme", "acme-2", "acme-3", ... */
async function uniqueSlug(base: string): Promise<string> {
  // a name with no usable ASCII (e.g. "บริษัทเอ") gets a readable random slug
  let root = slugify(base);
  if (root.length < 2) root = `space-${randomCode()}`;
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? root : `${root}-${i}`;
    if (!(await prisma.workspace.findUnique({ where: { slug } }))) return slug;
  }
  return `${root}-${randomCode()}`;
}

const wsView = (w: any, role?: string) => ({
  slug: w.slug, name: w.name, allowGuests: w.allowGuests,
  inviteCode: w.inviteCode, members: w._count?.members ?? undefined, role,
});

// workspaces I belong to
app.get("/workspaces", requireAuth, async (req: AuthedRequest, res) => {
  const rows = await prisma.membership.findMany({
    where: { userId: req.user!.id },
    include: { workspace: { include: { _count: { select: { members: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  res.json({ workspaces: rows.map((m) => wsView(m.workspace, m.role)) });
});

app.post("/workspaces", requireAuth, async (req: AuthedRequest, res) => {
  const { name: rawName, allowGuests: guests, role, companySize, useCase } = req.body ?? {};
  const name = String(rawName ?? "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "name required" });
  const trim = (v: unknown) => (v ? String(v).slice(0, 60) : undefined);

  // the onboarding answers about the person are kept on the account, so creating
  // another space later can skip straight past those questions
  const profile = { role: trim(role), companySize: trim(companySize) };
  if (profile.role || profile.companySize) {
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { ...(profile.role ? { role: profile.role } : {}), ...(profile.companySize ? { companySize: profile.companySize } : {}) },
    });
  }

  const workspace = await prisma.workspace.create({
    data: {
      name, slug: await uniqueSlug(name), inviteCode: randomCode(),
      allowGuests: guests !== false, useCase: trim(useCase), ownerId: req.user!.id,
      members: { create: { userId: req.user!.id, role: "owner" } },
    },
    include: { _count: { select: { members: true } } },
  });
  res.json({ workspace: wsView(workspace, "owner") });
});

// join by invite code (or by slug, for an open workspace)
app.post("/workspaces/join", requireAuth, async (req: AuthedRequest, res) => {
  const { code, slug } = req.body ?? {};
  const workspace = code
    ? await prisma.workspace.findUnique({ where: { inviteCode: String(code).trim() } })
    : await prisma.workspace.findUnique({ where: { slug: String(slug ?? "").trim() } });
  if (!workspace) return res.status(404).json({ error: "workspace not found" });
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId: workspace.id } },
    create: { userId: req.user!.id, workspaceId: workspace.id, role: "member" },
    update: {},
  });
  res.json({ workspace: wsView(workspace, "member") });
});

// public-ish info so an invite link can show the space before you commit to it
app.get("/workspaces/:slug", async (req, res) => {
  const w = await prisma.workspace.findUnique({
    where: { slug: req.params.slug },
    include: { _count: { select: { members: true } } },
  });
  if (!w) return res.status(404).json({ error: "not found" });
  const user = await userFromToken(req.header("authorization")?.replace(/^Bearer\s+/i, ""));
  const membership = user
    ? await prisma.membership.findUnique({
        where: { userId_workspaceId: { userId: user.id, workspaceId: w.id } },
      })
    : null;
  res.json({ workspace: { ...wsView(w, membership?.role), inviteCode: membership ? w.inviteCode : undefined } });
});

// owner/admin settings (rename, toggle guest access)
app.patch("/workspaces/:slug", requireAuth, async (req: AuthedRequest, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId: w.id } },
  });
  if (!m || (m.role !== "owner" && m.role !== "admin")) return res.status(403).json({ error: "forbidden" });
  const { name, allowGuests } = req.body ?? {};
  const updated = await prisma.workspace.update({
    where: { id: w.id },
    data: {
      ...(typeof name === "string" && name.trim() ? { name: name.trim().slice(0, 60) } : {}),
      ...(typeof allowGuests === "boolean" ? { allowGuests } : {}),
    },
    include: { _count: { select: { members: true } } },
  });
  res.json({ workspace: wsView(updated, m.role) });
});

/** members of a workspace (any member may see the roster) */
app.get("/workspaces/:slug/members", requireAuth, async (req: AuthedRequest, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const me = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId: w.id } },
  });
  if (!me) return res.status(403).json({ error: "forbidden" });
  const rows = await prisma.membership.findMany({
    where: { workspaceId: w.id },
    include: { user: { select: { id: true, name: true, email: true, photoUrl: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json({
    myRole: me.role,
    members: rows.map((m) => ({
      id: m.user.id, name: m.user.name, email: m.user.email,
      photoUrl: m.user.photoUrl, role: m.role, isMe: m.user.id === req.user!.id,
    })),
  });
});

/** change a member's role (owner only; the owner's own role is fixed) */
app.patch("/workspaces/:slug/members/:userId", requireAuth, async (req: AuthedRequest, res) => {
  const role = String((req.body ?? {}).role ?? "");
  if (!["admin", "member"].includes(role)) return res.status(400).json({ error: "invalid role" });
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  if (w.ownerId !== req.user!.id) return res.status(403).json({ error: "owner only" });
  if (req.params.userId === w.ownerId) return res.status(400).json({ error: "cannot change the owner" });
  await prisma.membership.update({
    where: { userId_workspaceId: { userId: req.params.userId, workspaceId: w.id } },
    data: { role },
  });
  res.json({ ok: true });
});

/** remove a member, or leave the workspace yourself */
app.delete("/workspaces/:slug/members/:userId", requireAuth, async (req: AuthedRequest, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const me = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId: w.id } },
  });
  if (!me) return res.status(403).json({ error: "forbidden" });
  const target = req.params.userId;
  const removingSelf = target === req.user!.id;
  const canManage = me.role === "owner" || me.role === "admin";
  if (!removingSelf && !canManage) return res.status(403).json({ error: "forbidden" });
  if (target === w.ownerId) return res.status(400).json({ error: "the owner cannot be removed" });
  await prisma.membership.delete({
    where: { userId_workspaceId: { userId: target, workspaceId: w.id } },
  });
  res.json({ ok: true });
});

/** roll a new invite code (owner/admin) — revokes links already handed out */
app.post("/workspaces/:slug/invite/reset", requireAuth, async (req: AuthedRequest, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const me = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId: w.id } },
  });
  if (!me || (me.role !== "owner" && me.role !== "admin")) return res.status(403).json({ error: "forbidden" });
  const updated = await prisma.workspace.update({ where: { id: w.id }, data: { inviteCode: randomCode() } });
  res.json({ inviteCode: updated.inviteCode });
});

/** used by the game server to authorise a room join (members, or guests if allowed) */
app.get("/workspaces/:slug/access", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.json({ allowed: false, reason: "not-found" });
  const user = await userFromToken(String(req.query.token || "") || undefined);
  if (!user) return res.json({ allowed: w.allowGuests, reason: w.allowGuests ? "guest" : "members-only", name: w.name });
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId: w.id } },
  });
  if (m) return res.json({ allowed: true, reason: "member", name: w.name });
  // logged in but not a member yet — treat like a guest visit
  res.json({ allowed: w.allowGuests, reason: w.allowGuests ? "guest" : "members-only", name: w.name });
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
