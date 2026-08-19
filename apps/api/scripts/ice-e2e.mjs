#!/usr/bin/env node
/**
 * Who may ask for relay credentials, and what they get.
 *
 * The endpoint hands out a password to a service that costs bandwidth, so the
 * interesting assertions are the refusals: a stranger, a revoked pass, a
 * half-finished sign-in. The credential itself is checked by recomputing the
 * signature the way coturn will — if this test and the server ever disagree,
 * every call falls back to a direct connection and nobody finds out until
 * somebody on a locked-down network cannot be heard.
 *
 * It starts its own API on a spare port with a relay configured, so the result
 * does not depend on whether the developer's own .env happens to have one.
 *
 *   npm run dev                       # for the database
 *   node apps/api/scripts/ice-e2e.mjs
 */
import { spawn } from "child_process";
import { createHmac } from "crypto";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3987;
const API = `http://127.0.0.1:${PORT}`;
const BARE = `http://127.0.0.1:${PORT + 1}`;
const SECRET = "test-secret-not-a-real-one";
const HOST = "turn.test.local";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const call = async (path, { token, headers } = {}) => {
  const r = await fetch(API + path, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: r.status, headers: r.headers, ...(await r.json().catch(() => ({}))) };
};

// ---- an API of our own, with a relay ---------------------------------------

const serve = (port, env) => spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR,
  env: { ...process.env, PORT: String(port), ...env },
  stdio: ["ignore", "pipe", "pipe"],
});

// A leftover server from an earlier run would answer every request with the code
// that was running then, which reads as a test failing for reasons that were
// fixed minutes ago. Refuse to start rather than test the wrong thing.
for (const port of [PORT, PORT + 1]) {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
    console.error(`! something is already listening on ${port} — stop it first (a stray from an earlier run?)`);
    process.exit(1);
  } catch { /* nothing there, which is what we want */ }
}

const api = serve(PORT, { TURN_SECRET: SECRET, TURN_HOST: HOST, TURN_PORT: "3478", TURN_TTL: "600" });
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
api.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[api] ${d}`));
const stop = () => { try { api.kill(); } catch { /* already gone */ } };
process.on("exit", stop);

const waitForApi = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(API + "/health")).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

console.log("\nice endpoint\n");
if (!(await waitForApi())) {
  console.error("! the test API never came up — is the database reachable?");
  stop();
  process.exit(1);
}

// ---- fixtures ---------------------------------------------------------------

const stamp = Date.now();
const post = async (path, body, token) => {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

const me = await post("/auth/register", { email: `ice-${stamp}@test.local`, name: "ice", password: "hunter2pw" });
const ws = (await post("/workspaces", { name: `ice-${stamp}` }, me.token)).workspace;
const guest = (await post(`/workspaces/${ws.slug}/guests`, { name: "ผู้มาเยือน" }, me.token)).guest;
const revoked = (await post(`/workspaces/${ws.slug}/guests`, { name: "ถูกเพิกถอน" }, me.token)).guest;
await fetch(`${API}/workspaces/${ws.slug}/guests/${revoked.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json", authorization: `Bearer ${me.token}` },
  body: JSON.stringify({ revoked: true }),
});

// Guard against the shape of these answers changing under the test: without a
// code, every "is it refused?" below would be answered by the wrong rule.
if (!guest?.code || !revoked?.code) {
  console.error("! the guest-pass endpoint did not return codes — the rest of this suite would be meaningless");
  stop();
  process.exit(1);
}

// ---- the door ---------------------------------------------------------------

{
  const r = await call("/ice");
  ok("a stranger gets nothing", r.status === 401, `status ${r.status}`);
}
{
  const r = await call("/ice", { token: "not-a-real-token" });
  ok("a made-up token gets nothing", r.status === 401, `status ${r.status}`);
}
{
  // the same code, before and after: only the revocation can explain the change
  const before = await call(`/ice?guest=${encodeURIComponent(guest.code)}`);
  const r = await call(`/ice?guest=${encodeURIComponent(revoked.code)}`);
  ok("a revoked pass gets nothing", r.status === 401, `status ${r.status}`);
  ok("  · while a live one issued beside it does not", before.status === 200, `status ${before.status}`);
}
{
  const r = await call("/ice?guest=no-such-code");
  ok("an invented pass code gets nothing", r.status === 401, `status ${r.status}`);
}

// ---- what a member gets -----------------------------------------------------

let member;
{
  member = await call("/ice", { token: me.token });
  ok("a member gets an answer", member.status === 200, `status ${member.status}`);
  ok("  · it says a relay exists", member.relay === true);
  ok("  · a STUN server is listed first", /^stun:/.test(String(member.iceServers?.[0]?.urls)));
  const relay = member.iceServers?.find((s) => String(s.urls).includes("turn:"));
  ok("  · a relay entry carries a credential", !!relay?.username && !!relay?.credential);
  ok("  · both transports are offered", Array.isArray(relay?.urls) &&
    relay.urls.some((u) => u.endsWith("transport=udp")) && relay.urls.some((u) => u.endsWith("transport=tcp")),
    JSON.stringify(relay?.urls));
  ok("  · it points at the configured host", String(relay?.urls?.[0]).includes(HOST));
}

// ---- the credential itself --------------------------------------------------

{
  const relay = member.iceServers.find((s) => String(s.urls).includes("turn:"));
  const [expiry, who] = String(relay.username).split(":");
  const secs = Number(expiry);
  const now = Math.floor(Date.now() / 1000);

  ok("the username is an expiry and a name", Number.isFinite(secs) && !!who, relay.username);
  ok("  · it expires in the future", secs > now, `${secs - now}s from now`);
  ok("  · by about the configured lifetime", Math.abs(secs - now - 600) <= 5, `${secs - now}s vs 600s`);
  ok("  · and names the account it was issued to", who === `u${me.user.id}`, who);

  // The whole point: coturn will recompute exactly this and compare.
  const expected = createHmac("sha1", SECRET).update(relay.username).digest("base64");
  ok("the password is the username signed with the shared secret", relay.credential === expected);

  const wrong = createHmac("sha1", "some-other-secret").update(relay.username).digest("base64");
  ok("  · and not what a different secret would produce", relay.credential !== wrong);
}

// ---- what a guest gets ------------------------------------------------------

{
  const r = await call(`/ice?guest=${encodeURIComponent(guest.code)}`);
  ok("a live pass gets an answer", r.status === 200, `status ${r.status}`);
  const relay = r.iceServers?.find((s) => String(s.urls).includes("turn:"));
  ok("  · with a credential of its own", !!relay?.credential && relay.credential !== member.iceServers.find((s) => String(s.urls).includes("turn:")).credential);
  ok("  · issued to the pass, not to an account", String(relay?.username).split(":")[1] === `g${guest.id}`);
}

// ---- caching ----------------------------------------------------------------

{
  const r = await fetch(API + "/ice", { headers: { authorization: `Bearer ${me.token}` } });
  ok("the answer is never cached", (r.headers.get("cache-control") || "").includes("no-store"),
    r.headers.get("cache-control") || "(no header)");
}

// ---- and with no relay configured, it still answers -------------------------

{
  // A deployment without a relay must not break the call setup — it just gets
  // STUN, which is what this app ran on before there was a relay at all.
  const bare = serve(PORT + 1, { TURN_SECRET: "", TURN_HOST: "" });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`${BARE}/health`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (up) {
    const r = await fetch(`${BARE}/ice`, { headers: { authorization: `Bearer ${me.token}` } });
    const d = await r.json();
    ok("without a relay it still answers", r.status === 200, `status ${r.status}`);
    ok("  · saying plainly that there is none", d.relay === false && d.ttl === 0);
    ok("  · with STUN, so direct calls still work", /^stun:/.test(String(d.iceServers?.[0]?.urls)));
    ok("  · and no credential to leak", !d.iceServers.some((s) => s.credential));
  } else {
    ok("without a relay it still answers", false, "the second API never came up");
  }
  bare.kill();
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
