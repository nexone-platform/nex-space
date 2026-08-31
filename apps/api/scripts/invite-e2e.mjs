#!/usr/bin/env node
/**
 * The invite link.
 *
 * It used to be the workspace slug and nothing else, so opening it let somebody
 * in as a visitor and never made them a member — the count on the members page
 * did not move, and on a space with guests turned off the link refused them
 * outright. The code is the invitation; the slug is only the address.
 *
 *   npm run dev
 *   node apps/api/scripts/invite-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { Client } from "colyseus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3991;
const API = `http://127.0.0.1:${PORT}`;
const stamp = Date.now();

const call = async (method, p, body, token) => {
  const r = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const post = (p, b, t) => call("POST", p, b, t);
const get = (p, t) => call("GET", p, undefined, t);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

try {
  await fetch(`${API}/health`, { signal: AbortSignal.timeout(700) });
  console.error(`! something is already listening on ${PORT} — stop it first`);
  process.exit(1);
} catch { /* free */ }

const api = spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
api.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[api] ${d}`));
const stop = () => { try { api.kill(); } catch { /* gone */ } };
process.on("exit", stop);

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

const reg = (who) => post("/auth/register", {
  email: `iv-${who}-${stamp}@test.local`, name: who, password: "hunter2pw",
});

const owner = await reg("owner");
const invited = await reg("invited");
const stranger = await reg("stranger");
const ws = (await post("/workspaces", { name: `iv-${stamp}` }, owner.token)).workspace;

const members = async () => (await get(`/workspaces/${ws.slug}/members`, owner.token)).members?.length ?? -1;

console.log("\nopening an invite link\n");

// ---- the link the button builds ----
{
  const seen = await get(`/workspaces/${ws.slug}`, owner.token);
  ok("the owner's copy of the space carries the invite code", !!seen.workspace?.inviteCode,
    JSON.stringify(seen.workspace?.inviteCode));
  ok("  · and their role, which is what shows them the staff buttons",
    seen.workspace?.role === "owner", String(seen.workspace?.role));

  const asked = await get(`/workspaces/${ws.slug}`);
  ok("asked without a token it carries neither", !asked.workspace?.inviteCode && !asked.workspace?.role,
    JSON.stringify([asked.workspace?.inviteCode, asked.workspace?.role]));
}

// ---- somebody opens it ----
const code = (await get(`/workspaces/${ws.slug}`, owner.token)).workspace.inviteCode;
{
  const before = await members();
  ok("one member to start with", before === 1, String(before));

  // this is what the browser now does with ?join=<code>
  const joined = await post("/workspaces/join", { code }, invited.token);
  ok("opening the link makes them a member", joined.status === 200, `status ${joined.status}`);
  const after = await members();
  ok("  · and the count goes up", after === before + 1, `${before} -> ${after}`);

  const again = await post("/workspaces/join", { code }, invited.token);
  ok("  · opening it twice does not count twice", (await members()) === after, `status ${again.status}`);
}

// ---- what the room now calls them ----
{
  const a = await get(`/workspaces/${ws.slug}/access?token=${invited.token}`);
  ok("a member is admitted as a member", a.allowed && a.role === "member", JSON.stringify(a.role));

  const b = await get(`/workspaces/${ws.slug}/access?token=${stranger.token}`);
  ok("somebody who only wandered in is admitted as a guest", b.allowed && b.role === "guest",
    JSON.stringify(b.role));
  ok("  · which is the whole point: they were being called a member",
    b.role !== "member", JSON.stringify(b.role));
}

// ---- and the room really lets the new member in ----
{
  const room = await new Client("ws://localhost:2567").joinOrCreate("office", {
    workspace: ws.slug, token: invited.token, name: "invited",
  });
  for (const m of ["chat", "roomchat", "dm", "ping", "wave"]) room.onMessage(m, () => {});
  await new Promise((r) => setTimeout(r, 1000));
  ok("they can walk in", [...room.state.players.values()].some((p) => p.name === "invited"));
  await Promise.race([room.leave().catch(() => {}), new Promise((d) => setTimeout(d, 1500))]);
}

// ---- a closed space: the link is the only way in ----
{
  await call("PATCH", `/workspaces/${ws.slug}`, { allowGuests: false }, owner.token);
  const shut = await get(`/workspaces/${ws.slug}/access?token=${stranger.token}`);
  ok("with guests off, wandering in is refused", shut.allowed === false, JSON.stringify(shut.reason));

  const joined = await post("/workspaces/join", { code }, stranger.token);
  ok("  · but the invite link still works, which it did not before",
    joined.status === 200, `status ${joined.status}`);
  const now = await get(`/workspaces/${ws.slug}/access?token=${stranger.token}`);
  ok("  · and they are in, as a member", now.allowed && now.role === "member", JSON.stringify(now.role));
}

// ---- a wrong code is not a way in ----
{
  const bad = await post("/workspaces/join", { code: "not-a-real-code" }, stranger.token);
  ok("a made-up code joins nothing", bad.status === 404, `status ${bad.status}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
