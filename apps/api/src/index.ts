import "dotenv/config";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import express from "express";
import cors from "cors";
import { prisma } from "./db";
import {
  hashPassword, verifyPassword, createSession, activateSession, sessionFromToken,
  requireAuth, userFromToken, type AuthedRequest,
} from "./auth";
import { sendLoginCode, mailEnabled, mailTransport, sendInvite, sendBooking, sendReminder, mailCheck } from "./mailer";
import {
  levelForCabinet, levelForFolder, levelForDoc, whyForDoc, whyForFolder,
  atLeast, isLevel, isOpenTo, runsTheSpace,
  type Level, type Because,
} from "./cabinet.js";
import { iceConfig, turnEnabled } from "./ice";
import { mapDocProblem } from "./mapValidate";
import {
  AUDIO_KEEP_DAYS, TEXT_KEEP_DAYS, MAX_MINUTES as REC_MAX_MINUTES, TRACK_MAX_BYTES,
  acceptsAudio, audioExt, dropRecordingDir, dropTrack, mayRecord, CONSENT_MODE, startingConsent, noticeFacts,
  putTrack, trackPath,
} from "./recordings.js";
import { llmReady, runSummaryQueue, summariesReady, summaryCheck } from "./summarise.js";
import { GCAL_SCOPE, dropEvent, gcalCheck, gcalEnabled, pushEvent, readReplies } from "./gcal.js";
import {
  MS_SCOPE, msAuthUrl, msCheck, msDropEvent, msEnabled, msExchangeCode,
  msPushEvent, msReadReplies, msWhoIs,
} from "./mscal.js";
import {
  newTotpSecret, otpauthUri, qrDataUrl, checkTotp,
  newRecoveryCodes, hashRecoveryCodes, countRecoveryCodes, spendRecoveryCode,
} from "./totp";

import {
  UPLOAD_MAX_BYTES, absPathFor, accepts, allowedTypes, dropBytes, isImage,
  linkOk, putBytes, relPathFor, safeName, signedPath,
  serverKey,
} from "./uploads.js";
import {
  checkWhen, eventSig, ics, newCalendarKey, overlaps, reminderMoments, REMINDER_MAX_TIMES,
} from "./calendar.js";

const port = Number(process.env.PORT) || 3001;
const app = express();
app.use(cors());
/**
 * JSON bodies — everywhere except an upload.
 *
 * A file is posted as its own body with its own content-type, and one of the
 * types on the allowlist is `application/json`. Mounted globally this parser
 * reaches that request first, turns the file into an object, and leaves the
 * route holding something that is not a Buffer — so uploading a .json file
 * failed with "empty" while every other type worked.
 */
const jsonBody = express.json({ limit: "8mb" }); // maps can be large
const UPLOAD_PATH = /^\/workspaces\/[^/]+\/uploads$/;
// A recording track is audio bytes, not JSON, and it is far larger than a chat
// attachment. Same reasoning as above: the exact route, not a suffix.
const TRACK_PATH = /^\/workspaces\/[^/]+\/recordings\/[^/]+\/track$/;
app.use((req, res, next) =>
  // The exact route, not "ends with /uploads": a space is free to be called
  // "uploads", and a suffix test would then skip JSON parsing for every
  // settings request that space ever makes.
  req.method === "POST" && (UPLOAD_PATH.test(req.path) || TRACK_PATH.test(req.path))
    ? next() : jsonBody(req, res, next));

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

/**
 * Can this host actually reach the mail relay?
 *
 * `mail` above only says the settings are present, which is the question people
 * think they are asking and never the one that bites. This one opens the
 * connection and stops, so a deploy can tell "configured" from "configured and
 * unreachable" — the second of which looks identical until somebody invites
 * their first colleague.
 *
 * Owner and admin only: the answer names the relay host and repeats its refusal
 * verbatim, and neither is anybody else's business.
 */
/**
 * Is transcription and summarising configured, and does it answer?
 *
 * The same shape as the mail check, for the same reason: "it is set up" and "it
 * works" are different states that look identical from a settings page.
 */
app.get("/workspaces/:slug/summary-check", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const staff = await inviteStaff(req, w);
  if (!staff) return res.status(403).json({ error: "forbidden" });
  res.json(await summaryCheck());
});

app.get("/workspaces/:slug/mail-check", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const staff = await inviteStaff(req, w);
  if (!staff) return res.status(403).json({ error: "forbidden" });
  res.json(await mailCheck());
});

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
/**
 * The browser key the Google Picker needs.
 *
 * Not a secret the way a client secret is — it ships to the page and anybody
 * can read it — but it is still rationed: restricted to this origin in the
 * console, and handed out here only to somebody who is signed in, so it is not
 * a key sitting in a file the whole internet can fetch.
 */
const PICKER_KEY = process.env.GOOGLE_PICKER_KEY || "";
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

// ---- writing a booking into somebody's own Google Calendar ----------------------
//
// The subscribed feed beside this is Google's own eight-to-twenty-four hour
// refresh, which is right for seeing the month and useless for a room booked
// ten minutes ago. This is the other half, and it is per person: each
// individual grants `calendar.events` for their own account and can take it
// back, and nothing here can reach a calendar nobody connected.

/**
 * The redirect Google is told to come back to, registered in the console.
 *
 * Built from APP_URL rather than from the request, through the same helper
 * every other outward-facing link uses. Deriving it from the headers looks
 * right and is a guess about what the proxies in front of this server send:
 * this deployment sits behind Cloudflare and then behind something else, and
 * X-Forwarded-Proto does not survive the trip — so the URL came out as http://
 * on an https site, and Google refused it with redirect_uri_mismatch while
 * everything on both sides looked correctly configured.
 *
 * GCAL_REDIRECT_URL still wins, for a deployment where the callback is not on
 * the same origin as the app.
 */
const gcalRedirect = (req: express.Request) =>
  process.env.GCAL_REDIRECT_URL || `${appOriginOf(req)}/auth/google/calendar/callback`;

/**
 * Who asked, carried through Google and back, without a session token in a URL.
 *
 * A redirect cannot carry an Authorization header, and putting the session
 * token in the query string would write a working credential into nginx's logs
 * and the browser's history. So the authenticated request mints this instead: a
 * signed, short-lived note saying who it was for, worth nothing to anybody else
 * and nothing at all in ten minutes.
 */
const GCAL_STATE_MS = 10 * 60_000;
const gcalState = (userId: string, back: string) => {
  const exp = Date.now() + GCAL_STATE_MS;
  const body = Buffer.from(JSON.stringify({ u: userId, e: exp, b: back })).toString("base64url");
  const sig = createHmac("sha256", serverKey()).update(body).digest("base64url").slice(0, 32);
  return `${body}.${sig}`;
};
const readGcalState = (raw: string): { u: string; b: string } | null => {
  const [body, sig] = String(raw).split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", serverKey()).update(body).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(body, "base64url").toString()) as { u: string; e: number; b: string };
    if (!d.u || !(d.e > Date.now())) return null;
    return { u: d.u, b: d.b || "" };
  } catch { return null; }
};

/** what this person has connected, if anything */
app.get("/me/google-calendar", requireAuth, async (req: AuthedRequest, res) => {
  const row = await prisma.googleCalendar.findUnique({ where: { userId: req.user!.id } });
  res.json({
    available: gcalEnabled,
    // The exact string Google has to have been given. Not a secret — it is a
    // public URL on this host — and the one thing that cannot be worked out by
    // reading anything, since it is built from the headers the proxy in front
    // of this one sends. A redirect_uri_mismatch is otherwise a guessing game
    // between what was registered and what was sent.
    redirectUri: gcalRedirect(req),
    connected: !!row,
    email: row?.email ?? null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    // Said plainly, because a connection that has quietly stopped working looks
    // exactly like one that works until somebody books a room.
    lastError: row?.lastError ?? null,
  });
});

/** the address to send the browser to. Authenticated, so the state can be signed */
app.post("/me/google-calendar/start", requireAuth, (req: AuthedRequest, res) => {
  if (!gcalEnabled) return res.status(501).json({ error: "Google is not configured on this server" });
  const params = new URLSearchParams({
    client_id: GOOGLE_ID,
    redirect_uri: gcalRedirect(req),
    response_type: "code",
    scope: GCAL_SCOPE,
    // Both are required to be given a refresh token at all: offline asks for
    // one, and consent asks again on a re-connect that would otherwise be
    // answered silently and return none.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: req.user!.email,
    state: gcalState(req.user!.id, String((req.body ?? {}).back || "")),
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get("/auth/google/calendar/callback", async (req, res) => {
  const state = readGcalState(String(req.query.state || ""));
  const back = appUrl(req, state?.b || "");
  const done = (mark: string) => res.redirect(`${back}#gcal=${encodeURIComponent(mark)}`);

  if (!state) return done("expired");
  if (req.query.error) {
    console.warn("[gcal] the person refused, or Google did:", req.query.error);
    return done(String(req.query.error).slice(0, 40));
  }
  if (!req.query.code) return done("no_code");

  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET,
        redirect_uri: gcalRedirect(req),
        grant_type: "authorization_code",
      }),
    });
    const tok = (await r.json().catch(() => ({}))) as
      { access_token?: string; refresh_token?: string; scope?: string; error?: string };
    if (!tok.refresh_token) {
      // Without one the server can do nothing an hour from now, so a connection
      // that has only an access token is not a connection.
      console.error("[gcal] no refresh token came back:", JSON.stringify(tok).slice(0, 200));
      return done("no_refresh_token");
    }
    if (tok.scope && !tok.scope.includes(GCAL_SCOPE)) {
      console.warn("[gcal] the calendar scope was not granted:", tok.scope);
      return done("scope_refused");
    }

    // Which account was actually connected — not necessarily the one they sign
    // in to NexSpace with, and worth showing them either way.
    let email = "";
    if (tok.access_token) {
      const who = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { authorization: `Bearer ${tok.access_token}` },
      }).then((x) => x.json()).catch(() => ({}));
      email = normEmail((who as { email?: string }).email);
    }
    if (!email) {
      const me = await prisma.user.findUnique({ where: { id: state.u }, select: { email: true } });
      email = me?.email ?? "";
    }

    await prisma.googleCalendar.upsert({
      where: { userId: state.u },
      update: { refreshToken: tok.refresh_token, email, lastError: null, lastErrorAt: null, connectedAt: new Date() },
      create: { userId: state.u, refreshToken: tok.refresh_token, email },
    });
    console.log(`[gcal] ${email} connected a calendar`);
    done("connected");
  } catch (e) {
    console.error("[gcal] connecting failed:", e);
    done("failed");
  }
});

/**
 * Disconnect.
 *
 * Told to Google as well as forgotten here. Deleting the row alone would leave
 * a live grant on their account that nothing uses and nobody can see — the
 * point of disconnecting is that the permission stops existing.
 */
app.delete("/me/google-calendar", requireAuth, async (req: AuthedRequest, res) => {
  const row = await prisma.googleCalendar.findUnique({ where: { userId: req.user!.id } });
  if (!row) return res.json({ ok: true, already: true });
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(row.refreshToken)}`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
  }).catch((e) => console.warn("[gcal] revoke did not go through:", (e as Error).message));
  await prisma.googleCalendar.delete({ where: { userId: req.user!.id } });
  console.log(`[gcal] ${row.email} disconnected`);
  res.json({ ok: true });
});

/** does it still work? — asked without writing anything into the calendar */
app.get("/me/google-calendar/check", requireAuth, async (req: AuthedRequest, res) => {
  res.json(await gcalCheck(req.user!.id));
});

// ---- the same, for Outlook ------------------------------------------------------
//
// Deliberately a second set of routes rather than one with a provider in the
// path. Somebody may connect both, and then both are live at once and each is
// revoked on its own; a shared route would spend its whole body asking which.

const msRedirect = (req: express.Request) =>
  process.env.MS_REDIRECT_URL || `${appOriginOf(req)}/auth/microsoft/calendar/callback`;

app.get("/me/microsoft-calendar", requireAuth, async (req: AuthedRequest, res) => {
  const row = await prisma.microsoftCalendar.findUnique({ where: { userId: req.user!.id } });
  res.json({
    available: msEnabled,
    connected: !!row,
    email: row?.email ?? null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    redirectUri: msRedirect(req),
  });
});

app.post("/me/microsoft-calendar/start", requireAuth, (req: AuthedRequest, res) => {
  if (!msEnabled) return res.status(501).json({ error: "Microsoft is not configured on this server" });
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: msRedirect(req),
    response_mode: "query",
    scope: MS_SCOPE,
    // The account picker rather than whichever one the browser is already
    // signed in to: people have a work account and a personal one, and being
    // silently given the wrong calendar is worse than being asked.
    prompt: "select_account",
    login_hint: req.user!.email,
    state: gcalState(req.user!.id, String((req.body ?? {}).back || "")),
  });
  res.json({ url: msAuthUrl(params) });
});

app.get("/auth/microsoft/calendar/callback", async (req, res) => {
  const state = readGcalState(String(req.query.state || ""));
  const back = appUrl(req, state?.b || "");
  const done = (mark: string) => res.redirect(`${back}#mscal=${encodeURIComponent(mark)}`);

  if (!state) return done("expired");
  if (req.query.error) {
    console.warn("[mscal] the person refused, or Microsoft did:", req.query.error,
      String(req.query.error_description || "").slice(0, 120));
    return done(String(req.query.error).slice(0, 40));
  }
  if (!req.query.code) return done("no_code");

  try {
    const tok = await msExchangeCode(String(req.query.code), msRedirect(req));
    if (!tok.refresh_token) {
      console.error("[mscal] no refresh token came back:",
        (tok.error_description || tok.error || "").slice(0, 200));
      return done("no_refresh_token");
    }
    const email = (tok.access_token ? await msWhoIs(tok.access_token) : "")
      || (await prisma.user.findUnique({ where: { id: state.u }, select: { email: true } }))?.email
      || "";

    await prisma.microsoftCalendar.upsert({
      where: { userId: state.u },
      update: { refreshToken: tok.refresh_token, email, lastError: null, lastErrorAt: null, connectedAt: new Date() },
      create: { userId: state.u, refreshToken: tok.refresh_token, email },
    });
    console.log(`[mscal] ${email} connected a calendar`);
    done("connected");
  } catch (e) {
    console.error("[mscal] connecting failed:", e);
    done("failed");
  }
});

/**
 * Disconnect.
 *
 * Microsoft has no revoke endpoint a client can call for one grant — the
 * person removes it from their account page. So this forgets the token, which
 * is what stops this server acting, and says where to finish the job.
 */
app.delete("/me/microsoft-calendar", requireAuth, async (req: AuthedRequest, res) => {
  const row = await prisma.microsoftCalendar.findUnique({ where: { userId: req.user!.id } });
  if (!row) return res.json({ ok: true, already: true });
  await prisma.microsoftCalendar.delete({ where: { userId: req.user!.id } });
  console.log(`[mscal] ${row.email} disconnected`);
  res.json({ ok: true, revokeAt: "https://account.live.com/consent/Manage" });
});

app.get("/me/microsoft-calendar/check", requireAuth, async (req: AuthedRequest, res) => {
  res.json(await msCheck(req.user!.id));
});



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

/**
 * Where the app lives, from the request that arrived.
 *
 * In production nginx serves the app and proxies this API on one host, so
 * the host a request came in on IS the app. Used for the links that go into
 * email and into a calendar client, both of which are read somewhere else
 * entirely, where a relative path is no use.
 */
const appOriginOf = (req: express.Request) =>
  // APP_URL first. Deriving it from the request is right in production, where
  // nginx serves the app and proxies this API on one host — and wrong the moment
  // they are two hosts, which in development they always are: the invite link
  // came out pointing at the API's own port, where there is no app to open it.
  // Trailing slash trimmed, because every caller appends "/?w=..." to this and
  // an APP_URL written the natural way — with the slash a browser shows — came
  // out as https://host//?w=... in the invitation email and in the URL inside
  // the .ics. Legal, and it looks like a mistake to the person reading it.
  (process.env.APP_URL
    || `${req.header("x-forwarded-proto") || req.protocol}://${req.header("x-forwarded-host") || req.get("host")}`
  ).replace(/\/+$/, "");

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
  // Logged in but not a member yet — a guest visit, and named as one. Leaving
  // the role out let the client fall back to "member", so somebody who had done
  // nothing but open a link was treated inside the room as though they belonged
  // to the space.
  res.json({
    allowed: w.allowGuests, reason: w.allowGuests ? "guest" : "members-only",
    ...(w.allowGuests ? { role: "guest", userId: user.id } : {}),
    name: w.name,
  });
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

// ---- invitations, addressed to one person -------------------------------------

/** how long an emailed invitation stays good */
const INVITE_DAYS = Number(process.env.INVITE_DAYS || 14);

type InviteState = "pending" | "accepted" | "revoked" | "expired";

function inviteState(i: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }): InviteState {
  if (i.acceptedAt) return "accepted";
  if (i.revokedAt) return "revoked";
  if (+i.expiresAt <= Date.now()) return "expired";
  return "pending";
}

/**
 * One invitation, as the panel needs it.
 *
 * The token is the link, so it is only handed to somebody who could send the
 * invitation in the first place — and even then only while it is still worth
 * copying. A spent or revoked invitation is a record, not a way in.
 */
function inviteView(
  i: {
    id: string; email: string; role: string; token: string; invitedByName: string;
    createdAt: Date; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; sentAt: Date | null;
  },
  req: express.Request,
  slug: string,
  staff: boolean,
) {
  const state = inviteState(i);
  return {
    id: i.id, email: i.email, role: i.role, state,
    invitedBy: i.invitedByName, createdAt: i.createdAt, expiresAt: i.expiresAt,
    // Whether the email actually left. Nobody can tell from the list otherwise,
    // and "invited" that never sent looks the same as "invited and ignored".
    emailed: !!i.sentAt,
    ...(staff && state === "pending" ? { link: inviteLinkFor(req, slug, i.token) } : {}),
  };
}

/** the address in the email, and the one an admin copies by hand when SMTP is off */
function inviteLinkFor(req: express.Request, slug: string, token: string) {
  const origin = appOriginOf(req);
  return `${origin}/?w=${encodeURIComponent(slug)}&invite=${encodeURIComponent(token)}`;
}

/** owner/admin of this space, or null — invitations are staff work */
async function inviteStaff(req: express.Request, w: { id: string }) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") || String(req.query.token || "");
  const me = await userFromToken(token || undefined);
  if (!me) return null;
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: me.id, workspaceId: w.id } },
  });
  if (!m || (m.role !== "owner" && m.role !== "admin")) return null;
  return { me, role: m.role };
}

/** who has been asked, and who has not answered */
app.get("/workspaces/:slug/invites", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const staff = await inviteStaff(req, w);
  if (!staff) return res.status(403).json({ error: "forbidden" });

  const rows = await prisma.invite.findMany({
    where: { workspaceId: w.id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ invites: rows.map((i) => inviteView(i, req, w.slug, true)) });
});

/**
 * Ask somebody to join.
 *
 * Sending the email is allowed to fail. The invitation still exists and still
 * carries a link an admin can hand over by hand — which is the whole reason
 * `emailed` is in the answer. A deployment with no SMTP is a deployment where
 * inviting people still works, slightly manually.
 */
app.post("/workspaces/:slug/invites", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const staff = await inviteStaff(req, w);
  if (!staff) return res.status(403).json({ error: "forbidden" });

  const email = String((req.body ?? {}).email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: "that is not an email address" });
  }
  const want = String((req.body ?? {}).role ?? "member");
  if (!["member", "admin"].includes(want)) return res.status(400).json({ error: "bad role" });
  // The same ceiling as changing somebody's role: an admin cannot mint another
  // admin, or one admin could fill the space with people able to remove them.
  if (want === "admin" && staff.role !== "owner") {
    return res.status(403).json({ error: "only the owner can invite an admin" });
  }

  // Already here? Then this is not an invitation, and saying so is more use
  // than sending them a link that does nothing.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const m = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: existing.id, workspaceId: w.id } },
    });
    if (m) return res.status(409).json({ error: "they are already in this space", role: m.role });
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_DAYS * DAY_MS);
  // A second ask replaces the first rather than stacking: the newest link is
  // the one that works, and two live invitations to one address is a way to
  // confuse everybody including the person invited.
  const row = await prisma.invite.upsert({
    where: { workspaceId_email: { workspaceId: w.id, email } },
    create: {
      workspaceId: w.id, email, role: want, token, expiresAt,
      invitedById: staff.me.id, invitedByName: staff.me.name,
    },
    update: {
      role: want, token, expiresAt, acceptedAt: null, revokedAt: null, sentAt: null,
      invitedById: staff.me.id, invitedByName: staff.me.name,
    },
  });

  let emailed = false;
  try {
    emailed = await sendInvite({
      to: email, space: w.name, invitedBy: staff.me.name, invitedByEmail: staff.me.email,
      link: inviteLinkFor(req, w.slug, token), days: INVITE_DAYS,
    });
  } catch (e) {
    // Said out loud, once, and not fatal. The row exists and the link is in the
    // answer, so the invitation is not lost because a mail server was.
    console.warn("[invite] could not send the email:", e);
  }
  if (emailed) await prisma.invite.update({ where: { id: row.id }, data: { sentAt: new Date() } });

  const fresh = await prisma.invite.findUnique({ where: { id: row.id } });
  res.json({ invite: inviteView(fresh!, req, w.slug, true), emailed });
});

/** take it back */
app.delete("/workspaces/:slug/invites/:id", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const staff = await inviteStaff(req, w);
  if (!staff) return res.status(403).json({ error: "forbidden" });

  const i = await prisma.invite.findUnique({ where: { id: req.params.id } });
  if (!i || i.workspaceId !== w.id) return res.status(404).json({ error: "not found" });
  // Revoked rather than deleted: "we asked and then changed our mind" is a
  // thing somebody may need to see, and the row is what says it.
  const gone = await prisma.invite.update({
    where: { id: i.id }, data: { revokedAt: i.revokedAt ?? new Date() },
  });
  res.json({ invite: inviteView(gone, req, w.slug, true) });
});

/**
 * Read an invitation without spending it.
 *
 * The link lands on the app before anybody has signed in, and the page wants to
 * say which space and who asked. Unauthenticated by design — the token in the
 * URL is the credential — and it deliberately does not say whether an account
 * for that address exists.
 */
app.get("/invites/:token", async (req, res) => {
  const i = await prisma.invite.findUnique({
    where: { token: String(req.params.token) },
    include: { workspace: { select: { slug: true, name: true } } },
  });
  if (!i) return res.status(404).json({ error: "not found" });
  res.json({
    invite: {
      email: i.email, role: i.role, state: inviteState(i),
      invitedBy: i.invitedByName, space: i.workspace.name, slug: i.workspace.slug,
      expiresAt: i.expiresAt,
    },
  });
});

/**
 * Spend it.
 *
 * Bound to the address it was sent to. An invitation addressed to one person
 * that anybody who received a forward could redeem would be the workspace's
 * shared invite code again, wearing somebody's name — and the pending list
 * would be telling a story that is not true.
 */
app.post("/invites/:token/accept", requireAuth, async (req: AuthedRequest, res) => {
  const i = await prisma.invite.findUnique({
    where: { token: String(req.params.token) },
    include: { workspace: true },
  });
  if (!i) return res.status(404).json({ error: "not found" });

  const state = inviteState(i);
  if (state !== "pending") return res.status(410).json({ error: state });
  if (req.user!.email.trim().toLowerCase() !== i.email) {
    return res.status(403).json({ error: "this invitation was sent to a different address", email: i.email });
  }

  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: req.user!.id, workspaceId: i.workspaceId } },
    create: { userId: req.user!.id, workspaceId: i.workspaceId, role: i.role },
    // Already a member somehow: leave the role they have. An invitation should
    // not quietly demote somebody who was promoted while it sat in an inbox.
    update: {},
  });
  await prisma.invite.update({ where: { id: i.id }, data: { acceptedAt: new Date() } });
  res.json({ workspace: wsView(i.workspace, i.role) });
});

/** invitations nobody answered, long after they stopped working */
async function sweepOldInvites() {
  const cutoff = new Date(Date.now() - Number(process.env.INVITE_KEEP_DAYS || 90) * DAY_MS);
  const { count } = await prisma.invite.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count) console.log(`[invite] removed ${count} invitation(s) older than the keep window`);
}

// ---- rooms, held for a while --------------------------------------------------

/** how far a listing may reach in one request */
const CAL_WINDOW_DAYS = Number(process.env.BOOKING_WINDOW_DAYS || 60);

/**
 * The people the host put on a meeting.
 *
 * Two fields on the form and one list here, because the difference between a
 * colleague and a guest is not a thing the browser gets to decide: it is
 * whether the address belongs to somebody in this space, which only the server
 * can answer. A client that says "this outsider is a member" changes nothing.
 *
 * Addresses are normalised and de-duplicated, the host is dropped — they are
 * already on it — and the whole thing is capped. An invitation list is a thing
 * that sends email, and an uncapped one is a way to send a great deal of it.
 */
const MAX_INVITEES = Number(process.env.BOOKING_MAX_INVITEES || 50);

async function readInvitees(
  raw: unknown,
  w: { id: string },
  host: { id: string; email: string },
) {
  const wanted = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>([normEmail(host.email)]);
  const emails: string[] = [];
  for (const one of wanted) {
    const email = normEmail(one);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
    if (emails.length >= MAX_INVITEES) break;
  }
  if (!emails.length) return [];

  // Who among them is actually in this space. Asked of the membership table
  // rather than taken from the request, so "member" means member.
  const members = await prisma.membership.findMany({
    where: { workspaceId: w.id, user: { email: { in: emails } } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const byEmail = new Map(members.map((m) => [normEmail(m.user.email), m.user]));

  return emails.map((email) => {
    const known = byEmail.get(email);
    return {
      email,
      name: known?.name || email,
      userId: known?.id ?? null,
    };
  });
}

type BookingRow = {
  id: string; mapSlug: string; roomId: string; roomLabel: string; title: string;
  userId: string | null; hostName: string; startsAt: Date; endsAt: Date; createdAt: Date;
  going?: { userId: string }[];
  invitees?: { email: string; name: string; userId: string | null; reply?: string }[];
  reminders?: {
    method: string; minutes: number; sentAt?: Date | null;
    repeat?: string; times?: number; sentCount?: number;
  }[];
};

function bookingView(b: BookingRow, meId: string | null | undefined, slug: string) {
  return {
    id: b.id, mapSlug: b.mapSlug, roomId: b.roomId, room: b.roomLabel,
    title: b.title, host: b.hostName, hostId: b.userId,
    startsAt: b.startsAt, endsAt: b.endsAt,
    // "add this one to my calendar". Signed here because the browser cannot
    // compute it — without this the .ics route below had no caller at all.
    ics: `/workspaces/${encodeURIComponent(slug)}/bookings/${b.id}.ics?sig=${eventSig(serverKey(), b.id)}`,
    going: (b.going ?? []).length,
    // whether I said I am coming, and whether this is mine to cancel — both
    // questions the browser would otherwise answer by guessing
    imGoing: !!meId && (b.going ?? []).some((g) => g.userId === meId),
    mine: !!meId && b.userId === meId,
    // Who was asked, and who has answered. Two different facts, and a meeting
    // where three of five have replied reads as neither if they are merged.
    invitees: (b.invitees ?? []).map((i) => ({
      email: i.email,
      name: i.name,
      member: !!i.userId,
      going: !!i.userId && (b.going ?? []).some((g) => g.userId === i.userId),
      // needsAction | accepted | declined | tentative — Google's own words,
      // read back off the host's calendar. "Has not replied" is a state, and
      // folding it into "not coming" loses the difference that matters.
      reply: i.reply ?? "needsAction",
    })),
    // What the host asked for, so the browser can draw the popup ones at the
    // times that were chosen rather than at a time this app picked.
    reminders: (b.reminders ?? []).map((r) => ({
      method: r.method, minutes: r.minutes,
      repeat: r.repeat ?? "none", times: r.times ?? 1, sentCount: r.sentCount ?? 0,
      // When the email actually went. Null on a popup, which the browser does,
      // and null on one whose moment has not come — the difference between
      // "will be sent" and "was sent" is the whole question somebody asks when
      // an expected email has not arrived, and it was not answerable anywhere.
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    })),
  };
}

/**
 * Who may book, as opposed to who may look.
 *
 * Looking is for anybody who may be in the space, guests included — walking up
 * to a meeting room and being told it is taken is the whole point. Booking is
 * for accounts: a room held by somebody whose pass expires tonight is a room
 * nobody can give back.
 */
async function booker(req: express.Request, w: { id: string }) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") || String(req.query.token || "");
  const me = await userFromToken(token || undefined);
  if (!me) return null;
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: me.id, workspaceId: w.id } },
  });
  return m && m.role !== "guest" ? { me, role: m.role } : null;
}

/** what is on, between two moments */
app.get("/workspaces/:slug/bookings", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const who = await speakerFor(req, w);
  if (!who) return res.status(401).json({ error: "unauthorized" });

  const from = req.query.from ? new Date(String(req.query.from)) : new Date();
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(+from + CAL_WINDOW_DAYS * DAY_MS);
  if (isNaN(+from) || isNaN(+to) || +to <= +from) return res.status(400).json({ error: "bad range" });
  // A listing is a page, not a database dump: without a ceiling, "from 1970 to
  // 3000" is a request that reads every row this space has ever written.
  const end = new Date(Math.min(+to, +from + CAL_WINDOW_DAYS * DAY_MS));

  const rows = await prisma.booking.findMany({
    where: {
      workspaceId: w.id,
      ...(req.query.map ? { mapSlug: String(req.query.map) } : {}),
      // anything overlapping the window, not merely starting inside it — a
      // meeting that began before the window is still on
      startsAt: { lt: end },
      endsAt: { gt: from },
    },
    orderBy: { startsAt: "asc" },
    take: 500,
    include: {
      going: { select: { userId: true } },
      invitees: { select: { email: true, name: true, userId: true, reply: true } },
      reminders: { select: { method: true, minutes: true, sentAt: true, repeat: true, times: true, sentCount: true } },
    },
  });
  res.json({ bookings: rows.map((b) => bookingView(b, who.userId, w.slug)) });
});

/** hold a room */
/**
 * Tell people about a booking, in a calendar they already use.
 *
 * The list is whoever said they are coming, which the create route seeds with
 * the host — booking a room is saying you will be there, so nobody has to be
 * invited separately for the ordinary case of one person holding a room.
 *
 * Never awaited by a route and never able to fail one. A meeting that exists
 * and did not send an email is a smaller problem than a meeting that could not
 * be booked because a mail API was slow, and the booking is the thing the
 * person pressed a button for.
 */
async function tellAboutBooking(
  req: express.Request,
  w: { id: string; slug: string; name: string },
  b: BookingRow,
  method: "REQUEST" | "CANCEL",
  only?: string,
) {
  // Out loud, because silence here is indistinguishable from a mail that went.
  // "Did booking send an email?" was unanswerable on a deployment with no
  // transport: nothing was logged, nothing was sent, and nothing said so.
  if (!mailEnabled) {
    console.log(`[calendar] ${method} for "${b.title}" told nobody — no mail transport is configured`);
    return;
  }
  try {
    const going = await prisma.bookingGoing.findMany({
      where: { bookingId: b.id, ...(only ? { userId: only } : {}) },
      include: { user: { select: { email: true, name: true } } },
    });
    // A cancellation has to reach whoever was going, and by the time it is sent
    // the rows are gone — so the caller passes them in that case.
    const people = going.map((g) => g.user).filter((u) => u?.email);
    if (!people.length) return;

    const host = b.userId
      ? await prisma.user.findUnique({ where: { id: b.userId }, select: { email: true, name: true } })
      : null;
    const url = `${appOriginOf(req)}/?w=${encodeURIComponent(w.slug)}&m=${encodeURIComponent(b.mapSlug)}`;

    for (const p of people) {
      // Said on the way out as well as on the way wrong. Only failures were
      // logged, so a working send and a send that never happened looked exactly
      // the same from the server — and "did the booking email go?" had no
      // answer short of asking the recipient.
      await sendBooking({
        to: p.email, toName: p.name || p.email,
        space: w.name, booking: b, method, url,
        organizer: host?.email ? { name: b.hostName, email: host.email } : undefined,
      })
        .then((sent) => console.log(
          sent
            ? `[calendar] ${method} for "${b.title}" sent to ${p.email}`
            : `[calendar] ${method} for "${b.title}" not sent to ${p.email} — no mail transport is configured`,
        ))
        .catch((e) => console.warn(`[calendar] ${method} to ${p.email} did not go:`, e));
    }
  } catch (e) {
    console.warn("[calendar] could not tell anybody about the booking:", e);
  }
}

/** the same, for people whose "going" rows are about to stop existing */
/**
 * Put a booking into the calendars of the people who said they are coming.
 *
 * Best effort, and never able to fail the thing it is about: a room is held
 * whether or not Google answered. Called without awaiting, like the invitation
 * email beside it and for the same reason — the person who pressed the button
 * is waiting on the booking, not on a third party.
 *
 * Only people who connected a calendar have one written. There is no way for
 * this to reach anybody else, because there is no token for anybody else.
 */
async function addToGoogle(
  req: express.Request,
  w: { slug: string },
  b: BookingRow,
  only?: string,
  invite: { email: string; name: string }[] = [],
): Promise<boolean> {
  if (!gcalEnabled && !msEnabled) return false;
  let invited = false;
  try {
    const going = await prisma.bookingGoing.findMany({
      where: { bookingId: b.id, ...(only ? { userId: only } : {}) },
    });
    if (!going.length) return false;
    const url = `${appOriginOf(req)}/?w=${encodeURIComponent(w.slug)}&m=${encodeURIComponent(b.mapSlug)}`;
    for (const g of going) {
      // The guest list goes on the host's copy and nowhere else — see asEvent.
      const guests = g.userId === b.userId ? invite : [];
      const one = {
        id: b.id, title: b.title, roomLabel: b.roomLabel, hostName: b.hostName,
        startsAt: b.startsAt, endsAt: b.endsAt, url,
      };

      if (!g.googleEventId) {
        const id = await pushEvent(g.userId, one, guests)
          .catch((e) => { console.warn("[gcal] add failed:", (e as Error).message); return null; });
        if (id) {
          if (guests.length) invited = true;
          await prisma.bookingGoing.update({
            where: { bookingId_userId: { bookingId: b.id, userId: g.userId } },
            data: { googleEventId: id },
          }).catch(() => {});
        }
      }

      // And the same into Outlook, for whoever connected that instead — or as
      // well. Both is a real answer: the meeting then sits in both calendars,
      // which is what somebody who keeps two of them is asking for.
      if (!g.msEventId) {
        const id = await msPushEvent(g.userId, one, guests)
          .catch((e) => { console.warn("[mscal] add failed:", (e as Error).message); return null; });
        if (id) {
          if (guests.length) invited = true;
          await prisma.bookingGoing.update({
            where: { bookingId_userId: { bookingId: b.id, userId: g.userId } },
            data: { msEventId: id },
          }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.warn("[gcal] could not add the booking to anybody's calendar:", e);
  }
  return invited;
}

/**
 * Take it back out.
 *
 * Given the rows before they are deleted, because by the time a booking is
 * cancelled there is nothing left to look up. An event id that is already gone
 * from Google is not a failure — it is the state that was wanted.
 */
async function removeFromGoogle(
  rows: { userId: string; googleEventId: string | null; msEventId?: string | null }[],
  hostId?: string | null,
): Promise<boolean> {
  let told = false;
  for (const g of rows) {
    // Deleting the host's copy is the cancellation everybody hears about.
    const tellGuests = !!hostId && g.userId === hostId;
    if (gcalEnabled && g.googleEventId) {
      const gone = await dropEvent(g.userId, g.googleEventId, tellGuests)
        .catch((e) => { console.warn("[gcal] remove failed:", (e as Error).message); return false; });
      if (gone && tellGuests) told = true;
    }
    // Outlook needs no flag: Graph decides it is a cancellation from whose
    // calendar the event was in, which is one fewer thing to forget.
    if (msEnabled && g.msEventId) {
      const gone = await msDropEvent(g.userId, g.msEventId)
        .catch((e) => { console.warn("[mscal] remove failed:", (e as Error).message); return false; });
      if (gone && tellGuests) told = true;
    }
  }
  return told;
}

async function tellTheseAboutBooking(
  req: express.Request,
  w: { id: string; slug: string; name: string },
  b: BookingRow,
  people: { email: string; name: string }[],
  method: "REQUEST" | "CANCEL" = "CANCEL",
) {
  if (!people.length) return;
  if (!mailEnabled) {
    console.log(`[calendar] ${method} for "${b.title}" told nobody — no mail transport is configured`);
    return;
  }
  const host = b.userId
    ? await prisma.user.findUnique({ where: { id: b.userId }, select: { email: true } })
    : null;
  const url = `${appOriginOf(req)}/?w=${encodeURIComponent(w.slug)}&m=${encodeURIComponent(b.mapSlug)}`;
  for (const p of people) {
    await sendBooking({
      to: p.email, toName: p.name || p.email,
      space: w.name, booking: b, method, url,
      organizer: host?.email ? { name: b.hostName, email: host.email } : undefined,
    })
      .then((sent) => { if (sent) console.log(`[calendar] ${method} for "${b.title}" sent to ${p.email}`); })
      .catch((e) => console.warn(`[calendar] ${method} to ${p.email} did not go:`, e));
  }
}

app.post("/workspaces/:slug/bookings", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const title = String(body.title ?? "").trim().slice(0, 120);
  const roomId = String(body.roomId ?? "").trim().slice(0, 60);
  const roomLabel = String(body.roomLabel ?? "").trim().slice(0, 80) || roomId;
  const mapSlug = String(body.mapSlug ?? "main").trim().slice(0, 60) || "main";
  if (!title) return res.status(400).json({ error: "a meeting needs a name" });
  if (!roomId) return res.status(400).json({ error: "which room?" });

  const startsAt = new Date(String(body.startsAt ?? ""));
  const endsAt = new Date(String(body.endsAt ?? ""));
  const wrong = checkWhen(startsAt, endsAt);
  if (wrong) return res.status(400).json(wrong);

  // Everything already in this room that could touch the new span. Read and
  // checked here rather than left to a unique constraint, because "overlapping"
  // is not something a database index can express.
  const near = await prisma.booking.findMany({
    where: { workspaceId: w.id, mapSlug, roomId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    orderBy: { startsAt: "asc" },
  });
  const clash = near.find((b) => overlaps(b, { startsAt, endsAt }));
  if (clash) {
    return res.status(409).json({
      error: "that room is taken then",
      clash: { title: clash.title, host: clash.hostName, startsAt: clash.startsAt, endsAt: clash.endsAt },
    });
  }

  const asked = await readInvitees(body.invitees, w, can.me);
  const remind = readReminders(body.reminders);

  const b = await prisma.booking.create({
    data: {
      workspaceId: w.id, mapSlug, roomId, roomLabel, title,
      userId: can.me.id, hostName: can.me.name, startsAt, endsAt,
      // Booking it is saying you will be there. Anything else would mean the
      // person who called the meeting is the one person it does not remind.
      going: { create: { userId: can.me.id } },
      // Invited, not coming. They answer for themselves, in the app if they
      // have an account here and in their own calendar if they do not.
      invitees: { create: asked },
      reminders: { create: remind },
    },
    include: {
      going: { select: { userId: true } },
      invitees: { select: { email: true, name: true, userId: true, reply: true } },
      reminders: { select: { method: true, minutes: true, sentAt: true, repeat: true, times: true, sentCount: true } },
    },
  });
  res.json({ booking: bookingView(b, can.me.id, w.slug) });

  /**
   * Telling people, after the answer. The room is held either way.
   *
   * Whichever of the two can do it better. If the host has connected a Google
   * Calendar, the guest list goes on the event and Google sends its own
   * invitation — the one with Yes/No/Maybe, the guest list, and replies that
   * come back to the host's calendar instead of to a mailbox nobody reads.
   * Only if that does not happen do we put something in an envelope ourselves,
   * because two invitations to one meeting is worse than either.
   */
  // Said at the moment they are created, because "did the reminder row get
  // written" and "has its moment not come yet" look identical from outside and
  // the second one is a wait with no way to tell it from a failure.
  console.log(remind.length
    ? `[calendar] "${b.title}" — ${remind.length} reminder(s): ${
        remind.map((r) => `${r.method} ${r.minutes}m${r.repeat === "none" ? "" : ` ×${r.times} ${r.repeat}`}`).join(", ")}`
    : `[calendar] "${b.title}" — no reminders asked for`);

  void (async () => {
    const viaGoogle = await addToGoogle(req, w, b as BookingRow, undefined, asked);
    if (viaGoogle) {
      console.log(`[calendar] "${b.title}" — Google invited ${asked.length} guest(s) for ${can.me.name}`);
      return;
    }
    void tellAboutBooking(req, w, b as BookingRow, "REQUEST");
    void tellTheseAboutBooking(req, w, b as BookingRow, asked, "REQUEST");
  })();
});

/** "I am coming" / "I am not" */
app.post("/workspaces/:slug/bookings/:id/going", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const b = await prisma.booking.findUnique({ where: { id: req.params.id } });
  if (!b || b.workspaceId !== w.id) return res.status(404).json({ error: "not found" });

  const coming = (req.body ?? {}).going !== false;
  const already = await prisma.bookingGoing.findUnique({
    where: { bookingId_userId: { bookingId: b.id, userId: can.me.id } },
  });
  if (coming) {
    await prisma.bookingGoing.upsert({
      where: { bookingId_userId: { bookingId: b.id, userId: can.me.id } },
      update: {}, create: { bookingId: b.id, userId: can.me.id },
    });
  } else {
    await prisma.bookingGoing.deleteMany({ where: { bookingId: b.id, userId: can.me.id } });
  }
  // Only on a change of mind. Pressing "coming" twice is not a second meeting,
  // and sending the invitation again would put a duplicate in their calendar.
  if (coming && !already) {
    void tellAboutBooking(req, w, b as BookingRow, "REQUEST", can.me.id);
    void addToGoogle(req, w, b as BookingRow, can.me.id);
  } else if (!coming && already) {
    void tellTheseAboutBooking(req, w, b as BookingRow, [{ email: can.me.email, name: can.me.name }]);
    // Their own copy, out of their own calendar. Everybody else who is coming
    // keeps theirs.
    void removeFromGoogle([{
      userId: can.me.id, googleEventId: already.googleEventId, msEventId: already.msEventId,
    }]);
  }
  const after = await prisma.booking.findUnique({
    where: { id: b.id },
    include: {
      going: { select: { userId: true } },
      invitees: { select: { email: true, name: true, userId: true, reply: true } },
      reminders: { select: { method: true, minutes: true, sentAt: true, repeat: true, times: true, sentCount: true } },
    },
  });
  res.json({ booking: bookingView(after as BookingRow, can.me.id, w.slug) });
});

/**
 * Give the room back.
 *
 * The host, or somebody who runs the space. An admin needs it because the
 * person who booked the room every Tuesday has left, and the room should not
 * be theirs forever.
 */
app.delete("/workspaces/:slug/bookings/:id", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const b = await prisma.booking.findUnique({ where: { id: req.params.id } });
  if (!b || b.workspaceId !== w.id) return res.status(404).json({ error: "not found" });

  const staff = can.role === "owner" || can.role === "admin";
  if (b.userId !== can.me.id && !staff) return res.status(403).json({ error: "not yours to cancel" });

  // Read before the delete, because the rows go with it. Everyone who was
  // coming has this in their calendar now, and a cancelled meeting that stays
  // in the calendar is worse than one that was never sent: people turn up.
  const rows = await prisma.bookingGoing.findMany({
    where: { bookingId: b.id },
    include: { user: { select: { email: true, name: true } } },
  });
  const inGoogle = rows.map((g) => ({
    userId: g.userId, googleEventId: g.googleEventId, msEventId: g.msEventId,
  }));

  // Everybody who was told this meeting exists, whether or not they answered.
  // A cancellation that only reaches the people who said yes leaves the rest
  // holding an invitation to a meeting that is off — and their calendar keeps
  // it, because a CANCEL is the only thing that takes one out.
  const invited = await prisma.bookingInvitee.findMany({
    where: { bookingId: b.id }, select: { email: true, name: true },
  });
  const byEmail = new Map<string, { email: string; name: string }>();
  for (const u of rows.map((g) => g.user)) if (u?.email) byEmail.set(u.email, u);
  for (const i of invited) if (!byEmail.has(i.email)) byEmail.set(i.email, i);
  const were = [...byEmail.values()];

  await prisma.booking.delete({ where: { id: b.id } });
  res.json({ ok: true });
  void (async () => {
    const viaGoogle = await removeFromGoogle(inGoogle, b.userId);
    if (viaGoogle) {
      console.log(`[calendar] "${b.title}" — Google told the guests it is off`);
      return;
    }
    void tellTheseAboutBooking(req, w, b as BookingRow, were);
  })();
});

// ---- getting it into a real calendar ------------------------------------------

/**
 * Bring the answers back from Google.
 *
 * Somebody presses Yes in Gmail and Google writes it on its own event. Nothing
 * tells this server, and there is no callback to subscribe to that does not
 * involve a public HTTPS endpoint Google can reach and a channel to keep
 * renewing — so this asks, on a timer, about the meetings where an answer could
 * still arrive.
 *
 * Only meetings that have not finished, only ones whose host has a connected
 * calendar and an event in it, and a ceiling per pass. A calendar with four
 * hundred bookings in it is not a reason to make four hundred requests every
 * five minutes.
 */
const REPLY_SWEEP_MS = Number(process.env.BOOKING_REPLY_SWEEP_MS || 5 * 60_000);
const REPLY_SWEEP_MAX = Number(process.env.BOOKING_REPLY_SWEEP_MAX || 40);

let sweepingReplies = false;

async function syncBookingReplies(): Promise<void> {
  if (sweepingReplies || (!gcalEnabled && !msEnabled)) return;
  sweepingReplies = true;
  try {
    const now = new Date();
    const rows = await prisma.booking.findMany({
      where: {
        endsAt: { gt: now },
        // Somebody has to have been asked, or there is nothing to read.
        invitees: { some: {} },
      },
      orderBy: { startsAt: "asc" },
      take: REPLY_SWEEP_MAX,
      include: {
        invitees: true,
        going: { select: { userId: true, googleEventId: true, msEventId: true } },
      },
    });

    for (const b of rows) {
      if (!b.userId) continue;                       // the host's account is gone
      const hosts = b.going.find((g) => g.userId === b.userId);
      if (!hosts) continue;

      // Whichever calendar carries the guest list. If somebody connected both,
      // the two say the same thing and reading either is enough — so the first
      // one that answers wins, rather than asking twice every five minutes.
      const said =
        (hosts.googleEventId
          ? await readReplies(b.userId, hosts.googleEventId)
            .catch((e) => { console.warn("[gcal] reading replies failed:", (e as Error).message); return null; })
          : null)
        ?? (hosts.msEventId
          ? await msReadReplies(b.userId, hosts.msEventId)
            .catch((e) => { console.warn("[mscal] reading replies failed:", (e as Error).message); return null; })
          : null);
      if (!said) continue;                           // unreadable is not "nobody replied"

      const byEmail = new Map(said.map((a) => [a.email, a.reply]));
      for (const who of b.invitees) {
        const reply = byEmail.get(who.email.toLowerCase());
        if (!reply || reply === who.reply) continue;

        await prisma.bookingInvitee.update({
          where: { id: who.id },
          data: { reply, repliedAt: reply === "needsAction" ? null : new Date() },
        });
        console.log(`[gcal] ${who.email} answered ${reply} to "${b.title}"`);

        // A member's yes is the same yes the button in the app writes, so it
        // has to reach the same place — that list is what the reminders, the
        // count and their own calendar copy are all read from. Somebody with
        // no account has nowhere to be put, and their answer lives on the row.
        if (!who.userId) continue;
        if (reply === "accepted") {
          await prisma.bookingGoing.upsert({
            where: { bookingId_userId: { bookingId: b.id, userId: who.userId } },
            update: {}, create: { bookingId: b.id, userId: who.userId },
          }).catch(() => {});
        } else if (reply === "declined") {
          await prisma.bookingGoing.deleteMany({
            where: { bookingId: b.id, userId: who.userId },
          }).catch(() => {});
        }
        // tentative and needsAction change nothing on that list: neither is a
        // person saying they will be there.
      }
    }
  } catch (e) {
    console.warn("[gcal] could not bring the replies back:", e);
  } finally {
    sweepingReplies = false;
  }
}

/**
 * How long before a meeting somebody may ask to be told.
 *
 * Google's own ceiling is four weeks, and five reminders on one event. Matching
 * it is not deference — it is that a booking can end up in a Google calendar,
 * and a sixth reminder there would be refused with the whole event.
 */
const REMINDER_MAX_MINUTES = 4 * 7 * 24 * 60;
const REMINDER_MAX_COUNT = 5;

function readReminders(raw: unknown) {
  const wanted = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: { method: string; minutes: number; repeat: string; times: number }[] = [];
  for (const one of wanted) {
    const r = (one ?? {}) as { method?: unknown; minutes?: unknown };
    const method = r.method === "email" ? "email" : "popup";
    const minutes = Math.round(Number(r.minutes));
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > REMINDER_MAX_MINUTES) continue;
    // Repeating is for email only. A notice inside the app is seen by whoever
    // is in the app at that second, and one repeated over three days is three
    // chances to be looking elsewhere rather than a reminder.
    const repeat = method === "email" && typeof (r as { repeat?: unknown }).repeat === "string"
      && ["daily", "weekly", "weekdays"].includes(String((r as { repeat?: unknown }).repeat))
      ? String((r as { repeat?: unknown }).repeat)
      : "none";
    const times = repeat === "none"
      ? 1
      : Math.max(1, Math.min(REMINDER_MAX_TIMES, Math.round(Number((r as { times?: unknown }).times)) || 1));
    const key = `${method}:${minutes}`;
    if (seen.has(key)) continue;                  // the same reminder twice is one
    seen.add(key);
    out.push({ method, minutes, repeat, times });
    if (out.length >= REMINDER_MAX_COUNT) break;
  }
  return out;
}

/**
 * Send the reminders whose moment has come.
 *
 * Every minute, because a reminder is a time somebody chose and "twenty minutes
 * before" that lands twelve minutes before is not the thing they asked for.
 *
 * Only email. A popup is the browser's to draw — it knows whether the person is
 * looking at the app, and a server cannot make a sound on somebody's desk.
 *
 * `sentAt` is what makes this safe to run on a timer: it is set before the mail
 * goes out, so a reminder cannot be sent twice even if a pass overlaps the next
 * one. The cost of that order is a reminder lost when the mail fails, which is
 * better than a mailbox with sixty copies of the same sentence in it.
 */
const REMINDER_SWEEP_MS = Number(process.env.BOOKING_REMINDER_SWEEP_MS || 60_000);
/** how late is too late — a reminder for a meeting that began is not a reminder */
const REMINDER_GRACE_MS = 5 * 60_000;

let sweepingReminders = false;

async function sweepReminders(): Promise<void> {
  if (sweepingReminders) return;
  sweepingReminders = true;
  try {
    const now = Date.now();
    const due = await prisma.bookingReminder.findMany({
      where: {
        method: "email",
        // A repeating one is not finished until every copy has gone, so the
        // filter is "fewer sent than asked for" rather than "never sent".
        booking: { startsAt: { gt: new Date(now - REMINDER_GRACE_MS) } },
      },
      include: {
        booking: {
          include: {
            workspace: { select: { slug: true, name: true } },
            going: { include: { user: { select: { email: true, name: true } } } },
            invitees: true,
          },
        },
      },
      take: 100,
    });

    for (const r of due) {
      const b = r.booking;
      // Legacy rows from before repeating existed have sentAt and no count.
      const alreadySent = r.sentCount || (r.sentAt ? 1 : 0);
      const moments = reminderMoments(r, b.startsAt, b.createdAt);
      if (alreadySent >= moments.length) continue;               // all of them have gone
      // The next one owed, and only if its moment has arrived. One per pass:
      // a booking made after two of three moments had passed should not fire
      // two emails in the same minute.
      if (+moments[alreadySent] > now) continue;

      // Whoever is coming, and whoever was asked and said yes. Nobody who
      // declined, and nobody who has not answered — a reminder for a meeting
      // somebody never agreed to be at is an email they did not ask for.
      const to = new Map<string, string>();
      for (const g of b.going) if (g.user?.email) to.set(g.user.email, g.user.name || g.user.email);
      for (const i of b.invitees) if (i.reply === "accepted") to.set(i.email, i.name || i.email);
      // Worked out before the row is claimed, not after. Claiming first meant
      // that a reminder whose moment arrived while nobody had answered yet was
      // marked sent and sent to nobody — and then somebody pressing yes a
      // minute later could never receive it, because the row already said it
      // had gone. Left unclaimed, it is simply still due.
      if (!to.size) continue;

      // Claimed before the mail goes, so two passes overlapping cannot both
      // send it. The count in the filter is what makes that safe: a second
      // pass reading the same row sees a number that has moved and claims
      // nothing. The cost is a reminder lost when the mail fails, which beats
      // a mailbox with sixty copies of the same sentence in it.
      const claimed = await prisma.bookingReminder.updateMany({
        where: { id: r.id, sentCount: r.sentCount },
        data: { sentCount: alreadySent + 1, sentAt: new Date() },
      });
      if (!claimed.count) continue;

      // No request to read a host from — a sweep has none — so this is the one
      // place that needs APP_URL to be set rather than derivable.
      const base = (process.env.APP_URL || "").replace(/\/+$/, "");
      const url = base
        ? `${base}/?w=${encodeURIComponent(b.workspace.slug)}&m=${encodeURIComponent(b.mapSlug)}`
        : undefined;
      const host = b.going.find((g) => g.userId === b.userId)?.user?.email ?? undefined;
      for (const [email] of to) {
        await sendReminder({
          to: email, space: b.workspace.name, booking: b as BookingRow,
          minutes: r.minutes, url, replyTo: host,
        }).catch((e) => console.warn(`[calendar] reminder to ${email} did not go:`, e));
      }
      console.log(`[calendar] reminder for "${b.title}" sent to ${to.size} person(s)`
        + (moments.length > 1 ? ` (${alreadySent + 1} of ${moments.length})` : ""));
    }
  } catch (e) {
    console.warn("[calendar] could not send reminders:", e);
  } finally {
    sweepingReminders = false;
  }
}

/**
 * The address of this space's feed.
 *
 * Handed out to members only, and made on first ask. Posting to it again mints
 * a new one, which is how a leaked address is taken back — every subscriber
 * stops updating, which is the point rather than a side effect.
 */
async function calendarUrl(req: express.Request, w: { slug: string; calendarKey: string | null; id: string }) {
  let key = w.calendarKey;
  if (!key) {
    key = newCalendarKey();
    await prisma.workspace.update({ where: { id: w.id }, data: { calendarKey: key } });
  }
  return `${appOriginOf(req)}/workspaces/${encodeURIComponent(w.slug)}/calendar.ics?key=${key}`;
}

app.get("/workspaces/:slug/calendar-url", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });
  res.json({ url: await calendarUrl(req, w) });
});

app.post("/workspaces/:slug/calendar-url", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can || (can.role !== "owner" && can.role !== "admin"))
    return res.status(403).json({ error: "forbidden" });
  await prisma.workspace.update({ where: { id: w.id }, data: { calendarKey: newCalendarKey() } });
  const fresh = await prisma.workspace.findUnique({ where: { id: w.id } });
  res.json({ url: await calendarUrl(req, fresh!) });
});

/**
 * The feed itself.
 *
 * No session — a calendar app subscribing to this has no way to hold one. The
 * key in the URL is the whole credential, which is why it is its own secret and
 * why it can be rotated.
 */
app.get("/workspaces/:slug/calendar.ics", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  const key = String(req.query.key || "");
  if (!w || !w.calendarKey || !key || key !== w.calendarKey) {
    return res.status(403).type("text/plain").send("no");
  }
  // A subscription is a standing request, so it gets a window rather than
  // everything: a year back would grow forever and nobody scrolls to it.
  const from = new Date(Date.now() - 30 * DAY_MS);
  const rows = await prisma.booking.findMany({
    where: { workspaceId: w.id, endsAt: { gt: from } },
    orderBy: { startsAt: "asc" },
    take: 1000,
  });
  res.setHeader("content-type", "text/calendar; charset=utf-8");
  res.setHeader("cache-control", "private, max-age=300");
  res.setHeader("content-disposition", `inline; filename="${w.slug}.ics"`);
  // A time and a room name with no way back to the room is most of an event.
  const origin = appOriginOf(req);
  res.send(ics(w.name, rows.map((b) => ({
    ...b,
    url: `${origin}/?w=${encodeURIComponent(w.slug)}&m=${encodeURIComponent(b.mapSlug)}`,
  }))));
});

/** one event, for "add this to my calendar" */
app.get("/workspaces/:slug/bookings/:id.ics", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).type("text/plain").send("no");
  const id = String(req.params.id);
  if (String(req.query.sig || "") !== eventSig(serverKey(), id)) {
    return res.status(403).type("text/plain").send("no");
  }
  const b = await prisma.booking.findUnique({ where: { id } });
  if (!b || b.workspaceId !== w.id) return res.status(404).type("text/plain").send("no");

  res.setHeader("content-type", "text/calendar; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="meeting.ics"`);
  res.send(ics(w.name, [b], {
    url: `${appOriginOf(req)}/?w=${encodeURIComponent(w.slug)}&m=${encodeURIComponent(b.mapSlug)}`,
  }));
});

/**
 * Bookings nobody will look at again.
 *
 * A room held last spring is not history anybody reads — it is a row that makes
 * every listing slower. Kept for a season so "what did we do in Q3" is still
 * answerable, then dropped.
 */
async function sweepOldBookings() {
  const cutoff = new Date(Date.now() - Number(process.env.BOOKING_KEEP_DAYS || 120) * DAY_MS);
  const { count } = await prisma.booking.deleteMany({ where: { endsAt: { lt: cutoff } } });
  if (count) console.log(`[calendar] removed ${count} booking(s) older than the keep window`);
}

// ---- recording a meeting ------------------------------------------------------

type RecordingRow = Awaited<ReturnType<typeof prisma.recording.findUniqueOrThrow>> & {
  tracks: Awaited<ReturnType<typeof prisma.recordingTrack.findUniqueOrThrow>>[];
};

/**
 * What a recording looks like to somebody allowed to see it.
 *
 * Two shapes, and the difference between them is the whole access rule. Staff
 * get the meeting; anybody else gets their own row out of it and nothing else.
 * PDPA s.30 gives a person the right to their own data, so "only admins may
 * read any of it" would be refusing a right rather than withholding a
 * permission — those are not the same thing and only one of them is allowed.
 */
function recordingView(r: RecordingRow, me: { id: string } | null, staff: boolean) {
  const mine = r.tracks.find((t) => t.userId === me?.id);
  return {
    id: r.id,
    room: r.roomLabel,
    startedBy: r.startedByName,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    state: r.state,
    audioUntil: r.audioUntil.toISOString(),
    // Said out loud in every listing: a summary drawn from three voices out of
    // five is a different document from one drawn from all five, and the person
    // reading it is the one who needs to know that.
    people: r.tracks.map((t) => ({
      name: t.name,
      consent: t.consent,
      seconds: t.seconds,
      recorded: mayRecord(t.consent) && t.seconds > 0,
      // Staff get each person's summary, which is what a meeting summary
      // broken down by person means. Not each person's transcript: that is a
      // great deal more of somebody than the job needs, and the person whose
      // words they are can already read their own.
      //
      // Unless nothing is configured to write a summary, in which case there
      // is no digest and the transcript is all there is. Reading it is then
      // exactly the job of the person compiling the meeting — and `summarised`
      // below says which of the two this is, so nothing passes a transcript
      // off as a summary.
      ...(staff ? { digest: llmReady ? t.digest : (t.digest ?? t.transcript) } : {}),
    })),
    summary: staff ? r.summary : undefined,
    /** false when no model wrote any of this and the text is a transcript */
    summarised: llmReady,
    mine: mine
      ? { consent: mine.consent, transcript: mine.transcript, digest: mine.digest }
      : undefined,
    canRead: staff,
  };
}

/**
 * Start recording this room.
 *
 * Making the recording does not record anybody. Every person answers for
 * themselves, and until they do there is nothing of theirs in it — the row that
 * exists for them says "asked", which is neither "no" nor "never told".
 */
app.post("/workspaces/:slug/recordings", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const body = (req.body ?? {}) as Record<string, string>;
  const mapSlug = body.mapSlug || "main";
  const roomId = body.roomId || "";
  const roomLabel = body.roomLabel || "";
  if (!roomId || !roomLabel) return res.status(400).json({ error: "which room" });

  // One at a time per room. Two recordings of one meeting is two half-records,
  // and two sets of consent to keep straight afterwards.
  const already = await prisma.recording.findFirst({
    where: { workspaceId: w.id, mapSlug, roomId, endedAt: null },
  });
  if (already) return res.status(409).json({ error: "already recording", id: already.id });

  const rec = await prisma.recording.create({
    data: {
      workspaceId: w.id, mapSlug, roomId, roomLabel,
      startedById: can.me.id, startedByName: can.me.name,
      audioUntil: new Date(Date.now() + AUDIO_KEEP_DAYS * DAY_MS),
      // Whoever presses record is in it. Anything else is somebody holding a
      // microphone to a room they have stepped out of.
      tracks: { create: { userId: can.me.id, name: can.me.name, consent: startingConsent() } },
    },
    include: { tracks: true },
  });
  console.log(`[recording] ${rec.id} started in ${roomLabel} by ${can.me.name}`);
  res.json({ recording: recordingView(rec as RecordingRow, can.me, true), notice: noticeFacts() });
});

/**
 * Yes you may record me, or no you may not.
 *
 * Either answer writes the row, so a refusal can be told apart from a notice
 * that never arrived. Changing your mind is allowed and takes effect at once:
 * turning it to no deletes whatever was already uploaded, because withdrawing
 * consent while the audio stays put is not withdrawal.
 */
app.post("/workspaces/:slug/recordings/:id/consent", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
  if (!rec || rec.workspaceId !== w.id) return res.status(404).json({ error: "not found" });

  const yes = (req.body ?? {}).consent === true;
  // The deployment decides what a yes means, not the browser. On a workspace
  // set to `notice` nobody was asked, so the row says `auto` rather than
  // claiming a consent that was never given — and a client that asks to be
  // marked `auto` on a workspace set to `ask` does not get it.
  const consent = yes ? (CONSENT_MODE === "notice" ? "auto" : "yes") : "no";
  const before = await prisma.recordingTrack.findUnique({
    where: { recordingId_userId: { recordingId: rec.id, userId: can.me.id } },
  });
  const track = await prisma.recordingTrack.upsert({
    where: { recordingId_userId: { recordingId: rec.id, userId: can.me.id } },
    update: { consent, answeredAt: new Date() },
    create: {
      recordingId: rec.id, userId: can.me.id, name: can.me.name,
      consent, answeredAt: new Date(),
    },
  });
  if (!yes && before?.path) {
    dropTrack(before.path);
    await prisma.recordingTrack.update({
      where: { id: track.id },
      data: { path: null, bytes: 0, seconds: 0, transcript: null, digest: null },
    });
    console.log(`[recording] ${rec.id}: ${can.me.name} withdrew consent, their audio was deleted`);
  }
  res.json({ ok: true, consent, notice: noticeFacts() });
});

/**
 * Stop it.
 *
 * The person who started it, or somebody who runs the space — a meeting whose
 * recorder walked out should not stay recording until the retention sweep.
 */
app.post("/workspaces/:slug/recordings/:id/stop", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
  if (!rec || rec.workspaceId !== w.id) return res.status(404).json({ error: "not found" });
  const staff = can.role === "owner" || can.role === "admin";
  if (rec.startedById !== can.me.id && !staff) {
    return res.status(403).json({ error: "not yours to stop" });
  }
  if (rec.endedAt) return res.json({ ok: true, already: true });

  const done = await prisma.recording.update({
    where: { id: rec.id },
    data: { endedAt: new Date() },
    include: { tracks: true },
  });
  res.json({ recording: recordingView(done as RecordingRow, can.me, staff) });
});

/**
 * One person's own microphone, after the fact.
 *
 * Refused unless that person said yes, and refused once the meeting is long
 * over: an upload arriving hours later is not the meeting anybody agreed to,
 * whatever it happens to contain.
 */
app.post(
  "/workspaces/:slug/recordings/:id/track",
  // Raw bytes, like the uploads route. Skipping the JSON parser is not enough —
  // something still has to read the body, and without this the handler sees
  // nothing and reports an empty upload for a track that was sent in full.
  express.raw({ type: () => true, limit: TRACK_MAX_BYTES + 1024 }),
  ((err: { type?: string; status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      return res.status(413).json({ error: `that is longer than one track may be` });
    }
    return next(err);
  }) as express.ErrorRequestHandler,
  async (req: express.Request, res: express.Response) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
  if (!rec || rec.workspaceId !== w.id) return res.status(404).json({ error: "not found" });

  const track = await prisma.recordingTrack.findUnique({
    where: { recordingId_userId: { recordingId: rec.id, userId: can.me.id } },
  });
  if (!track) return res.status(403).json({ error: "you were not asked" });
  if (!mayRecord(track.consent)) {
    return res.status(403).json({ error: "you did not agree to be recorded" });
  }
  if (track.path) return res.status(409).json({ error: "already uploaded" });
  const age = Date.now() - +(rec.endedAt ?? rec.startedAt);
  if (age > REC_MAX_MINUTES * 60_000) return res.status(410).json({ error: "too late" });

  const mime = String(req.header("content-type") || "").split(";")[0].trim();
  if (!acceptsAudio(mime)) return res.status(415).json({ error: "not an audio format we take" });
  const bytes = req.body as Buffer;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ error: "empty" });
  if (bytes.length > TRACK_MAX_BYTES) return res.status(413).json({ error: "too long" });

  const seconds = Math.max(0, Math.min(REC_MAX_MINUTES * 60, Number(req.query.seconds) || 0));
  const rel = trackPath(rec.id, audioExt(mime));
  putTrack(rel, bytes);
    await prisma.recordingTrack.update({
      where: { id: track.id },
      data: { path: rel, bytes: bytes.length, seconds },
    });
    res.json({ ok: true, bytes: bytes.length, seconds });
  },
);

/** the meetings this space has recorded */
app.get("/workspaces/:slug/recordings", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });
  const staff = can.role === "owner" || can.role === "admin";

  // Staff see the space's meetings; everybody else sees the ones they were in.
  // Not a listing of what other people said — a way to reach your own row.
  const rows = await prisma.recording.findMany({
    where: {
      workspaceId: w.id,
      ...(staff ? {} : { tracks: { some: { userId: can.me.id } } }),
    },
    include: { tracks: true },
    orderBy: { startedAt: "desc" },
    take: 100,
  });
  res.json({
    recordings: rows.map((r) => recordingView(r as RecordingRow, can.me, staff)),
    canRead: staff,
    notice: noticeFacts(),
  });
});

/** one meeting, and the read is written down */
app.get("/workspaces/:slug/recordings/:id", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const rec = await prisma.recording.findUnique({
    where: { id: req.params.id }, include: { tracks: true },
  });
  if (!rec || rec.workspaceId !== w.id) return res.status(404).json({ error: "not found" });
  const staff = can.role === "owner" || can.role === "admin";
  const wasThere = rec.tracks.some((t) => t.userId === can.me.id);
  if (!staff && !wasThere) return res.status(403).json({ error: "you were not in this meeting" });

  // Only reading somebody else's words is worth writing down. Logging a person
  // reading their own would make exercising a right look like an incident.
  if (staff) {
    await prisma.recordingRead.create({
      data: { recordingId: rec.id, userId: can.me.id, what: "summary" },
    });
  }
  res.json({ recording: recordingView(rec as RecordingRow, can.me, staff) });
});

/**
 * Delete.
 *
 * Whoever runs the space may drop the whole meeting; anybody who was in it may
 * drop their own voice out and leave the rest standing. The second is the
 * erasure right, and it has to work without asking anybody's permission.
 */
app.delete("/workspaces/:slug/recordings/:id", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const rec = await prisma.recording.findUnique({
    where: { id: req.params.id }, include: { tracks: true },
  });
  if (!rec || rec.workspaceId !== w.id) return res.status(404).json({ error: "not found" });
  const staff = can.role === "owner" || can.role === "admin";
  const mineOnly = String(req.query.mine || "") === "1";

  if (mineOnly || !staff) {
    const mine = rec.tracks.find((t) => t.userId === can.me.id);
    if (!mine) return res.status(403).json({ error: "you were not in this meeting" });
    dropTrack(mine.path);
    await prisma.recordingTrack.update({
      where: { id: mine.id },
      data: { path: null, bytes: 0, seconds: 0, transcript: null, digest: null, consent: "no" },
    });
    console.log(`[recording] ${rec.id}: ${can.me.name} removed their own voice`);
    return res.json({ ok: true, mine: true });
  }

  for (const t of rec.tracks) dropTrack(t.path);
  dropRecordingDir(rec.id);
  await prisma.recording.delete({ where: { id: rec.id } });
  res.json({ ok: true });
});

/**
 * Audio goes first, and the notes outlive it.
 *
 * Two sweeps rather than one, because they answer two questions: how long a
 * voice is worth keeping, and how long a meeting is worth remembering. Both
 * are set in the environment, so a deployment can be stricter than this one.
 */
async function sweepRecordings() {
  const now = new Date();
  const stale = await prisma.recordingTrack.findMany({
    where: { path: { not: null }, recording: { audioUntil: { lt: now } } },
    select: { id: true, path: true, recordingId: true },
  });
  for (const t of stale) {
    dropTrack(t.path);
    await prisma.recordingTrack.update({ where: { id: t.id }, data: { path: null, bytes: 0 } });
  }
  for (const id of new Set(stale.map((t) => t.recordingId))) dropRecordingDir(id);
  if (stale.length) {
    console.log(`[recording] swept ${stale.length} audio track(s) past their keep window`);
  }

  const old = new Date(Date.now() - TEXT_KEEP_DAYS * DAY_MS);
  const { count } = await prisma.recording.deleteMany({ where: { startedAt: { lt: old } } });
  if (count) console.log(`[recording] removed ${count} recording(s) past the text keep window`);
}

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
 * What the browser needs to open Google's own file picker.
 *
 * The picker runs in the page, so the page has to be told the key and the
 * client id. Served from here rather than built into the bundle, because a
 * value baked in at build time is a value that needs a rebuild and a deploy to
 * change — and this one lives in .env beside everything else.
 *
 * drive.file and nothing wider. Google classes drive.readonly and even
 * drive.metadata.readonly as restricted scopes, which need a paid security
 * assessment before an app may go past a hundred users; drive.file is
 * non-sensitive and grants access only to the files somebody picked. That is
 * also the better shape for a shared cabinet: consent one file at a time,
 * rather than a blanket reading of somebody's whole Drive.
 */
app.get("/me/drive-picker", requireAuth, (_req: AuthedRequest, res) => {
  res.json({
    available: !!(PICKER_KEY && GOOGLE_ID),
    key: PICKER_KEY || null,
    clientId: GOOGLE_ID || null,
    scope: "https://www.googleapis.com/auth/drive.file",
  });
});

// ------------------------------------------------------------------ cabinets ---
/**
 * The filing cabinets standing in the rooms.
 *
 * Every answer on these routes runs through src/cabinet.ts. Not because it is
 * tidier — because it is the only way the rule that was tested is the rule that
 * runs. A second copy of "can this person see this" written inline is a second
 * rule, and the day they disagree nothing says so.
 *
 * Two shapes of refusal, deliberately different:
 *   · a cabinet or document this person may not see is **404**, not 403. A 403
 *     confirms that the thing exists, which for a cabinet called "เงินเดือน"
 *     is most of what somebody was trying to learn.
 *   · a thing they may see but may not change is **403**, because they already
 *     know it is there.
 */

/** what the browser is given for one cabinet */
const cabinetView = (
  c: { id: string; label: string; openTo: string; mapSlug: string; x: number; y: number },
  level: Level,
  docs?: number,
) => ({
  id: c.id, label: c.label, openTo: c.openTo,
  at: { map: c.mapSlug, x: c.x, y: c.y },
  level, mayManage: level === "file", ...(docs === undefined ? {} : { docs }),
});

const docView = (
  d: {
    id: string; title: string; provider: string; url: string; mime: string | null;
    iconUrl: string | null; openTo: string | null; addedAt: Date; kind: string;
    folderId: string | null;
    addedBy?: { name: string | null; email: string } | null;
  },
  level: Level,
  why: Because,
) => ({
  id: d.id, title: d.title, provider: d.provider, url: d.url, kind: d.kind,
  folderId: d.folderId,
  mime: d.mime, iconUrl: d.iconUrl, openTo: d.openTo,
  addedAt: d.addedAt.toISOString(),
  addedBy: d.addedBy ? (d.addedBy.name || d.addedBy.email) : null,
  level, why, mayManage: level === "file",
});

const folderView = (
  f: { id: string; name: string; openTo: string | null },
  level: Level,
  why: Because,
  docs: number,
) => ({
  id: f.id, name: f.name, openTo: f.openTo, level, why, docs,
  mayManage: level === "file",
});

/**
 * Find the cabinet standing at a spot, making the record if this is the first
 * time anybody opened it.
 *
 * The map is what says a cabinet is there. Requiring an admin to create a row
 * as well would mean a piece of furniture that does nothing until somebody
 * notices a setting — so the first person to walk up to it brings it into
 * being, with the safest setting it could have.
 */
async function cabinetAt(workspaceId: string, mapSlug: string, x: number, y: number,
  madeBy: string) {
  const found = await prisma.cabinet.findUnique({
    where: { workspaceId_mapSlug_x_y: { workspaceId, mapSlug, x, y } },
    include: { grants: true },
  });
  if (found) return found;
  const made = await prisma.cabinet.create({
    data: { workspaceId, mapSlug, x, y, createdBy: madeBy },
  }).catch(async () => prisma.cabinet.findUnique({
    // two people walking up at once is one cabinet, not an error
    where: { workspaceId_mapSlug_x_y: { workspaceId, mapSlug, x, y } },
  }));
  return made ? { ...made, grants: [] as { userId: string; level: string }[] } : null;
}

const asGrants = (rows: { userId: string; level: string }[]) =>
  rows.map((g) => ({ userId: g.userId, level: g.level as Level }));

/** the cabinets on one map, and what this person may do with each */
app.get("/workspaces/:slug/cabinets", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const rows = await prisma.cabinet.findMany({
    where: { workspaceId: w.id, ...(req.query.map ? { mapSlug: String(req.query.map) } : {}) },
    include: { grants: true },
    orderBy: { createdAt: "asc" },
  });
  const who = { userId: can.me.id, role: can.role };
  const out = [];
  for (const c of rows) {
    const level = levelForCabinet({ openTo: c.openTo, grants: asGrants(c.grants) }, who);
    // A cabinet they cannot open may still hold one document that is theirs, and
    // hiding the cabinet would hide that document with it.
    const docs = await prisma.cabinetDoc.findMany({
      where: { cabinetId: c.id }, include: { grants: true },
    });
    const folders = await prisma.cabinetFolder.findMany({
      where: { cabinetId: c.id }, include: { grants: true },
    });
    const drawer = new Map(folders.map((f) => [f.id,
      { openTo: f.openTo, grants: asGrants(f.grants) }]));
    const mine = docs.filter((d) => levelForDoc(
      { openTo: c.openTo, grants: asGrants(c.grants) },
      d.folderId ? drawer.get(d.folderId) ?? null : null,
      { openTo: d.openTo, grants: asGrants(d.grants) }, who,
    ) !== "none");
    if (level === "none" && !mine.length) continue;
    out.push(cabinetView(c, level, mine.length));
  }
  res.json({ cabinets: out });
});

/**
 * Open the cabinet at a spot on the map.
 *
 * A place, not an id: the browser knows where the furniture is and nothing
 * else, and an id in the URL would be an id somebody could try changing.
 */
app.get("/workspaces/:slug/cabinets/at/:map/:x/:y", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });

  const x = Number(req.params.x), y = Number(req.params.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ error: "bad spot" });
  const c = await cabinetAt(w.id, String(req.params.map), x, y, can.me.id);
  if (!c) return res.status(500).json({ error: "could not open it" });

  const who = { userId: can.me.id, role: can.role };
  const cab = { openTo: c.openTo, grants: asGrants(c.grants) };
  const level = levelForCabinet(cab, who);

  const folderRows = await prisma.cabinetFolder.findMany({
    where: { cabinetId: c.id }, include: { grants: true }, orderBy: { name: "asc" },
  });
  const drawer = new Map(folderRows.map((f) => [f.id,
    { openTo: f.openTo, grants: asGrants(f.grants) }]));

  const rows = await prisma.cabinetDoc.findMany({
    where: { cabinetId: c.id },
    include: { grants: true, addedBy: { select: { name: true, email: true } } },
    orderBy: { addedAt: "desc" },
  });
  const docs = [];
  const perFolder = new Map<string, number>();
  for (const d of rows) {
    const doc = { openTo: d.openTo, grants: asGrants(d.grants) };
    const f = d.folderId ? drawer.get(d.folderId) ?? null : null;
    const lv = levelForDoc(cab, f, doc, who);
    if (lv === "none") continue;
    if (d.folderId) perFolder.set(d.folderId, (perFolder.get(d.folderId) ?? 0) + 1);
    docs.push(docView(d, lv, whyForDoc(cab, f, doc, who)));
  }

  /**
   * A drawer is listed when it can be opened, or when something inside it can
   * be — the same rule the cabinet itself follows. A folder shut to somebody
   * that holds one document named to them still has to appear, or that
   * document has nowhere to be shown.
   */
  const folders = [];
  for (const f of folderRows) {
    const one = { openTo: f.openTo, grants: asGrants(f.grants) };
    const lv = levelForFolder(cab, one, who);
    const n = perFolder.get(f.id) ?? 0;
    if (lv === "none" && !n) continue;
    folders.push(folderView(f, lv, whyForFolder(cab, one, who), n));
  }

  if (level === "none" && !docs.length && !folders.length) {
    return res.status(404).json({ error: "not found" });
  }

  res.json({ cabinet: cabinetView(c, level, docs.length), folders, docs });
});

/** rename it, or change who it stands open to — the space's own only */
app.patch("/workspaces/:slug/cabinets/:id", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });
  const c = await prisma.cabinet.findUnique({ where: { id: String(req.params.id) } });
  if (!c || c.workspaceId !== w.id) return res.status(404).json({ error: "not found" });
  if (!runsTheSpace(can.role)) return res.status(403).json({ error: "only an owner or admin" });

  const data: { label?: string; openTo?: string } = {};
  if (req.body?.label !== undefined) {
    const label = String(req.body.label).trim().slice(0, 60);
    if (!label) return res.status(400).json({ error: "a cabinet needs a name" });
    data.label = label;
  }
  if (req.body?.openTo !== undefined) {
    if (!isOpenTo(req.body.openTo)) return res.status(400).json({ error: "bad openTo" });
    data.openTo = req.body.openTo;
  }
  const saved = await prisma.cabinet.update({ where: { id: c.id }, data });
  console.log(`[cabinet] ${can.me.email} set "${saved.label}" to ${saved.openTo}`);
  res.json({ cabinet: cabinetView(saved, "file") });
});

/**
 * The names on a cabinet: read them, and write the whole list at once.
 *
 * Whole list rather than one name at a time, because that is the shape of the
 * question being answered — "who may open this" — and a screen that sends each
 * change on its own has a state where half of it went.
 */
app.get("/workspaces/:slug/cabinets/:id/grants", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can || !runsTheSpace(can.role)) return res.status(403).json({ error: "only an owner or admin" });
  const c = await prisma.cabinet.findUnique({
    where: { id: String(req.params.id) },
    include: { grants: { include: { user: { select: { id: true, name: true, email: true } } } } },
  });
  if (!c || c.workspaceId !== w.id) return res.status(404).json({ error: "not found" });

  res.json({
    openTo: c.openTo,
    grants: c.grants.map((g) => ({
      userId: g.userId, level: g.level,
      name: g.user.name || g.user.email, email: g.user.email,
    })),
  });
});

app.put("/workspaces/:slug/cabinets/:id/grants", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can || !runsTheSpace(can.role)) return res.status(403).json({ error: "only an owner or admin" });
  const c = await prisma.cabinet.findUnique({ where: { id: String(req.params.id) } });
  if (!c || c.workspaceId !== w.id) return res.status(404).json({ error: "not found" });

  const want = Array.isArray(req.body?.grants) ? req.body.grants : null;
  if (!want) return res.status(400).json({ error: "grants must be a list" });
  if (want.length > 200) return res.status(413).json({ error: "too many names" });
  for (const g of want) {
    if (typeof g?.userId !== "string" || !isLevel(g?.level)) {
      return res.status(400).json({ error: "each grant needs a userId and a level" });
    }
  }
  // Only people who are actually in this space. A userId from somewhere else
  // would sit in the list looking like access nobody can account for.
  const ids: string[] = [...new Set<string>(want.map((g: { userId: string }) => String(g.userId)))];
  const members = await prisma.membership.findMany({
    where: { workspaceId: w.id, userId: { in: ids }, role: { not: "guest" } },
    select: { userId: true },
  });
  const inSpace = new Set(members.map((m) => m.userId));
  const strangers = ids.filter((id) => !inSpace.has(id));
  if (strangers.length) {
    return res.status(400).json({ error: "not members of this space", n: strangers.length });
  }

  await prisma.$transaction([
    prisma.cabinetGrant.deleteMany({ where: { cabinetId: c.id } }),
    ...want.map((g: { userId: string; level: Level }) => prisma.cabinetGrant.create({
      data: { cabinetId: c.id, userId: g.userId, level: g.level },
    })),
  ]);
  console.log(`[cabinet] ${can.me.email} set ${want.length} name(s) on "${c.label}"`);
  res.json({ ok: true, grants: want.length });
});

/**
 * Put a document in.
 *
 * A link, for now, or a file reached through somebody's own Drive or OneDrive
 * connection — in which case the row remembers whose, because the listing has
 * to be able to say so. Nothing about the file is copied here: NexSpace keeps
 * the name and the way back, and the document stays where its owner put it.
 */
app.post("/workspaces/:slug/cabinets/:id/docs", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });
  const c = await prisma.cabinet.findUnique({
    where: { id: String(req.params.id) }, include: { grants: true },
  });
  if (!c || c.workspaceId !== w.id) return res.status(404).json({ error: "not found" });

  const who = { userId: can.me.id, role: can.role };
  const cab = { openTo: c.openTo, grants: asGrants(c.grants) };

  /**
   * Which drawer this is going into, resolved before anything is checked.
   *
   * The order matters and got it wrong once: the cabinet was asked first, so
   * somebody given filing rights on one drawer of a cabinet they may only read
   * was refused — which is the whole point of naming them on the drawer. What
   * is being filed *into* is what decides. A document lying loose is filed into
   * the cabinet, and then the cabinet decides.
   */
  let folderId: string | null = null;
  let level: Level;
  if (req.body?.folderId) {
    const f = await prisma.cabinetFolder.findUnique({
      where: { id: String(req.body.folderId) }, include: { grants: true },
    });
    if (!f || f.cabinetId !== c.id) return res.status(404).json({ error: "no such folder" });
    folderId = f.id;
    level = levelForFolder(cab, { openTo: f.openTo, grants: asGrants(f.grants) }, who);
  } else {
    level = levelForCabinet(cab, who);
  }

  if (!atLeast(level, "file")) {
    /**
     * 404 or 403 turns on one question: does this person already know this is
     * here? Somebody named on a single document inside does — they were shown
     * it, holding that one — so "not found" would be a lie told to a person
     * looking straight at it. Somebody it is entirely shut to gets the answer
     * that says nothing.
     */
    const inside = await prisma.cabinetDoc.findMany({
      where: { cabinetId: c.id }, include: { grants: true },
    });
    const sees = level !== "none" || levelForCabinet(cab, who) !== "none"
      || inside.some((d) => levelForDoc(
        cab, null, { openTo: d.openTo, grants: asGrants(d.grants) }, who,
      ) !== "none");
    return sees
      ? res.status(403).json({ error: folderId
        ? "you may read that folder, not file into it"
        : "you may read this cabinet, not file in it" })
      : res.status(404).json({ error: "not found" });
  }

  const title = String(req.body?.title ?? "").trim().slice(0, 200);
  const url = String(req.body?.url ?? "").trim();
  if (!title) return res.status(400).json({ error: "a document needs a name" });
  // http(s) only. A javascript: or data: URL in a list everybody clicks is the
  // whole of the attack, and the list is rendered by every member of the space.
  let parsed: URL;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: "that is not a link" }); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return res.status(400).json({ error: "only http and https links" });
  }
  const provider = ["link", "google", "microsoft"].includes(String(req.body?.provider))
    ? String(req.body.provider) : "link";
  const kind = req.body?.kind === "folder" ? "folder" : "file";

  const openTo = req.body?.openTo === null || req.body?.openTo === undefined
    ? null : (isOpenTo(req.body.openTo) ? req.body.openTo : undefined);
  if (openTo === undefined) return res.status(400).json({ error: "bad openTo" });

  const doc = await prisma.cabinetDoc.create({
    data: {
      cabinetId: c.id, title, url: parsed.toString(), provider, kind, folderId,
      fileId: req.body?.fileId ? String(req.body.fileId).slice(0, 200) : null,
      mime: req.body?.mime ? String(req.body.mime).slice(0, 120) : null,
      iconUrl: null, openTo, addedById: can.me.id,
    },
    include: { addedBy: { select: { name: true, email: true } } },
  });
  console.log(`[cabinet] ${can.me.email} filed "${title}" in "${c.label}"`);
  res.status(201).json({ doc: docView(doc, "file", "runs-the-space") });
});

/** change one document's own setting, or take it out */
app.patch("/workspaces/:slug/cabinets/:id/docs/:docId", async (req, res) => {
  const found = await docFor(req, res);
  if (!found) return;
  const { doc, level } = found;
  if (!atLeast(level, "file")) return res.status(403).json({ error: "you may read this, not change it" });

  const data: { title?: string; openTo?: string | null; folderId?: string | null } = {};
  if (req.body?.title !== undefined) {
    const title = String(req.body.title).trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: "a document needs a name" });
    data.title = title;
  }
  if (req.body?.openTo !== undefined) {
    if (req.body.openTo !== null && !isOpenTo(req.body.openTo)) {
      return res.status(400).json({ error: "bad openTo" });
    }
    data.openTo = req.body.openTo;
  }
  // Moving it into a drawer is filing into that drawer, and is checked as such.
  if (req.body?.folderId !== undefined) {
    if (req.body.folderId === null) data.folderId = null;
    else {
      const f = await prisma.cabinetFolder.findUnique({
        where: { id: String(req.body.folderId) }, include: { grants: true },
      });
      if (!f || f.cabinetId !== found.cabinet.id) {
        return res.status(404).json({ error: "no such folder" });
      }
      const fl = levelForFolder(
        { openTo: found.cabinet.openTo, grants: asGrants(found.cabinet.grants) },
        { openTo: f.openTo, grants: asGrants(f.grants) },
        { userId: found.can.me.id, role: found.can.role },
      );
      if (!atLeast(fl, "file")) {
        return res.status(403).json({ error: "you may not file into that folder" });
      }
      data.folderId = f.id;
    }
  }
  const saved = await prisma.cabinetDoc.update({
    where: { id: doc.id }, data,
    include: { addedBy: { select: { name: true, email: true } } },
  });
  res.json({ doc: docView(saved, level, "runs-the-space") });
});

app.delete("/workspaces/:slug/cabinets/:id/docs/:docId", async (req, res) => {
  const found = await docFor(req, res);
  if (!found) return;
  if (!atLeast(found.level, "file")) {
    return res.status(403).json({ error: "you may read this, not remove it" });
  }
  await prisma.cabinetDoc.delete({ where: { id: found.doc.id } });
  res.json({ ok: true });
});

/**
 * One document, and what this person may do with it — the shared first half of
 * every route above. Written once because the 404-not-403 rule is easy to get
 * right in one place and easy to forget in four.
 */
async function docFor(req: express.Request, res: express.Response) {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) { res.status(404).json({ error: "not found" }); return null; }
  const can = await booker(req, w);
  if (!can) { res.status(403).json({ error: "forbidden" }); return null; }
  const c = await prisma.cabinet.findUnique({
    where: { id: String(req.params.id) }, include: { grants: true },
  });
  if (!c || c.workspaceId !== w.id) { res.status(404).json({ error: "not found" }); return null; }
  const doc = await prisma.cabinetDoc.findUnique({
    where: { id: String(req.params.docId) }, include: { grants: true },
  });
  if (!doc || doc.cabinetId !== c.id) { res.status(404).json({ error: "not found" }); return null; }

  const who = { userId: can.me.id, role: can.role };
  const folder = doc.folderId
    ? await prisma.cabinetFolder.findUnique({
      where: { id: doc.folderId }, include: { grants: true },
    })
    : null;
  const level = levelForDoc(
    { openTo: c.openTo, grants: asGrants(c.grants) },
    folder ? { openTo: folder.openTo, grants: asGrants(folder.grants) } : null,
    { openTo: doc.openTo, grants: asGrants(doc.grants) }, who,
  );
  if (level === "none") { res.status(404).json({ error: "not found" }); return null; }
  return { w, can, cabinet: c, doc, folder, level };
}

/**
 * Drawers.
 *
 * Making one needs filing rights on the cabinet — the same thing that lets you
 * put a document in, because a drawer is a thing you put in. Renaming one, or
 * deciding who may open it, is the space's own: exactly like the cabinet, and
 * for the same reason.
 */
app.post("/workspaces/:slug/cabinets/:id/folders", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can) return res.status(403).json({ error: "forbidden" });
  const c = await prisma.cabinet.findUnique({
    where: { id: String(req.params.id) }, include: { grants: true },
  });
  if (!c || c.workspaceId !== w.id) return res.status(404).json({ error: "not found" });

  const who = { userId: can.me.id, role: can.role };
  const level = levelForCabinet({ openTo: c.openTo, grants: asGrants(c.grants) }, who);
  if (level === "none") return res.status(404).json({ error: "not found" });
  if (!atLeast(level, "file")) {
    return res.status(403).json({ error: "you may read this cabinet, not file in it" });
  }

  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "a folder needs a name" });
  const openTo = req.body?.openTo === null || req.body?.openTo === undefined
    ? null : (isOpenTo(req.body.openTo) ? req.body.openTo : undefined);
  if (openTo === undefined) return res.status(400).json({ error: "bad openTo" });

  const folder = await prisma.cabinetFolder.create({
    data: { cabinetId: c.id, name, openTo, createdById: can.me.id },
  });
  console.log(`[cabinet] ${can.me.email} made the folder "${name}" in "${c.label}"`);
  res.status(201).json({ folder: folderView(folder, "file", "runs-the-space", 0) });
});

/** rename a drawer, or change who it stands open to — the space's own only */
app.patch("/workspaces/:slug/cabinets/:id/folders/:folderId", async (req, res) => {
  const found = await folderFor(req, res, true);
  if (!found) return;

  const data: { name?: string; openTo?: string | null } = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "a folder needs a name" });
    data.name = name;
  }
  if (req.body?.openTo !== undefined) {
    if (req.body.openTo !== null && !isOpenTo(req.body.openTo)) {
      return res.status(400).json({ error: "bad openTo" });
    }
    data.openTo = req.body.openTo;
  }
  const saved = await prisma.cabinetFolder.update({ where: { id: found.folder.id }, data });
  const n = await prisma.cabinetDoc.count({ where: { folderId: saved.id } });
  res.json({ folder: folderView(saved, "file", "runs-the-space", n) });
});

/**
 * Take a drawer out.
 *
 * The documents in it are not deleted — they go back to lying loose in the
 * cabinet. "I meant to tidy up" must not be able to mean "and forty contracts
 * are gone", and the answer says how many came back so nobody has to guess
 * where they went.
 */
app.delete("/workspaces/:slug/cabinets/:id/folders/:folderId", async (req, res) => {
  const found = await folderFor(req, res, true);
  if (!found) return;
  const loose = await prisma.cabinetDoc.updateMany({
    where: { folderId: found.folder.id }, data: { folderId: null },
  });
  await prisma.cabinetFolder.delete({ where: { id: found.folder.id } });
  console.log(`[cabinet] ${found.can.me.email} removed the folder "${found.folder.name}"`
    + ` — ${loose.count} document(s) went back into the cabinet`);
  res.json({ ok: true, loosened: loose.count });
});

/** the names on one drawer */
app.get("/workspaces/:slug/cabinets/:id/folders/:folderId/grants", async (req, res) => {
  const found = await folderFor(req, res, true);
  if (!found) return;
  const rows = await prisma.folderGrant.findMany({
    where: { folderId: found.folder.id },
    include: { user: { select: { name: true, email: true } } },
  });
  res.json({
    openTo: found.folder.openTo,
    grants: rows.map((g) => ({
      userId: g.userId, level: g.level,
      name: g.user.name || g.user.email, email: g.user.email,
    })),
  });
});

app.put("/workspaces/:slug/cabinets/:id/folders/:folderId/grants", async (req, res) => {
  const found = await folderFor(req, res, true);
  if (!found) return;

  const want = Array.isArray(req.body?.grants) ? req.body.grants : null;
  if (!want) return res.status(400).json({ error: "grants must be a list" });
  if (want.length > 200) return res.status(413).json({ error: "too many names" });
  for (const g of want) {
    if (typeof g?.userId !== "string" || !isLevel(g?.level)) {
      return res.status(400).json({ error: "each grant needs a userId and a level" });
    }
  }
  const ids: string[] = [...new Set<string>(want.map((g: { userId: string }) => String(g.userId)))];
  const members = await prisma.membership.findMany({
    where: { workspaceId: found.w.id, userId: { in: ids }, role: { not: "guest" } },
    select: { userId: true },
  });
  const inSpace = new Set(members.map((m) => m.userId));
  if (ids.some((id) => !inSpace.has(id))) {
    return res.status(400).json({ error: "not members of this space" });
  }

  await prisma.$transaction([
    prisma.folderGrant.deleteMany({ where: { folderId: found.folder.id } }),
    ...want.map((g: { userId: string; level: Level }) => prisma.folderGrant.create({
      data: { folderId: found.folder.id, userId: g.userId, level: g.level },
    })),
  ]);
  console.log(`[cabinet] ${found.can.me.email} set ${want.length} name(s) on the folder "${found.folder.name}"`);
  res.json({ ok: true, grants: want.length });
});

/**
 * One drawer, and whether this person may be here at all.
 *
 * `staffOnly` is every route that changes it: naming a drawer, deciding who
 * opens it, taking it away. Those are the space's own, like the cabinet's.
 * A drawer somebody may not see is 404 either way.
 */
async function folderFor(req: express.Request, res: express.Response, staffOnly: boolean) {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) { res.status(404).json({ error: "not found" }); return null; }
  const can = await booker(req, w);
  if (!can) { res.status(403).json({ error: "forbidden" }); return null; }
  const c = await prisma.cabinet.findUnique({
    where: { id: String(req.params.id) }, include: { grants: true },
  });
  if (!c || c.workspaceId !== w.id) { res.status(404).json({ error: "not found" }); return null; }
  const folder = await prisma.cabinetFolder.findUnique({
    where: { id: String(req.params.folderId) }, include: { grants: true },
  });
  if (!folder || folder.cabinetId !== c.id) {
    res.status(404).json({ error: "not found" }); return null;
  }

  const who = { userId: can.me.id, role: can.role };
  const cab = { openTo: c.openTo, grants: asGrants(c.grants) };
  const level = levelForFolder(cab, { openTo: folder.openTo, grants: asGrants(folder.grants) }, who);
  const docsInside = await prisma.cabinetDoc.count({ where: { folderId: folder.id } });
  // A drawer they cannot open, holding nothing they can see, is not there.
  if (level === "none" && !docsInside) { res.status(404).json({ error: "not found" }); return null; }
  if (staffOnly && !runsTheSpace(can.role)) {
    res.status(403).json({ error: "only an owner or admin" }); return null;
  }
  return { w, can, cabinet: c, folder, level };
}

/** the names on one document — the exception inside the exception */
app.put("/workspaces/:slug/cabinets/:id/docs/:docId/grants", async (req, res) => {
  const w = await prisma.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!w) return res.status(404).json({ error: "not found" });
  const can = await booker(req, w);
  if (!can || !runsTheSpace(can.role)) return res.status(403).json({ error: "only an owner or admin" });
  const doc = await prisma.cabinetDoc.findUnique({
    where: { id: String(req.params.docId) }, include: { cabinet: true },
  });
  if (!doc || doc.cabinet.workspaceId !== w.id || doc.cabinetId !== String(req.params.id)) {
    return res.status(404).json({ error: "not found" });
  }

  const want = Array.isArray(req.body?.grants) ? req.body.grants : null;
  if (!want) return res.status(400).json({ error: "grants must be a list" });
  if (want.length > 200) return res.status(413).json({ error: "too many names" });
  for (const g of want) {
    if (typeof g?.userId !== "string" || !isLevel(g?.level)) {
      return res.status(400).json({ error: "each grant needs a userId and a level" });
    }
  }
  const ids: string[] = [...new Set<string>(want.map((g: { userId: string }) => String(g.userId)))];
  const members = await prisma.membership.findMany({
    where: { workspaceId: w.id, userId: { in: ids }, role: { not: "guest" } },
    select: { userId: true },
  });
  const inSpace = new Set(members.map((m) => m.userId));
  if (ids.some((id) => !inSpace.has(id))) {
    return res.status(400).json({ error: "not members of this space" });
  }

  await prisma.$transaction([
    prisma.docGrant.deleteMany({ where: { docId: doc.id } }),
    ...want.map((g: { userId: string; level: Level }) => prisma.docGrant.create({
      data: { docId: doc.id, userId: g.userId, level: g.level },
    })),
  ]);
  console.log(`[cabinet] ${can.me.email} set ${want.length} name(s) on "${doc.title}"`);
  res.json({ ok: true, grants: want.length });
});

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
void sweepOldInvites().catch((e) => console.error("[invite] sweep failed:", e));
setInterval(() => void sweepOldInvites().catch((e) => console.error("[invite] sweep failed:", e)), DAY_MS).unref();
void sweepOldBookings().catch((e) => console.error("[calendar] sweep failed:", e));
setInterval(() => void sweepOldBookings().catch((e) => console.error("[calendar] sweep failed:", e)), DAY_MS).unref();
// Retention is not a policy document, it is a timer. Run at start-up as well,
// so a deployment that was off for a week does not keep last week's voices.
void sweepRecordings().catch((e) => console.error("[recording] sweep failed:", e));
// One meeting at a time, and only when something is configured to do the work.
// Off by default: an unconfigured deployment records perfectly well and simply
// has no summary, which is the same shape mail takes.
if (summariesReady) {
  console.log(llmReady
    ? "[summary] queue on — transcribing and summarising"
    : "[summary] queue on — transcribing only, no model configured to summarise (set LLM_URL)");
  setInterval(() => void runSummaryQueue(), 30_000).unref();
} else {
  console.log("[summary] no transcription service configured — recordings are kept as audio and nothing is read out of them (set ASR_URL)");
}
setInterval(() => void sweepRecordings().catch((e) => console.error("[recording] sweep failed:", e)), 6 * 60 * 60 * 1000).unref();
// Answers given in Gmail, brought back here. Nothing tells this server when
// somebody presses Yes, so it asks.
if (gcalEnabled || msEnabled) {
  setInterval(() => void syncBookingReplies(), REPLY_SWEEP_MS).unref();
}
// A reminder is a time somebody chose. Checked every minute, because "twenty
// minutes before" that lands twelve minutes before is not what was asked for.
console.log(`[calendar] reminder sweep on, every ${Math.round(REMINDER_SWEEP_MS / 1000)}s${
  mailEnabled ? "" : " — but no mail transport is configured, so nothing can go out"}`);
setInterval(() => void sweepReminders(), REMINDER_SWEEP_MS).unref();
void sweepOrphanUploads().catch((e) => console.error("[uploads] sweep failed:", e));
setInterval(() => void sweepOrphanUploads().catch((e) => console.error("[uploads] sweep failed:", e)), DAY_MS).unref();

if (!turnEnabled) console.warn("[ice] no TURN relay configured — calls will fail for anyone behind a strict firewall (set TURN_SECRET and TURN_HOST)");

/**
 * Whether mail works, said once at boot.
 *
 * The same question as /mail-check, asked without a token and answered in the
 * deploy log — "is mail on?" should not require signing in as an admin and
 * pasting a fetch into a console. It sends nothing: the check opens the
 * connection, or reads a key, and stops.
 */
console.log(PICKER_KEY && GOOGLE_ID
  ? "[picker] Google Drive picker on — people can put their own files in a cabinet"
  : "[picker] no Drive picker (set GOOGLE_PICKER_KEY, and GOOGLE_CLIENT_ID) — cabinets take pasted links only");
console.log(gcalEnabled
  ? "[gcal] Google Calendar can be connected — each person grants it for their own account"
  : "[gcal] no Google credentials — bookings reach a calendar only through the subscribed feed and the email");
console.log(msEnabled
  ? "[mscal] Outlook can be connected — each person grants it for their own account"
  : "[mscal] no Microsoft credentials (set MS_CLIENT_ID and MS_CLIENT_SECRET)");
console.log(`[recording] consent: ${CONSENT_MODE === "notice"
  ? "the room is told and every microphone records"
  : "each person is asked, and only a yes is recorded"}`);

if (!mailEnabled) {
  console.warn(`[mail] no transport configured — sign-in codes, invitations and booking invitations go nowhere (set RESEND_API_KEY, or SMTP_HOST/USER/PASS)`);
} else {
  console.log(`[mail] transport: ${mailTransport} — checking it answers...`);
  void mailCheck()
    .then((r) => (r.ok ? console.log(`[mail] ${r.detail}`) : console.error(`[mail] NOT working — ${r.detail}`)))
    .catch((e) => console.error("[mail] check failed:", e));
}
app.listen(port, () => console.log(`[api] NexSpace API on http://localhost:${port}  (db: ${process.env.DATABASE_URL})`));
