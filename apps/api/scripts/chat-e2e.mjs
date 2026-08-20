#!/usr/bin/env node
/**
 * Room chat that survives a refresh.
 *
 * The rules worth pinning down are about who may read: a space's conversation is
 * as private as the space, so the same door that admits someone to the room is
 * the one that shows them what was said in it. A members-only space must not
 * hand its history to a stranger holding a valid account elsewhere.
 *
 * Retention is checked by making a message old rather than by waiting: a row is
 * written with a date in the past, an API is started with a short keep-window,
 * and the row has to be gone.
 *
 *   npm run dev                        # for the database
 *   node apps/api/scripts/chat-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { createRequire } from "module";
import { Client } from "colyseus.js";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3985;
const API = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const call = async (method, path, { body, token } = {}) => {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const post = (p, body, token) => call("POST", p, { body, token });
const get = (p, token) => call("GET", p, { token });

// ---- a server of our own ----------------------------------------------------

const serve = (port, env) => spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR,
  env: { ...process.env, PORT: String(port), ...env },
  stdio: ["ignore", "pipe", "pipe"],
});

const waitFor = async (base) => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/health")).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

for (const port of [PORT, PORT + 1]) {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
    console.error(`! something is already listening on ${port} — stop it first`);
    process.exit(1);
  } catch { /* free, as it should be */ }
}

const api = serve(PORT, { CHAT_KEEP_DAYS: "90" });
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
api.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[api] ${d}`));
const stop = () => { try { api.kill(); } catch { /* gone */ } };
process.on("exit", stop);

console.log("\nroom chat\n");
if (!(await waitFor(API))) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast -------------------------------------------------------------------

const stamp = Date.now();  // every run gets its own space, so counts are exact
const person = async (who) => {
  const d = await post("/auth/register", { email: `chat-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });
  return { name: who, token: d.token, id: d.user?.id };
};

const alice = await person("alice");
const bob = await person("bob");
const outsider = await person("outsider");

const ws = (await post("/workspaces", { name: `chat-${stamp}` }, alice.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, bob.token);
// a second space, to prove one space's history stays in it
const other = (await post("/workspaces", { name: `other-${stamp}` }, outsider.token)).workspace;

const guest = (await post(`/workspaces/${ws.slug}/guests`, { name: "ผู้มาเยือน" }, alice.token)).guest;
const revoked = (await post(`/workspaces/${ws.slug}/guests`, { name: "หมดสิทธิ์" }, alice.token)).guest;
await call("PATCH", `/workspaces/${ws.slug}/guests/${revoked.id}`, { body: { revoked: true }, token: alice.token });

if (!ws?.slug || !guest?.code || !revoked?.code) {
  console.error("! fixtures did not come back in the expected shape");
  stop(); process.exit(1);
}

// close the door, so "member" and "anyone with an account" are different things
await call("PATCH", `/workspaces/${ws.slug}`, { body: { allowGuests: false }, token: alice.token });

// ---- writing ----------------------------------------------------------------

{
  const r = await post(`/workspaces/${ws.slug}/messages`, { text: "สวัสดีครับ" }, alice.token);
  ok("a member can say something", r.status === 200, `status ${r.status}`);
  ok("  · and it comes back as stored", r.message?.text === "สวัสดีครับ" && r.message?.name === "alice");
}
{
  const r = await post(`/workspaces/${ws.slug}/messages`, { text: "   " }, alice.token);
  ok("an empty line is refused", r.status === 400, `status ${r.status}`);
}
{
  const long = "x".repeat(500);
  const r = await post(`/workspaces/${ws.slug}/messages`, { text: long }, alice.token);
  ok("a very long line is cut, not rejected", r.status === 200 && r.message?.text.length === 300,
    `${r.message?.text.length} characters`);
}
{
  const r = await post(`/workspaces/${ws.slug}/messages`, { text: "hello" });
  ok("a stranger cannot speak", r.status === 401, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/messages`, { text: "hello" }, outsider.token);
  ok("an account from another space cannot speak here", r.status === 401, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/messages?guest=${encodeURIComponent(guest.code)}`, { text: "ขอเข้าห้องด้วยครับ" });
  ok("a live pass can speak", r.status === 200, `status ${r.status}`);
  ok("  · under the name on the pass", r.message?.name === "ผู้มาเยือน", r.message?.name);
}
{
  const r = await post(`/workspaces/${ws.slug}/messages?guest=${encodeURIComponent(revoked.code)}`, { text: "still here?" });
  ok("a revoked pass cannot speak", r.status === 401, `status ${r.status}`);
}

await post(`/workspaces/${ws.slug}/messages`, { text: "ทดสอบจาก bob" }, bob.token);

// ---- reading ----------------------------------------------------------------

let history;
{
  history = await get(`/workspaces/${ws.slug}/messages`, alice.token);
  ok("a member reads the history", history.status === 200, `status ${history.status}`);
  ok("  · oldest first, the order it was read in",
    history.messages?.[0]?.text === "สวัสดีครับ" && history.messages?.at(-1)?.text === "ทดสอบจาก bob",
    history.messages?.map((m) => m.name).join(" → "));
  ok("  · four lines, since one was refused and one was cut", history.messages?.length === 4,
    String(history.messages?.length));
  ok("  · her own are marked as hers", history.messages?.[0]?.mine === true);
  ok("  · and bob's are not", history.messages?.at(-1)?.mine === false);
}
{
  const r = await get(`/workspaces/${ws.slug}/messages`, bob.token);
  ok("bob sees the same conversation", r.messages?.length === history.messages?.length);
  ok("  · with the ownership the other way round",
    r.messages?.at(-1)?.mine === true && r.messages?.[0]?.mine === false);
}
{
  const r = await get(`/workspaces/${ws.slug}/messages`);
  ok("a stranger reads nothing", r.status === 401, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/messages`, outsider.token);
  ok("an account from another space reads nothing", r.status === 401, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/messages?guest=${encodeURIComponent(guest.code)}`);
  ok("a live pass reads the room it was issued for", r.status === 200 && r.messages?.length === 4, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/messages?guest=${encodeURIComponent(revoked.code)}`);
  ok("a revoked pass reads nothing", r.status === 401, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${other.slug}/messages`, outsider.token);
  ok("another space's history is its own", r.status === 200 && r.messages?.length === 0,
    `status ${r.status}, ${r.messages?.length} messages`);
}

// ---- paging -----------------------------------------------------------------

{
  const r = await get(`/workspaces/${ws.slug}/messages?limit=2`, alice.token);
  ok("a page holds what was asked for", r.messages?.length === 2, String(r.messages?.length));
  ok("  · and says there is more behind it", r.more === true);
  ok("  · the newest ones, oldest first", r.messages?.at(-1)?.text === "ทดสอบจาก bob");

  const older = await get(`/workspaces/${ws.slug}/messages?limit=2&before=${encodeURIComponent(r.messages[0].at)}`, alice.token);
  ok("  · and the page before it goes further back", older.messages?.[0]?.text === "สวัสดีครับ",
    older.messages?.map((m) => m.text.slice(0, 12)).join(" | "));
}

// ---- the whole path, over the socket ----------------------------------------
// Everything above talks to the API directly. What people actually do is type
// into a room, and the game server writes it down on their behalf using the
// credential it was let in with. That is the join this change added, and it is
// the one that would break silently: the room would still relay every message,
// and only the history would quietly stop.

const GAME = "ws://localhost:2567";

const sayInRoom = async (opts, text) => {
  const room = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, name: opts.name ?? "socket", ...opts });
  room.onMessage("roomchat", () => {});   // we caused this broadcast; ignoring it quietly
  room.send("roomchat", { text });
  // the write is deliberately not awaited by the room, so give it a moment
  await new Promise((r) => setTimeout(r, 1200));
  await room.leave();
};

let gameUp = true;
try {
  await sayInRoom({ token: bob.token, name: "bob" }, "ส่งผ่านซ็อกเก็ต");
} catch (e) {
  gameUp = false;
  console.log(`  skip  the game server is not running on 2567 — start it with npm run dev  (${e.message})`);
}

if (gameUp) {
  const r = await get(`/workspaces/${ws.slug}/messages`, alice.token);
  const line = r.messages?.find((m) => m.text === "ส่งผ่านซ็อกเก็ต");
  ok("a line typed in the room is written down", !!line);
  ok("  · under the name of whoever typed it", line?.name === "bob", line?.name);

  await sayInRoom({ guest: guest.code, name: "visitor" }, "แขกพิมพ์ในห้อง");
  const r2 = await get(`/workspaces/${ws.slug}/messages`, alice.token);
  const g = r2.messages?.find((m) => m.text === "แขกพิมพ์ในห้อง");
  ok("a visitor's line is written down too", !!g);
  ok("  · under the name on their pass, not the one they typed",
    g?.name === "ผู้มาเยือน", g?.name);

  // The room lets a member of this space in and nobody else, so there is no
  // "outsider speaks through the socket" case to test: they never get in. That
  // is covered by the guest-pass suite, which tests the door itself.
}

// ---- forgetting -------------------------------------------------------------

{
  const prisma = new PrismaClient();
  const w = await prisma.workspace.findUnique({ where: { slug: ws.slug } });
  const old = await prisma.message.create({
    data: {
      workspaceId: w.id, userId: alice.id, authorName: "alice", body: "ปีที่แล้ว",
      createdAt: new Date(Date.now() - 400 * 86_400_000),
    },
  });
  const recent = await prisma.message.findFirst({ where: { workspaceId: w.id }, orderBy: { createdAt: "desc" } });

  const sweeper = serve(PORT + 1, { CHAT_KEEP_DAYS: "90" });
  const up = await waitFor(`http://127.0.0.1:${PORT + 1}`);
  // the sweep runs at startup, so by the time /health answers it has been fired;
  // give the query a moment to land
  await new Promise((r) => setTimeout(r, 1500));

  const stillOld = await prisma.message.findUnique({ where: { id: old.id } });
  const stillRecent = await prisma.message.findUnique({ where: { id: recent.id } });
  ok("a message past the keep-window is dropped", up && stillOld === null, up ? "" : "the second API never came up");
  ok("  · and today's is not", stillRecent !== null);

  sweeper.kill();
  await prisma.$disconnect();
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
