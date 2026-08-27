import "dotenv/config";
import { randomBytes } from "crypto";
import express from "express";
import cors from "cors";
import { prisma } from "./db";
import {
  hashPassword, verifyPassword, createSession, activateSession, sessionFromToken,
  requireAuth, userFromToken, type AuthedRequest,
} from "./auth";
import { sendLoginCode, mailEnabled } from "./mailer";
import { iceConfig, turnEnabled } from "./ice";
import { mapDocProblem } from "./mapValidate";
import {
  newTotpSecret, otpauthUri, qrDataUrl, checkTotp,
  newRecoveryCodes, hashRecoveryCodes, countRecoveryCodes, spendRecoveryCode,
} from "./totp";

import {
  UPLOAD_MAX_BYTES, absPathFor, accepts, allowedTypes, dropBytes, isImage,
  linkOk, putBytes, relPathFor, safeName, signedPath,
} from "./uploads.js";

const port = Number(process.env.PORT) || 3001;
const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" })); // maps can be large

// Express 4 does not catch rejections thrown inside async handlers: a single
// failing query would take the whole process down, and every request would 502
// until the container restarted. Wrap the handlers once here so failures reach
// the error middleware below instead of killing the server.
for (const method of ["get", "post", "put", "patch", "delete"] as const) {
  const original = app[method].bind(app);
  (app as any)[method] = (path: string, ...handlers: any[]) =>
    original(
      path,
      ...handlers.map((h) => {
        if (typeof h !== "function") return h;
        // Express reads a handler's arity to tell an error handler from an
        // ordinary one, so the wrapper has to keep it. Flattening every
        // handler to three arguments turned a route-level error handler into
        // a normal middleware that received (err, req, res) and called res as
        // next — which is how a 413 came back as a 500.
        if (h.length === 4) {
          return (err: any, req: any, res: any, next: any) =>
            Promise.resolve(h(err, req, res, next)).catch(next);
        }
        return (req: any, res: any, next: any) => Promise.resolve(h(req, res, next)).catch(next);
      }),
    );
}

// last-resort net: log instead of letting Node terminate on a stray rejection
process.on("unhandledRejection", (e) => console.error("[api] unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("[api] uncaught exception:", e));

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
  totpEnabledAt?: Date | null; recoveryCodes?: string | null;
  bio?: string | null; team?: string | null; timezone?: string | null;
}) => ({
  id: u.id, email: u.email, name: u.name,
  bio: u.bio ?? null, team: u.team ?? null, timezone: u.timezone ?? null,
  avatar: u.avatar ? JSON.parse(u.avatar) : null,
  desks: parseDesks(u.desk),
  photoUrl: u.photoUrl ?? null,
  role: u.role ?? null,          // onboarding answers, used to prefill the wizard
  companySize: u.companySize ?? null,
  totpEnabled: !!u.totpEnabledAt,
  recoveryLeft: countRecoveryCodes(u.recoveryCodes),
});

/**
 * Every sign-in path ends here. With an authenticator enrolled the caller gets a
 * pending token that unlocks nothing until /auth/totp/verify accepts a code, and
 * no profile data comes back before that.
 */
async function issueLogin(
  user: { id: string; totpEnabledAt: Date | null },
): Promise<{ token?: string; totpRequired?: true; pendingToken?: string }> {
  if (!user.totpEnabledAt) return { token: await createSession(user.id) };
  return { totpRequired: true, pendingToken: await createSession(user.id, true) };
}

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
  const login = await issueLogin(user);
  res.json(login.token ? { ...login, user: safeUser(user) } : login);
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
  const login = await issueLogin(user);
  res.json(login.token ? { ...login, user: safeUser(user) } : login);
});

// ---- sign in with Google ----
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const googleEnabled = !!(GOOGLE_ID && GOOGLE_SECRET);

/** where Google sends the user back — same origin as the app, proxied to this API */
const redirectUri = (req: express.Request) =>
  process.env.OAUTH_REDIRECT_URL ||
  `${(req.header("x-forwarded-proto") || req.protocol)}://${req.header("x-forwarded-host") || req.get("host")}/auth/google/callback`;

/**
 * Where to hand the token back to the web app.
 *
 * In production nginx serves the app and proxies this API on one host, so the
 * host a request arrived on IS the app. In development they are two origins —
 * the app on 5173, this API on 3001 — and handing the token to the API's own root
 * lands the user on "Cannot GET /" with their session sitting in the URL.
 *
 * So the app says where it is when it starts the flow, and that answer is checked
 * before it is used: a token in a redirect is a session, and an unchecked "send it
 * here" would hand a sign-in to any site that asked. Only the configured app, the
 * host this request came in on, or a loopback address is allowed — the last is the
 * development case, and it can only ever deliver to the user's own machine.
 */
const appUrl = (req: express.Request, wanted?: string) => {
  const derived = `${(req.header("x-forwarded-proto") || req.protocol)}://${req.header("x-forwarded-host") || req.get("host")}/`;
  const allowed = process.env.APP_URL || derived;
  if (!wanted) return allowed;
  try {
    const u = new URL(wanted);
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
    if (loopback || u.origin === new URL(allowed).origin || u.origin === new URL(derived).origin) return u.origin + "/";
    console.warn("[auth] refused to send the token to", u.origin);
  } catch { /* not a URL at all */ }
  return allowed;
};

/**
 * Google carries one `state` through the round trip and two things have to
 * survive it: the workspace an invite link named, and where to come back to.
 * Read leniently, so a sign-in already in flight from the old shape still lands.
 */
const packState = (ws: string, app: string) => new URLSearchParams({ w: ws, app }).toString();
const unpackState = (raw: string) => {
  if (raw.includes("=")) {
    const p = new URLSearchParams(raw);
    return { ws: p.get("w") || "", app: p.get("app") || "" };
  }
  return { ws: raw, app: "" };   // the old shape: the slug on its own
};

app.get("/auth/google", (req, res) => {
  if (!googleEnabled) return res.status(501).send("Google sign-in is not configured");
  const params = new URLSearchParams({
    client_id: GOOGLE_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    // the workspace slug and where to come back to, both through the round trip
    state: packState(String(req.query.w || ""), String(req.query.app || "")),
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/auth/google/callback", async (req, res) => {
  if (!googleEnabled) return res.status(501).send("Google sign-in is not configured");
  const { ws, app } = unpackState(String(req.query.state || ""));
  const back = appUrl(req, app);
  const fail = (reason: string) =>
    res.redirect(`${back}#auth_error=${encodeURIComponent(reason.slice(0, 40))}`);

  // Google reports refusals in the query string rather than sending a code —
  // access_denied is what an unpublished app shows anyone outside its test users.
  // Without this the empty code went to the token endpoint and came back as a
  // misleading invalid_grant.
  if (req.query.error) {
    console.error("[auth] google refused the sign-in:", req.query.error, req.query.error_description ?? "");
    return fail(String(req.query.error));
  }
  if (!req.query.code) {
    console.error("[auth] google callback arrived with no code");
    return fail("no_code");
  }

  try {
    const cbRedirect = redirectUri(req);
    console.log("[auth] google callback — redirect_uri used for token exchange:", cbRedirect);
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code || ""),
        client_id: GOOGLE_ID,
        client_secret: GOOGLE_SECRET,
        redirect_uri: cbRedirect,
        grant_type: "authorization_code",
      }),
    });
    const tok = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!tok.access_token) {
      console.error("[auth] google token exchange failed:", JSON.stringify(tok));
      return fail(tok.error || "token_exchange");
    }

    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const info = (await infoRes.json()) as { sub?: string; email?: string; name?: string; picture?: string };
    const email = normEmail(info.email);
    if (!email) throw new Error("google account has no email");

    const googleId = info.sub || null;
    const photoUrl = info.picture || null;
    const name = info.name || email.split("@")[0];

    // link by email so an existing account keeps its workspaces and avatar
    const user = await prisma.user.upsert({
      where: { email },
      update: {
        googleId,
        photoUrl,
      },
      create: {
        email,
        name,
        googleId,
        photoUrl,
      },
    });
    const login = await issueLogin(user);
    console.log("[auth] google user linked successfully:", user.email);
    // hash fragment: the token never lands in server logs or the Referer header.
    // `totp=` tells the web app the sign-in still needs an authenticator code.
    const frag = login.token ? `token=${encodeURIComponent(login.token)}`
                             : `totp=${encodeURIComponent(login.pendingToken!)}`;
    res.redirect(`${back}${ws ? `?w=${encodeURIComponent(ws)}` : ""}#${frag}`);
  } catch (e: any) {
    console.error("[auth] google sign-in failed detailed error:", e?.message || e);
    fail(e?.message === "google account has no email" ? "no_email" : "google");
  }
});

// ---- authenticator app (TOTP) ----
const MAX_TOTP_ATTEMPTS = 5;

/** second step of a sign-in: exchange a pending token for a real session */
app.post("/auth/totp/verify", async (req, res) => {
  const token = String((req.body ?? {}).token ?? "");
  const code = String((req.body ?? {}).code ?? "");
  const s = await sessionFromToken(token);
  if (!s || !s.pendingTotp) return res.status(401).json({ error: "session expired" });

  const user = s.user;
  // 2FA turned off from another device while this sign-in was in flight
  if (!user.totpSecret || !user.totpEnabledAt) {
    await activateSession(token);
    return res.json({ token, user: safeUser(user) });
  }
  if (s.totpAttempts >= MAX_TOTP_ATTEMPTS) {
    await prisma.session.delete({ where: { token } }).catch(() => {});
    return res.status(429).json({ error: "too many attempts" });
  }

  const totp = await checkTotp(user.totpSecret, code, user.totpLastStep);
  // a recovery code is accepted here too: it is the way back in without the phone
  const remaining = totp.valid ? null : await spendRecoveryCode(user.recoveryCodes, code);
  if (!totp.valid && !remaining) {
    await prisma.session.update({ where: { token }, data: { totpAttempts: s.totpAttempts + 1 } });
    const left = MAX_TOTP_ATTEMPTS - (s.totpAttempts + 1);
    return res.status(401).json({
      error: totp.reused ? "code already used" : "invalid code",
      reused: totp.reused,
      attemptsLeft: Math.max(0, left),
    });
  }

  const fresh = await prisma.user.update({
    where: { id: user.id },
    // record the spent step / used recovery code so neither works a second time
    data: totp.valid ? { totpLastStep: totp.timeStep } : { recoveryCodes: remaining },
  });
  await activateSession(token);
  res.json({ token, user: safeUser(fresh), usedRecoveryCode: !totp.valid });
});

/** begin enrolment: mints a secret and returns the QR to scan (not yet active) */
app.post("/me/totp/setup", requireAuth, async (req: AuthedRequest, res) => {
  if (req.user!.totpEnabledAt) return res.status(409).json({ error: "already enabled" });
  const secret = newTotpSecret();
  await prisma.user.update({ where: { id: req.user!.id }, data: { totpSecret: secret } });
  const uri = otpauthUri(secret, req.user!.email);
  res.json({ secret, uri, qr: await qrDataUrl(uri) });
});

/** confirm enrolment with a code from the app, then hand over the recovery codes */
app.post("/me/totp/enable", requireAuth, async (req: AuthedRequest, res) => {
  const me = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!me?.totpSecret) return res.status(400).json({ error: "start setup first" });
  if (me.totpEnabledAt) return res.status(409).json({ error: "already enabled" });
  const r = await checkTotp(me.totpSecret, (req.body ?? {}).code);
  if (!r.valid) return res.status(401).json({ error: "invalid code" });
  const codes = newRecoveryCodes();
  const user = await prisma.user.update({
    where: { id: me.id },
    data: {
      totpEnabledAt: new Date(),
      totpLastStep: r.timeStep,
      recoveryCodes: await hashRecoveryCodes(codes),
    },
  });
  // the only time the plaintext codes exist outside the user's hands
  res.json({ ok: true, recoveryCodes: codes, user: safeUser(user) });
});

/** proving current possession stops a stolen session from stripping 2FA off */
async function proveTotp(userId: string, code: unknown) {
  const me = await prisma.user.findUnique({ where: { id: userId } });
  if (!me?.totpEnabledAt || !me.totpSecret) return null;
  const totp = await checkTotp(me.totpSecret, code, me.totpLastStep);
  if (totp.valid) return { me, spentStep: totp.timeStep, remaining: null as string | null };
  const remaining = await spendRecoveryCode(me.recoveryCodes, code);
  return remaining ? { me, spentStep: null, remaining } : null;
}

app.post("/me/totp/disable", requireAuth, async (req: AuthedRequest, res) => {
  if (!req.user!.totpEnabledAt) return res.json({ ok: true, user: safeUser(req.user!) });
  const proof = await proveTotp(req.user!.id, (req.body ?? {}).code);
  if (!proof) return res.status(401).json({ error: "invalid code" });
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: null },
  });
  res.json({ ok: true, user: safeUser(user) });
});

/** fresh set of recovery codes; the old ones stop working immediately */
app.post("/me/totp/recovery", requireAuth, async (req: AuthedRequest, res) => {
  if (!req.user!.totpEnabledAt) return res.status(400).json({ error: "2fa not enabled" });
  const proof = await proveTotp(req.user!.id, (req.body ?? {}).code);
  if (!proof) return res.status(401).json({ error: "invalid code" });
  const codes = newRecoveryCodes();
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      recoveryCodes: await hashRecoveryCodes(codes),
      ...(proof.spentStep ? { totpLastStep: proof.spentStep } : {}),
    },
  });
  res.json({ ok: true, recoveryCodes: codes, user: safeUser(user) });
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

/**
 * What this person wants colleagues to know.
 *
 * Every field is optional and every field is trimmed to a length that fits a
 * card — this is an introduction, not a document. The timezone is stored as an
 * IANA name rather than an offset so it stays right across daylight saving,
 * which is exactly the moment a wrong one starts costing somebody a meeting.
 */
app.put("/me/profile", requireAuth, async (req: AuthedRequest, res) => {
  const { name, bio, team, timezone } = req.body ?? {};
  const clean = (v: unknown, max: number) => {
    const t = String(v ?? "").trim().slice(0, max);
    return t || null;
  };
  const nextName = String(name ?? "").trim().slice(0, 24);
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      ...(nextName ? { name: nextName } : {}),
      bio: clean(bio, 280),
      team: clean(team, 60),
      timezone: clean(timezone, 60),
    },
  });
  res.json({ user: safeUser(user) });
});

/**
 * Somebody else's card, readable by anyone who shares the space with them.
 *
 * Not by account id alone: that would make every profile on the server readable
 * by anyone who guessed an id. The space is the reason you are allowed to look.
 */
app.get("/workspaces/:slug/members/:userId", requireAuth, async (req: AuthedRequest, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const [mine, theirs] = await Promise.all([
    prisma.membership.findUnique({ where: { userId_workspaceId: { userId: req.user!.id, workspaceId: w.id } } }),
    prisma.membership.findUnique({ where: { userId_workspaceId: { userId: req.params.userId, workspaceId: w.id } } }),
  ]);
  if (!mine) return res.status(401).json({ error: "unauthorized" });
  if (!theirs) return res.status(404).json({ error: "not found" });

  const u = await prisma.user.findUnique({ where: { id: req.params.userId } });
  if (!u) return res.status(404).json({ error: "not found" });
  res.json({
    profile: {
      id: u.id, name: u.name, photoUrl: u.photoUrl ?? null,
      role: u.role ?? null, bio: u.bio ?? null, team: u.team ?? null, timezone: u.timezone ?? null,
      // the workspace role, which is a different thing from the job title above
      memberRole: theirs.role,
      lastSeenAt: u.lastSeenAt,
      isMe: u.id === req.user!.id,
    },
  });
});

app.put("/me/desk", requireAuth, async (req: AuthedRequest, res) => {
  const { workspace, desk } = req.body ?? {};
  const ws = String(workspace || "main").slice(0, 32);
  const id = String(desk ?? "").slice(0, 32);
  // a desk is staff seating: guests may walk the space but not take one.
  // Releasing (id === "") stays allowed so a demoted member can give theirs up.
  if (id && (await roleIn(ws, req.user!.id)) === "guest")
    return res.status(403).json({ error: "guests cannot claim a desk" });
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

/**
 * Who may see the invite code: members and up. Guests are inside the space but
 * must not be able to pull more people in, and a plain visitor who guessed the
 * slug is not a member at all — an undefined role has to fail closed.
 */
const canInvite = (role?: string) => role === "owner" || role === "admin" || role === "member";

// map layouts the client can render — mirrors THEMES in apps/web/src/scenes/mapThemes.ts.
// Validated here so a bad value can never reach everyone's map loader.
const THEMES = ["classic", "departments", "office"];

// A stored map is handed to every browser that opens the space, so its size is
// everyone's page load, not just a row in a table. The three built-in layouts
// bake down to roughly 30-60 KB, so this leaves a lot of room and still refuses
// something that would make the space slow to enter for everybody.
const MAP_MAX_BYTES = Number(process.env.MAP_MAX_BYTES || 2_000_000);

// Floors of a building, or separate offices. The ceiling is about the person
// rather than the database: a switcher nobody can find their way around is not
// more capability, and every map is another thing to keep consistent.
const MAPS_PER_SPACE = Number(process.env.MAPS_PER_SPACE || 12);

const wsView = (w: any, role?: string) => ({
  slug: w.slug, name: w.name, allowGuests: w.allowGuests,
  theme: w.theme ?? "classic",
  inviteCode: canInvite(role) ? w.inviteCode : undefined,
  members: w._count?.members ?? undefined, role,
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
  const { name: rawName, allowGuests: guests, role, companySize, useCase, theme } = req.body ?? {};
  const name = String(rawName ?? "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "name required" });
  if (theme !== undefined && !THEMES.includes(String(theme)))
    return res.status(400).json({ error: "unknown theme" });
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
      // chosen in the create wizard; the layout is fixed for the space's lifetime
      ...(theme !== undefined ? { theme: String(theme) } : {}),
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
  // wsView already withholds the code from guests and non-members
  res.json({ workspace: wsView(w, membership?.role) });
});

// owner/admin settings (rename, toggle guest access)
app.patch("/workspaces/:slug", requireAuth, async (req: AuthedRequest, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId: w.id } },
  });
  if (!m || (m.role !== "owner" && m.role !== "admin")) return res.status(403).json({ error: "forbidden" });
  const { name, allowGuests, theme } = req.body ?? {};
  // The layout is fixed once the space exists: desk ids belong to it, so a
  // change would cancel every desk the team had claimed and move everyone's
  // walls. Chosen in the create wizard instead — see DEPLOY.md for the manual
  // route if a space really has to be moved.
  if (theme !== undefined && String(theme) !== w.theme)
    return res.status(400).json({ error: "theme is fixed after creation" });
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

// ---- roles ----
// owner > admin > member > guest. A guest may walk around and talk but cannot
// claim a desk or see the invite link; everything above that is staff seating.
const ROLE_RANK: Record<string, number> = { owner: 3, admin: 2, member: 1, guest: 0 };
const ASSIGNABLE = ["admin", "member", "guest"] as const;
const rank = (role: string) => ROLE_RANK[role] ?? -1;

/**
 * Who may act on whom. An admin manages the ranks below it but cannot create
 * another admin, touch a fellow admin, or reach the owner — otherwise any admin
 * could quietly lock the owner out of their own workspace.
 */
const canManage = (actor: string, target: string) =>
  actor === "owner" || (actor === "admin" && rank(target) < rank("admin"));

/** this user's role in a workspace, or null when they are not a member of it */
async function roleIn(slug: string, userId: string) {
  const w = await prisma.workspace.findUnique({ where: { slug }, select: { id: true } });
  if (!w) return null;
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: w.id } },
    select: { role: true },
  });
  return m?.role ?? null;
}

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
    include: {
      user: { select: { id: true, name: true, email: true, photoUrl: true, lastSeenAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  res.json({
    myRole: me.role,
    members: rows.map((m) => ({
      id: m.user.id, name: m.user.name, email: m.user.email,
      photoUrl: m.user.photoUrl, role: m.role, isMe: m.user.id === req.user!.id,
      joinedAt: m.createdAt,
      lastSeenAt: m.user.lastSeenAt,
      // the menu the client draws for this row — one source of truth for the rules
      canManage: canManage(me.role, m.role) && m.user.id !== w.ownerId && m.user.id !== req.user!.id,
      canPromote: me.role === "owner" && m.user.id !== w.ownerId,
    })),
  });
});

/** change a member's role */
app.patch("/workspaces/:slug/members/:userId", requireAuth, async (req: AuthedRequest, res) => {
  const role = String((req.body ?? {}).role ?? "");
  if (!ASSIGNABLE.includes(role as typeof ASSIGNABLE[number]))
    return res.status(400).json({ error: "invalid role" });
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const me = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId: w.id } },
  });
  if (!me) return res.status(403).json({ error: "forbidden" });
  if (req.params.userId === w.ownerId) return res.status(400).json({ error: "cannot change the owner" });
  if (req.params.userId === req.user!.id) return res.status(400).json({ error: "cannot change your own role" });

  const target = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: req.params.userId, workspaceId: w.id } },
  });
  if (!target) return res.status(404).json({ error: "not a member" });
  // must outrank both where they are now and where they would end up
  if (!canManage(me.role, target.role) || !canManage(me.role, role))
    return res.status(403).json({ error: "forbidden" });

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
  const targetId = req.params.userId;
  if (targetId === w.ownerId) return res.status(400).json({ error: "the owner cannot be removed" });
  if (targetId !== req.user!.id) {
    // same rule as a role change: an admin cannot remove a fellow admin
    const target = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: targetId, workspaceId: w.id } },
    });
    if (!target) return res.status(404).json({ error: "not a member" });
    if (!canManage(me.role, target.role)) return res.status(403).json({ error: "forbidden" });
  }
  await prisma.membership.delete({
    where: { userId_workspaceId: { userId: targetId, workspaceId: w.id } },
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

// ---- guest passes ----
// The open-door setting (allowGuests) admits anyone who has the link and leaves
// no record. A pass is the accountable form of the same thing: it names the
// visitor, may expire, can be revoked one at a time, and records each visit.

type PassState = "active" | "expired" | "revoked" | "archived";

/**
 * Archived wins over revoked, and revoked over expired: each answers a
 * different question ("still on the list?", "shut out?", "past its date?") and
 * the list has to put every pass under exactly one tab.
 */
const passState = (g: { expiresAt: Date | null; revokedAt: Date | null; archivedAt: Date | null }): PassState =>
  g.archivedAt ? "archived"
  : g.revokedAt ? "revoked"
  : g.expiresAt && g.expiresAt.getTime() <= Date.now() ? "expired"
  : "active";

/**
 * A pass as staff see it — including the code, which is the credential.
 *
 * @param full false for a plain member, who may see WHO is visiting but must
 *   not be handed the thing that lets somebody in. A member reading the list is
 *   answering "who is this stranger by the pantry"; issuing a pass is not
 *   theirs to do, and a code they can copy is a pass they can issue.
 */
const passView = (g: any, full = true) => ({
  id: g.id, name: g.name, note: g.note ?? undefined,
  state: passState(g), expiresAt: g.expiresAt, revokedAt: g.revokedAt,
  archivedAt: g.archivedAt, lastSeenAt: g.lastSeenAt, visits: g.visits,
  createdAt: g.createdAt,
  ...(full ? { code: g.code } : {}),
});

/**
 * The workspace and this person's standing in it, for anybody who belongs.
 *
 * Separate from managedWorkspace because seeing and doing are different rights:
 * a member may look at the guest list, and only staff may change it.
 */
async function memberWorkspace(slug: string, userId: string) {
  const w = await prisma.workspace.findUnique({ where: { slug } });
  if (!w) return { error: 404 as const };
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: w.id } },
  });
  if (!m || m.role === "guest") return { error: 403 as const };
  return { w, role: m.role };
}

/** guest passes are staff business: resolve the workspace and refuse below admin */
async function managedWorkspace(slug: string, userId: string) {
  const w = await prisma.workspace.findUnique({ where: { slug } });
  if (!w) return { error: 404 as const };
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: w.id } },
  });
  if (!m || (m.role !== "owner" && m.role !== "admin")) return { error: 403 as const };
  return { w, role: m.role };
}

const DAY_MS = 86_400_000;
const PASS_DAYS = [1, 7, 30, 90];

app.get("/workspaces/:slug/guests", requireAuth, async (req: AuthedRequest, res) => {
  // A member may read the list; only staff get the codes and the buttons.
  const got = await memberWorkspace(req.params.slug, req.user!.id);
  if (got.error) return res.status(got.error).json({ error: got.error === 404 ? "not found" : "forbidden" });
  const staff = got.role === "owner" || got.role === "admin";
  const rows = await prisma.guestPass.findMany({
    where: { workspaceId: got.w.id },
    orderBy: { createdAt: "desc" },
  });
  res.json({ myRole: got.role, guests: rows.map((g) => passView(g, staff)) });
});

app.post("/workspaces/:slug/guests", requireAuth, async (req: AuthedRequest, res) => {
  const got = await managedWorkspace(req.params.slug, req.user!.id);
  if (got.error) return res.status(got.error).json({ error: got.error === 404 ? "not found" : "forbidden" });
  const name = String((req.body ?? {}).name ?? "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "name required" });
  const { days, note } = req.body ?? {};
  // null days = a pass that never expires; anything else must be one of the
  // offered lengths, so a caller cannot mint a 50-year pass
  if (days !== null && days !== undefined && !PASS_DAYS.includes(Number(days)))
    return res.status(400).json({ error: "invalid days" });
  const pass = await prisma.guestPass.create({
    data: {
      workspaceId: got.w.id, name,
      // not randomCode(): this one is the whole credential, so it comes from the
      // CSPRNG rather than Math.random
      code: randomBytes(16).toString("hex"),
      note: note ? String(note).slice(0, 200) : null,
      expiresAt: days === null || days === undefined ? null : new Date(Date.now() + Number(days) * DAY_MS),
      createdById: req.user!.id,
    },
  });
  res.json({ guest: passView(pass) });
});

/** revoke / restore / archive / rename a pass */
app.patch("/workspaces/:slug/guests/:id", requireAuth, async (req: AuthedRequest, res) => {
  const got = await managedWorkspace(req.params.slug, req.user!.id);
  if (got.error) return res.status(got.error).json({ error: got.error === 404 ? "not found" : "forbidden" });
  const pass = await prisma.guestPass.findUnique({ where: { id: req.params.id } });
  if (!pass || pass.workspaceId !== got.w.id) return res.status(404).json({ error: "not found" });
  const { revoked, archived, name, days } = req.body ?? {};
  if (days !== undefined && days !== null && !PASS_DAYS.includes(Number(days)))
    return res.status(400).json({ error: "invalid days" });
  const updated = await prisma.guestPass.update({
    where: { id: pass.id },
    data: {
      ...(typeof revoked === "boolean" ? { revokedAt: revoked ? new Date() : null } : {}),
      ...(typeof archived === "boolean" ? { archivedAt: archived ? new Date() : null } : {}),
      ...(typeof name === "string" && name.trim() ? { name: name.trim().slice(0, 60) } : {}),
      // extending a pass is how an expired one comes back — clearing revokedAt
      // is not enough when the date has already passed
      ...(days === null ? { expiresAt: null }
        : days !== undefined ? { expiresAt: new Date(Date.now() + Number(days) * DAY_MS) } : {}),
    },
  });
  res.json({ guest: passView(updated) });
});

/**
 * What the holder of a pass link may read about it, so the app can greet them
 * by the name on the pass instead of "Guest". Unauthenticated on purpose — the
 * code in their URL is the credential — and it answers with nothing they were
 * not already told when the link was sent.
 */
app.get("/guest-pass/:code", async (req, res) => {
  const pass = await prisma.guestPass.findUnique({
    where: { code: String(req.params.code) },
    include: { workspace: { select: { slug: true, name: true } } },
  });
  if (!pass) return res.status(404).json({ error: "not found" });
  res.json({
    name: pass.name, state: passState(pass), expiresAt: pass.expiresAt,
    workspace: pass.workspace,
  });
});

/** used by the game server to authorise a room join (members, or guests if allowed) */
app.get("/workspaces/:slug/access", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.json({ allowed: false, reason: "not-found" });

  // A live pass is checked before the open-door setting and before membership
  // is even looked up: it is the one credential that gets its holder in while
  // the space is closed to guests. Only its own state can turn it down.
  const code = String(req.query.guest || "");
  if (code) {
    const pass = await prisma.guestPass.findUnique({ where: { code } });
    if (pass && pass.workspaceId === w.id && passState(pass) === "active") {
      // stamped at most once a minute — a reconnect loop must not write per join
      if (!pass.lastSeenAt || Date.now() - pass.lastSeenAt.getTime() > 60_000) {
        await prisma.guestPass.update({
          where: { id: pass.id },
          data: { lastSeenAt: new Date(), visits: { increment: 1 } },
        });
      }
      return res.json({ allowed: true, reason: "guest-pass", role: "guest", name: w.name, guestName: pass.name });
    }
  }

  const user = await userFromToken(String(req.query.token || "") || undefined);
  if (!user) return res.json({ allowed: w.allowGuests, reason: w.allowGuests ? "guest" : "members-only", name: w.name });
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId: w.id } },
  });
  // userId travels with the answer so the room can address one person: private
  // messages need a name that outlives the socket, and the session id does not.
  if (m) return res.json({ allowed: true, reason: "member", role: m.role, name: w.name, userId: user.id });
  // logged in but not a member yet — treat like a guest visit
  res.json({ allowed: w.allowGuests, reason: w.allowGuests ? "guest" : "members-only", name: w.name });
});

/**
 * Where to find a way through to the other browsers.
 *
 * Credentials are minted per request and expire, so this endpoint has to be
 * behind the same door as the space itself: a member's session, or a live guest
 * pass. Left open it would be a free relay for anyone who found the URL, and the
 * bill for that traffic arrives on our side.
 *
 * The workspace is not checked beyond that. Anyone entitled to be in ANY space
 * here is entitled to talk to the people in it, and tying a credential to one
 * slug would only mean re-minting it when someone walks into another space.
 */
app.get("/ice", async (req, res) => {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") || String(req.query.token || "");
  const user = await userFromToken(token || undefined);
  let who = user ? `u${user.id}` : "";

  if (!who) {
    const code = String(req.query.guest || "");
    if (code) {
      const pass = await prisma.guestPass.findUnique({ where: { code } });
      if (pass && passState(pass) === "active") who = `g${pass.id}`;
    }
  }
  if (!who) return res.status(401).json({ error: "unauthorized" });

  // Never cached: the credential inside has an expiry, and a proxy holding on to
  // a stale one would hand out a relay password that no longer opens anything.
  res.set("Cache-Control", "no-store");
  res.json(iceConfig(who));
});

// ---- room chat ----

/**
 * How long a message is kept. Chat in a workplace is a record — someone will
 * scroll back for a decision or a link — but it is not an archive, and nobody
 * decided to run one. Three months is long enough to be useful and short enough
 * that the file does not grow without end.
 */
const CHAT_KEEP_DAYS = Number(process.env.CHAT_KEEP_DAYS || 90);
const CHAT_PAGE = 50;

/**
 * Who is speaking, by the same rule the room itself uses: a member's session, or
 * a live guest pass for this space. Returns null when neither holds.
 *
 * A guest has no account, so their name comes off the pass. That is also what
 * makes the name worth storing on the message: there is nothing to look it up
 * from later.
 */
async function speakerFor(req: express.Request, w: { id: string; allowGuests: boolean }) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") || String(req.query.token || "");
  const user = await userFromToken(token || undefined);
  if (user) {
    const m = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId: w.id } },
    });
    if (m || w.allowGuests) return { userId: user.id, name: user.name };
    return null;
  }
  const code = String(req.query.guest || (req.body ?? {}).guest || "");
  if (code) {
    const pass = await prisma.guestPass.findUnique({ where: { code } });
    if (pass && pass.workspaceId === w.id && passState(pass) === "active") {
      return { userId: null as string | null, name: pass.name };
    }
  }
  return null;
}

/**
 * The file this message says it carries, if it is really ours to carry.
 *
 * Checked against the space, not just the id: an attachment id from another
 * workspace would otherwise be quotable into this one, and a file shared in a
 * private space would leak to whoever guessed at it.
 */
async function attachmentFor(id: unknown, workspaceId: string) {
  const want = String(id ?? "").trim();
  if (!want) return null;
  const a = await prisma.attachment.findUnique({ where: { id: want } });
  return a && a.workspaceId === workspaceId && a.path !== "pending" ? a : null;
}

/** the newest messages, oldest first — the order they are read in */
app.get("/workspaces/:slug/messages", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const who = await speakerFor(req, w);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  const limit = Math.min(Math.max(Number(req.query.limit) || CHAT_PAGE, 1), 200);
  // "before" walks backwards through older pages; without it, the newest page
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const rows = await prisma.message.findMany({
    // toUserId: null is the line between the room and a private thread. Every
    // room query carries it; the one that forgets publishes a conversation.
    where: { workspaceId: w.id, toUserId: null, ...(before && !isNaN(+before) ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { attach: true },
  });
  res.json({
    messages: rows.reverse().map((m) => ({
      id: m.id, name: m.authorName, text: m.body, at: m.createdAt, mine: !!who.userId && m.userId === who.userId,
      ...(m.attach ? { attach: attachView(m.attach) } : {}),
    })),
    // there is more history behind this page if it came back full
    more: rows.length === limit,
  });
});

/**
 * Store one line. Posted by the game server on the speaker's behalf — it holds
 * their token from the moment they were let into the room — so the same
 * credential that opens the door writes the message, and a client cannot put
 * words in anyone else's mouth by talking to this endpoint directly.
 */
app.post("/workspaces/:slug/messages", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const who = await speakerFor(req, w);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  const body = String((req.body ?? {}).text ?? "").slice(0, 300).trim();
  // A file with nothing said about it is a message. Text with nothing in it and
  // no file is not.
  const attach = await attachmentFor((req.body ?? {}).attach, w.id);
  if (!body && !attach) return res.status(400).json({ error: "empty" });

  const m = await prisma.message.create({
    data: {
      workspaceId: w.id, userId: who.userId, authorName: who.name, body,
      toUserId: null, attachId: attach?.id ?? null,
    },
  });
  res.json({
    message: {
      id: m.id, name: m.authorName, text: m.body, at: m.createdAt,
      ...(attach ? { attach: attachView(attach) } : {}),
    },
  });
});

// ---- files in the chat ------------------------------------------------------

/**
 * One attachment, as the browser needs it.
 *
 * The link is minted here rather than stored, because it expires: a URL kept in
 * a row would be a URL that stops working while nobody is looking at it.
 */
function attachView(a: {
  id: string; name: string; mime: string; bytes: number; width: number | null; height: number | null;
}) {
  return {
    id: a.id, name: a.name, mime: a.mime, bytes: a.bytes,
    image: isImage(a.mime),
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    url: signedPath(a.id),
  };
}

/**
 * Take a file.
 *
 * The body is the file itself, not a multipart envelope. A browser can post a
 * File straight down a fetch and this saves parsing a format whose whole job
 * would be to carry one part — the name rides in a header instead.
 *
 * Anybody who may speak here may upload here. That includes a guest with a live
 * pass: they can already put words on everyone's screen, and a picture is the
 * same act with a larger surface. What bounds it is the size, the allowlist, and
 * the fact that nothing is served back except what the list names.
 */
app.post(
  "/workspaces/:slug/uploads",
  express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES + 1024 }),
  // The parser gives up before the handler ever runs, and what it throws would
  // otherwise reach the client as a 500 with an HTML body — which reads as "the
  // server broke" rather than "that file is too big", and is the difference
  // between somebody trying a smaller file and somebody giving up.
  ((err: { type?: string; status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      return res.status(413).json({ error: `file is too large (limit ${UPLOAD_MAX_BYTES} bytes)` });
    }
    return next(err);
  }) as express.ErrorRequestHandler,
  async (req: express.Request, res: express.Response) => {
    const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!w) return res.status(404).json({ error: "not found" });
    const who = await speakerFor(req, w);
    if (!who) return res.status(401).json({ error: "unauthorized" });

    const data: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length) return res.status(400).json({ error: "empty" });
    if (data.length > UPLOAD_MAX_BYTES)
      return res.status(413).json({ error: `file is too large (${data.length} bytes, limit ${UPLOAD_MAX_BYTES})` });

    // The declared type decides what we will serve it as, so it is checked
    // against the list rather than recorded. A type we do not serve is a file
    // we do not keep.
    const mime = String(req.header("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!accepts(mime))
      return res.status(415).json({ error: "that kind of file is not accepted", allowed: allowedTypes() });

    const name = safeName(decodeURIComponent(String(req.header("x-filename") || "")));
    // a hint for layout only, and only believed within reason
    const clamp = (v: unknown) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n > 0 && n <= 20000 ? n : null;
    };
    const width = isImage(mime) ? clamp(req.header("x-width")) : null;
    const height = isImage(mime) ? clamp(req.header("x-height")) : null;

    const at = new Date();
    const row = await prisma.attachment.create({
      data: {
        workspaceId: w.id, userId: who.userId, name, mime, bytes: data.length,
        width, height, path: "pending", createdAt: at,
      },
    });
    // the id names the file, so the row has to exist before the bytes do
    const rel = relPathFor(row.id, mime, at);
    try {
      await putBytes(rel, data);
    } catch (e) {
      await prisma.attachment.delete({ where: { id: row.id } }).catch(() => {});
      console.error("[uploads] could not write the file:", e);
      return res.status(500).json({ error: "could not store the file" });
    }
    const saved = await prisma.attachment.update({ where: { id: row.id }, data: { path: rel } });
    res.json({ attachment: attachView(saved) });
  },
);

/**
 * Hand the file back.
 *
 * The signature in the link is the credential — an <img> cannot carry a header,
 * so it has to be the URL that is the capability. It is per file and it expires,
 * which is what keeps "shared in a private space" true.
 *
 * The type served is the one from the allowlist, and nosniff stops a browser
 * from deciding otherwise. Only images are shown inline; everything else is
 * offered as a download, because inline is where a file gets to run.
 */
app.get("/uploads/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!linkOk(id, req.query.exp, req.query.sig)) return res.status(403).json({ error: "link expired" });

  const a = await prisma.attachment.findUnique({ where: { id } });
  if (!a || a.path === "pending") return res.status(404).json({ error: "not found" });

  const inline = isImage(a.mime) && !req.query.dl;
  res.setHeader("content-type", a.mime);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-security-policy", "default-src 'none'; sandbox");
  res.setHeader("cache-control", "private, max-age=3600");
  // RFC 5987, so a Thai or emoji filename survives the trip
  res.setHeader(
    "content-disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
  );
  res.sendFile(absPathFor(a.path), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "not found" });
  });
});

/**
 * Files uploaded but never sent.
 *
 * Somebody picks a file, the upload finishes, and then they change their mind
 * and close the tab. The row and the bytes are already there with no message
 * pointing at them, and nothing else would ever remove them.
 */
async function sweepOrphanUploads() {
  const cutoff = new Date(Date.now() - DAY_MS);
  const stale = await prisma.attachment.findMany({
    where: { createdAt: { lt: cutoff }, messages: { none: {} } },
    select: { id: true, path: true },
  });
  for (const a of stale) await dropBytes(a.path);
  if (stale.length) {
    await prisma.attachment.deleteMany({ where: { id: { in: stale.map((a) => a.id) } } });
    console.log(`[uploads] removed ${stale.length} file(s) that were never sent`);
  }
}

// ---- private messages -------------------------------------------------------

/**
 * A private thread needs two accounts. A guest holds a pass, not an account —
 * there is nothing to address a message to that would still exist tomorrow, and
 * nothing to show them a thread on when they come back with a new pass. So this
 * is between members, and the room is where everyone else talks.
 *
 * Both ends are checked, not just the caller: sending to someone who is not in
 * this space would let anyone use a workspace they belong to as a way to reach
 * an account they have no other connection with.
 */
async function dmPair(slug: string, req: express.Request, peerId: string) {
  const w = await prisma.workspace.findUnique({ where: { slug } });
  if (!w) return { error: 404 as const };
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") || String(req.query.token || "");
  const me = await userFromToken(token || undefined);
  if (!me) return { error: 401 as const };

  const [mine, theirs] = await Promise.all([
    prisma.membership.findUnique({ where: { userId_workspaceId: { userId: me.id, workspaceId: w.id } } }),
    peerId ? prisma.membership.findUnique({ where: { userId_workspaceId: { userId: peerId, workspaceId: w.id } } }) : null,
  ]);
  if (!mine) return { error: 401 as const };
  if (peerId && !theirs) return { error: 404 as const };
  return { w, me, peer: theirs };
}

/** everyone this person has a thread with, newest first, with what is unread */
app.get("/workspaces/:slug/dm", async (req, res) => {
  const got = await dmPair(req.params.slug, req, "");
  if (got.error) return res.status(got.error).json({ error: got.error === 404 ? "not found" : "unauthorized" });
  const { w, me } = got;

  const rows = await prisma.message.findMany({
    where: { workspaceId: w.id, OR: [{ userId: me.id, toUserId: { not: null } }, { toUserId: me.id }] },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { attach: { select: { name: true } } },
  });
  const reads = await prisma.dmRead.findMany({ where: { workspaceId: w.id, userId: me.id } });
  const readAt = new Map(reads.map((r) => [r.peerId, r.readAt.getTime()]));

  // one entry per person, holding the newest line and how much of theirs is new
  const threads = new Map<string, { peerId: string; name: string; text: string; at: Date; unread: number }>();
  for (const m of rows) {
    const peerId = m.userId === me.id ? m.toUserId! : m.userId!;
    if (!peerId) continue;
    const seen = threads.get(peerId);
    // A preview of "" reads as an empty conversation. A line that was only a
    // file has no text, so the filename stands in for it.
    const preview = m.body || (m.attach ? `\u{1F4CE} ${m.attach.name}` : "");
    if (!seen) threads.set(peerId, { peerId, name: m.userId === me.id ? "" : m.authorName, text: preview, at: m.createdAt, unread: 0 });
    const th = threads.get(peerId)!;
    if (!th.name && m.userId === peerId) th.name = m.authorName;
    if (m.toUserId === me.id && m.createdAt.getTime() > (readAt.get(peerId) ?? 0)) th.unread++;
  }

  // a name for people who have only ever been written TO
  const missing = [...threads.values()].filter((t) => !t.name).map((t) => t.peerId);
  if (missing.length) {
    const users = await prisma.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } });
    for (const u of users) { const th = threads.get(u.id); if (th) th.name = u.name; }
  }

  res.json({ threads: [...threads.values()].sort((a, b) => +b.at - +a.at) });
});

/** one thread, oldest first — and opening it is what marks it read */
app.get("/workspaces/:slug/dm/:peerId", async (req, res) => {
  const got = await dmPair(req.params.slug, req, req.params.peerId);
  if (got.error) return res.status(got.error).json({ error: got.error === 404 ? "not found" : "unauthorized" });
  const { w, me } = got;
  const peerId = req.params.peerId;

  const limit = Math.min(Math.max(Number(req.query.limit) || CHAT_PAGE, 1), 200);
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const rows = await prisma.message.findMany({
    where: {
      workspaceId: w.id,
      OR: [{ userId: me.id, toUserId: peerId }, { userId: peerId, toUserId: me.id }],
      ...(before && !isNaN(+before) ? { createdAt: { lt: before } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { attach: true },
  });

  // Reading is what marks it read, and only when there was something to read:
  // opening an empty thread should not move a marker that nothing has passed.
  if (rows.length && !before) {
    await prisma.dmRead.upsert({
      where: { workspaceId_userId_peerId: { workspaceId: w.id, userId: me.id, peerId } },
      update: { readAt: new Date() },
      create: { workspaceId: w.id, userId: me.id, peerId, readAt: new Date() },
    });
  }

  res.json({
    messages: rows.reverse().map((m) => ({
      id: m.id, name: m.authorName, text: m.body, at: m.createdAt, mine: m.userId === me.id,
      ...(m.attach ? { attach: attachView(m.attach) } : {}),
    })),
    more: rows.length === limit,
  });
});

/** say something to one person */
app.post("/workspaces/:slug/dm/:peerId", async (req, res) => {
  const got = await dmPair(req.params.slug, req, req.params.peerId);
  if (got.error) return res.status(got.error).json({ error: got.error === 404 ? "not found" : "unauthorized" });
  const { w, me } = got;
  if (req.params.peerId === me.id) return res.status(400).json({ error: "that is you" });

  const body = String((req.body ?? {}).text ?? "").slice(0, 300).trim();
  const attach = await attachmentFor((req.body ?? {}).attach, w.id);
  if (!body && !attach) return res.status(400).json({ error: "empty" });

  const m = await prisma.message.create({
    data: {
      workspaceId: w.id, userId: me.id, toUserId: req.params.peerId,
      authorName: me.name, body, attachId: attach?.id ?? null,
    },
  });
  res.json({
    message: {
      id: m.id, name: m.authorName, text: m.body, at: m.createdAt, mine: true,
      ...(attach ? { attach: attachView(attach) } : {}),
    },
  });
});

/**
 * Drop what is past keeping. Runs at startup and once a day after that: a
 * deployment that is restarted often would otherwise never reach the sweep, and
 * one that runs for months would never repeat it.
 */
async function sweepOldMessages() {
  if (!(CHAT_KEEP_DAYS > 0)) return;              // 0 or nonsense: keep everything
  const cutoff = new Date(Date.now() - CHAT_KEEP_DAYS * DAY_MS);

  // The files go with the lines that showed them, in that order. Deleting the
  // messages first would leave attachments no message points at, which the
  // orphan sweep would then take a day to notice — and until it did, the disk
  // would be holding files nothing in the product can reach.
  const doomed = await prisma.attachment.findMany({
    where: { messages: { some: { createdAt: { lt: cutoff } } } },
    select: { id: true, path: true },
  });
  for (const a of doomed) await dropBytes(a.path);

  const { count } = await prisma.message.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (doomed.length) await prisma.attachment.deleteMany({ where: { id: { in: doomed.map((a) => a.id) } } });
  if (count) console.log(`[chat] removed ${count} message(s) older than ${CHAT_KEEP_DAYS} days`);
  if (doomed.length) console.log(`[uploads] removed ${doomed.length} file(s) with them`);
}

// ---- the map a space loads ----
//
// `theme` on the workspace names one of the three layouts compiled into the
// client. A row here overrides it with a map made rather than written — which
// is the whole point: until now a map could only exist as our TypeScript, so
// only we could make one.
//
// Reading is open to the same extent the space is visible at all, because the
// map is not a secret: every browser in the room is handed it, and the door
// that matters is the one on the room. Writing is owner and admin only.

/** owner/admin of this space, or the response has already been sent */
async function mapEditor(req: AuthedRequest, res: express.Response) {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) { res.status(404).json({ error: "not found" }); return null; }
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId: w.id } },
  });
  if (!m || (m.role !== "owner" && m.role !== "admin")) { res.status(403).json({ error: "forbidden" }); return null; }
  return w;
}

/** the parsed map behind a row, or the reason it cannot be used */
function readMap(row: { data: string }): { doc?: any; problem?: string } {
  let doc: unknown;
  try { doc = JSON.parse(row.data); } catch { return { problem: "stored map is not JSON" }; }
  const problem = mapDocProblem(doc);
  return problem ? { problem } : { doc };
}

/**
 * Every map in a space, in the order people meet them.
 *
 * The first is where new arrivals land; the rest are reached through a portal
 * or by a ?m= in the URL. A space with none is on one of the layouts compiled
 * into the client, named here so the browser knows which.
 */
app.get("/workspaces/:slug/maps", async (req, res) => {
  const w = await prisma.workspace.findUnique({
    where: { slug: req.params.slug },
    include: { maps: { orderBy: [{ order: "asc" }, { slug: "asc" }] } },
  });
  if (!w) return res.status(404).json({ error: "not found" });
  if (!w.maps.length) return res.json({ builtin: w.theme || "classic", maps: [] });

  const maps = w.maps.map((m) => {
    const { doc, problem } = readMap(m);
    return { slug: m.slug, label: doc?.label ?? m.slug, order: m.order, updatedAt: m.updatedAt, problem };
  });
  res.json({ maps, landing: maps[0].slug });
});

/** one map by name, or the landing one when no name is given */
async function serveMap(req: express.Request, res: express.Response, want: string | null) {
  const w = await prisma.workspace.findUnique({
    where: { slug: req.params.slug },
    include: { maps: { orderBy: [{ order: "asc" }, { slug: "asc" }] } },
  });
  if (!w) return res.status(404).json({ error: "not found" });

  const row = want ? w.maps.find((m) => m.slug === want) : w.maps[0];
  if (!row) {
    // A ?m= naming a map that has been deleted is a stale link, not a broken
    // space: say so, and let the caller fall back to the landing map.
    if (want) return res.status(404).json({ error: "no such map", builtin: w.theme || "classic" });
    return res.json({ builtin: w.theme || "classic" });
  }

  // A row that no longer parses, or that predates a format change, must not
  // take the space down with it: name the stock map instead and say why, so
  // the space still opens while somebody looks at it.
  const { doc, problem } = readMap(row);
  if (problem) {
    console.warn(`[map] ${w.slug}/${row.slug} is unreadable (${problem}) — serving the built-in`);
    return res.json({ builtin: w.theme || "classic", problem });
  }
  res.json({ map: doc, slug: row.slug, updatedAt: row.updatedAt });
}

app.get("/workspaces/:slug/map", (req, res) => void serveMap(req, res, null));
app.get("/workspaces/:slug/map/:mapSlug", (req, res) => void serveMap(req, res, req.params.mapSlug));

async function storeMap(req: AuthedRequest, res: express.Response, want: string | null) {
  const w = await mapEditor(req, res);
  if (!w) return;

  const doc = req.body?.map;
  const problem = mapDocProblem(doc);
  // Refused here rather than merely warned about later: this row reaches every
  // browser in the space, so a bad one is not a bad record, it is a room
  // nobody can walk into.
  if (problem) return res.status(400).json({ error: "not a valid map", problem });

  // The map's own id is its name in the space, so the two cannot disagree —
  // a portal names one thing and a URL names the other otherwise.
  const slug = want ?? doc.id;
  if (want && doc.id !== want)
    return res.status(400).json({ error: `the map's id is "${doc.id}" but the path says "${want}"` });

  const data = JSON.stringify(doc);
  if (data.length > MAP_MAX_BYTES)
    return res.status(413).json({ error: `map is too large (${data.length} bytes, limit ${MAP_MAX_BYTES})` });

  const existing = await prisma.workspaceMap.findUnique({
    where: { workspaceId_slug: { workspaceId: w.id, slug } },
  });
  const count = await prisma.workspaceMap.count({ where: { workspaceId: w.id } });
  if (!existing && count >= MAPS_PER_SPACE)
    return res.status(409).json({ error: `a space may hold ${MAPS_PER_SPACE} maps` });

  const saved = await prisma.workspaceMap.upsert({
    where: { workspaceId_slug: { workspaceId: w.id, slug } },
    create: { workspaceId: w.id, slug, order: count, data, updatedById: req.user!.id },
    update: { data, updatedById: req.user!.id },
  });
  res.json({ ok: true, slug: saved.slug, updatedAt: saved.updatedAt });
}

app.put("/workspaces/:slug/map", requireAuth, (req: AuthedRequest, res) => void storeMap(req, res, null));
app.put("/workspaces/:slug/map/:mapSlug", requireAuth, (req: AuthedRequest, res) => void storeMap(req, res, req.params.mapSlug));

/** the order people meet the maps in; the first is where they land */
app.put("/workspaces/:slug/maps/order", requireAuth, async (req: AuthedRequest, res) => {
  const w = await mapEditor(req, res);
  if (!w) return;
  const order = req.body?.order;
  if (!Array.isArray(order) || order.some((v) => typeof v !== "string"))
    return res.status(400).json({ error: "order must be a list of map names" });

  const rows = await prisma.workspaceMap.findMany({ where: { workspaceId: w.id } });
  const known = new Set(rows.map((r) => r.slug));
  // Every map has to appear exactly once, or reordering silently decides the
  // landing map by leaving something out.
  if (order.length !== rows.length || new Set(order).size !== order.length || order.some((sl) => !known.has(sl)))
    return res.status(400).json({ error: "order must name every map in the space exactly once" });

  await prisma.$transaction(order.map((sl, i) =>
    prisma.workspaceMap.update({ where: { workspaceId_slug: { workspaceId: w.id, slug: sl } }, data: { order: i } })));
  res.json({ ok: true, landing: order[0] });
});

app.delete("/workspaces/:slug/map/:mapSlug", requireAuth, async (req: AuthedRequest, res) => {
  const w = await mapEditor(req, res);
  if (!w) return;
  await prisma.workspaceMap.deleteMany({ where: { workspaceId: w.id, slug: req.params.mapSlug } });
  const left = await prisma.workspaceMap.findMany({
    where: { workspaceId: w.id }, orderBy: [{ order: "asc" }, { slug: "asc" }], select: { slug: true },
  });
  res.json({ ok: true, landing: left[0]?.slug, builtin: left.length ? undefined : (w.theme || "classic") });
});

app.delete("/workspaces/:slug/map", requireAuth, async (req: AuthedRequest, res) => {
  const w = await mapEditor(req, res);
  if (!w) return;
  // Deleting is how a space goes back to its stock layout, so it has to
  // succeed when there is nothing to delete — otherwise "reset" fails for the
  // one space that most obviously needs no resetting. It takes every map,
  // because half a building is not a layout anybody chose.
  await prisma.workspaceMap.deleteMany({ where: { workspaceId: w.id } });
  res.json({ ok: true, builtin: w.theme || "classic" });
});

// ---- who used the space, and when ----
//
// Written by the room server as people come and go, using the credential that
// let them in — the same arrangement chat history uses, so there is no second
// secret between the two services and no way to log a visit to a space you
// could not enter.

/** how long a space keeps its attendance, in days. 0 keeps everything. */
const STATS_KEEP_DAYS = Number(process.env.STATS_KEEP_DAYS || 365);

app.post("/workspaces/:slug/visits", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  // the same door chat uses: whoever may speak in this space may be counted in it
  const who = await speakerFor(req, w);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  const visit = await prisma.visit.create({
    data: {
      workspaceId: w.id,
      userId: who.userId,
      name: (who.name || "Guest").slice(0, 60),
      guest: !who.userId,
    },
    select: { id: true },
  });
  res.json({ id: visit.id });
});

/**
 * The visit ended.
 *
 * The id is the capability: it is a cuid handed back to the room server and to
 * nobody else, so knowing it is what proves the caller is the one that opened
 * the visit. The door is still checked, so a stranger cannot close visits in a
 * space they have no business in even if an id leaked.
 */
app.patch("/workspaces/:slug/visits/:id", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const who = await speakerFor(req, w);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  const visit = await prisma.visit.findUnique({ where: { id: req.params.id } });
  if (!visit || visit.workspaceId !== w.id) return res.status(404).json({ error: "not found" });
  if (visit.leftAt) return res.json({ ok: true, already: true });

  // seconds per "map/areaId" — trusted only as far as its shape, and only ever
  // summed, so a nonsense number skews a chart rather than breaking a query
  const raw = req.body?.areas;
  let areas: string | undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw).slice(0, 100)) {
      if (typeof k === "string" && k.length <= 100 && typeof v === "number" && Number.isFinite(v) && v >= 0) {
        clean[k] = Math.min(Math.round(v), 86_400);
      }
    }
    if (Object.keys(clean).length) areas = JSON.stringify(clean);
  }

  await prisma.visit.update({
    where: { id: visit.id },
    data: { leftAt: new Date(), ...(areas ? { areas } : {}) },
  });
  res.json({ ok: true });
});

/**
 * What the dashboard draws.
 *
 * Owners and admins only: this is who was where and for how long, which is a
 * different thing from who is online now. Everything is computed here rather
 * than in the browser so the page can stay a page — and so the numbers are the
 * same whoever opens it.
 */
app.get("/workspaces/:slug/stats", requireAuth, async (req: AuthedRequest, res) => {
  const w = await mapEditor(req, res);
  if (!w) return;

  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const visits = await prisma.visit.findMany({
    where: { workspaceId: w.id, joinedAt: { gte: from } },
    orderBy: { joinedAt: "asc" },
  });

  // A visit still open is somebody here now, or a session the server lost. It
  // counts as an arrival and contributes no time: guessing how long they stayed
  // would put invented hours in a report somebody makes decisions from.
  const closed = visits.filter((v) => v.leftAt);
  const secondsOf = (v: (typeof visits)[number]) =>
    Math.max(0, Math.round(((v.leftAt as Date).getTime() - v.joinedAt.getTime()) / 1000));

  // Days in the server's own time, not UTC — the hour buckets below already
  // are, and a report where "Tuesday" and "3pm" disagree about which clock they
  // are on is a report that quietly attributes an evening to the wrong day.
  const dayKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const daily = new Map<string, { day: string; visits: number; seconds: number; people: Set<string> }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * 86_400_000);
    daily.set(dayKey(d), { day: dayKey(d), visits: 0, seconds: 0, people: new Set() });
  }
  const hourly = new Array(24).fill(0);
  const people = new Map<string, { name: string; userId: string | null; guest: boolean; visits: number; seconds: number; last: string }>();
  const rooms = new Map<string, number>();

  for (const v of visits) {
    const row = daily.get(dayKey(v.joinedAt));
    if (row) row.visits++;
    const key = v.userId ?? `guest:${v.name}`;
    const p = people.get(key) ?? { name: v.name, userId: v.userId, guest: v.guest, visits: 0, seconds: 0, last: v.joinedAt.toISOString() };
    p.visits++;
    p.name = v.name; // the most recent name they went by
    if (v.joinedAt.toISOString() > p.last) p.last = v.joinedAt.toISOString();
    people.set(key, p);
    if (row) row.people.add(key);
  }

  for (const v of closed) {
    const secs = secondsOf(v);
    const row = daily.get(dayKey(v.joinedAt));
    if (row) row.seconds += secs;
    const key = v.userId ?? `guest:${v.name}`;
    const p = people.get(key);
    if (p) p.seconds += secs;

    // Spread the stay across the hours it actually covered, so a visit from
    // 09:40 to 11:10 reads as busy at ten rather than busy at nine.
    let cursor = v.joinedAt.getTime();
    const end = (v.leftAt as Date).getTime();
    while (cursor < end) {
      const hour = new Date(cursor).getHours();
      const nextHour = new Date(cursor).setMinutes(60, 0, 0);
      const slice = Math.min(end, nextHour) - cursor;
      hourly[hour] += Math.round(slice / 1000);
      cursor += slice;
    }

    if (v.areas) {
      try {
        for (const [k, secs2] of Object.entries(JSON.parse(v.areas) as Record<string, number>)) {
          rooms.set(k, (rooms.get(k) ?? 0) + (Number(secs2) || 0));
        }
      } catch { /* a row we cannot read is a row we leave out */ }
    }
  }

  // Names for the rooms, from the space's own maps. A key is "map/areaId", and
  // an empty area id is that map's open floor.
  const stored = await prisma.workspaceMap.findMany({ where: { workspaceId: w.id } });
  const labels = new Map<string, string>();
  for (const m of stored) {
    try {
      const doc = JSON.parse(m.data);
      labels.set(`${m.slug}/`, String(doc.label || m.slug));
      for (const a of doc.areas ?? []) labels.set(`${m.slug}/${a.id}`, String(a.label || a.id));
    } catch { /* an unreadable map still has a slug */ }
  }

  res.json({
    days,
    from: from.toISOString(),
    to: to.toISOString(),
    totals: {
      visits: visits.length,
      open: visits.length - closed.length,
      people: people.size,
      seconds: closed.reduce((n, v) => n + secondsOf(v), 0),
    },
    daily: [...daily.values()].map(({ day, visits: n, seconds, people: set }) => ({ day, visits: n, seconds, people: set.size })),
    hourly,
    people: [...people.values()].sort((a, b) => b.seconds - a.seconds || b.visits - a.visits).slice(0, 100),
    rooms: [...rooms.entries()]
      .map(([key, seconds]) => ({ key, label: labels.get(key) ?? (key.endsWith("/") ? key.slice(0, -1) : key.split("/")[1]), open: key.endsWith("/"), seconds }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 40),
  });
});

/** the same sweep chat gets, for the same reason: this table only ever grows */
async function sweepOldVisits() {
  if (!STATS_KEEP_DAYS) return;
  const cutoff = new Date(Date.now() - STATS_KEEP_DAYS * 86_400_000);
  const { count } = await prisma.visit.deleteMany({ where: { joinedAt: { lt: cutoff } } });
  if (count) console.log(`[stats] removed ${count} visit(s) older than ${STATS_KEEP_DAYS} days`);
}

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

// Anything the wrapper above forwards lands here: report it and stay alive, so a
// bad request can't take the API down for everyone else.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api] request failed:", err);
  if (res.headersSent) return;
  // A parser that refuses a body already knows why and says so with a status.
  // Answering 500 to all of them tells the caller the server broke when what
  // happened is that they sent something we do not take.
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 500) return res.status(status).json({ error: err?.type || "bad request" });
  res.status(500).json({ error: "internal error" });
});

void sweepOldMessages().catch((e) => console.error("[chat] sweep failed:", e));
setInterval(() => void sweepOldMessages().catch((e) => console.error("[chat] sweep failed:", e)), DAY_MS).unref();
void sweepOldVisits().catch((e) => console.error("[stats] sweep failed:", e));
setInterval(() => void sweepOldVisits().catch((e) => console.error("[stats] sweep failed:", e)), DAY_MS).unref();
void sweepOrphanUploads().catch((e) => console.error("[uploads] sweep failed:", e));
setInterval(() => void sweepOrphanUploads().catch((e) => console.error("[uploads] sweep failed:", e)), DAY_MS).unref();

if (!turnEnabled) console.warn("[ice] no TURN relay configured — calls will fail for anyone behind a strict firewall (set TURN_SECRET and TURN_HOST)");
app.listen(port, () => console.log(`[api] NexSpace API on http://localhost:${port}  (db: ${process.env.DATABASE_URL})`));
