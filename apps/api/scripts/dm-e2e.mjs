#!/usr/bin/env node
/**
 * Private messages, and the wall between them and the room.
 *
 * The assertion this suite exists for is the negative one: a line addressed to
 * one person must never appear in the room's history. Everything else here is
 * ordinary CRUD; that one is the difference between a feature and an incident.
 *
 * The rest is about who may be addressed. A private thread needs an account at
 * both ends and both accounts in the same space — otherwise a workspace becomes
 * a way to reach any account on the server that happens to share it.
 *
 *   npm run dev                      # for the database and the game server
 *   node apps/api/scripts/dm-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { Client } from "colyseus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3983;
const API = `http://127.0.0.1:${PORT}`;
const GAME = "ws://localhost:2567";

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

console.log("\ndirect messages\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { /* not yet */ }
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast -------------------------------------------------------------------

const stamp = Date.now();
const person = async (who) => {
  const d = await post("/auth/register", { email: `dm-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });
  return { name: who, token: d.token, id: d.user?.id };
};

const alice = await person("alice");
const bob = await person("bob");
const carol = await person("carol");     // in the space, but not in this thread
const stranger = await person("stranger"); // an account, elsewhere

const ws = (await post("/workspaces", { name: `dm-${stamp}` }, alice.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, bob.token);
await post("/workspaces/join", { code: ws.inviteCode }, carol.token);
const elsewhere = (await post("/workspaces", { name: `far-${stamp}` }, stranger.token)).workspace;

const guest = (await post(`/workspaces/${ws.slug}/guests`, { name: "ผู้มาเยือน" }, alice.token)).guest;

if (!ws?.slug || !alice.id || !bob.id) {
  console.error("! fixtures did not come back in the expected shape");
  stop(); process.exit(1);
}

// ---- the wall ---------------------------------------------------------------
// First, because it is the one that matters.

{
  await post(`/workspaces/${ws.slug}/messages`, { text: "ทุกคนอ่านได้" }, alice.token);
  await post(`/workspaces/${ws.slug}/dm/${bob.id}`, { text: "ความลับระหว่างเราสองคน" }, alice.token);

  const room = await get(`/workspaces/${ws.slug}/messages`, carol.token);
  const texts = (room.messages ?? []).map((m) => m.text);
  ok("the room shows what was said to the room", texts.includes("ทุกคนอ่านได้"));
  ok("the room does NOT show a private line", !texts.includes("ความลับระหว่างเราสองคน"),
    texts.join(" | "));

  const asAlice = await get(`/workspaces/${ws.slug}/messages`, alice.token);
  ok("  · not even to the person who sent it", !(asAlice.messages ?? []).some((m) => m.text === "ความลับระหว่างเราสองคน"));

  const asGuest = await get(`/workspaces/${ws.slug}/messages?guest=${encodeURIComponent(guest.code)}`);
  ok("  · and not to a visitor reading the room", !(asGuest.messages ?? []).some((m) => m.text === "ความลับระหว่างเราสองคน"));
}

// ---- who may be addressed ---------------------------------------------------

{
  const r = await post(`/workspaces/${ws.slug}/dm/${bob.id}`, { text: "สวัสดี bob" }, alice.token);
  ok("a member can write to a member", r.status === 200, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/dm/${stranger.id}`, { text: "hello" }, alice.token);
  ok("an account outside this space cannot be addressed", r.status === 404, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/dm/${bob.id}`, { text: "hello" }, stranger.token);
  ok("and cannot write into it either", r.status === 401, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/dm/${alice.id}`, { text: "note to self" }, alice.token);
  ok("nobody writes to themselves", r.status === 400, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/dm/${bob.id}`, { text: "   " }, alice.token);
  ok("an empty line is refused", r.status === 400, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/dm/${bob.id}`, { text: "no token" });
  ok("a stranger cannot write", r.status === 401, `status ${r.status}`);
}

// ---- reading a thread -------------------------------------------------------

await post(`/workspaces/${ws.slug}/dm/${alice.id}`, { text: "สวัสดี alice" }, bob.token);

{
  const r = await get(`/workspaces/${ws.slug}/dm/${bob.id}`, alice.token);
  ok("the thread holds both sides", r.messages?.length === 3, String(r.messages?.length));
  ok("  · oldest first", r.messages?.[0]?.text === "ความลับระหว่างเราสองคน", r.messages?.[0]?.text);
  ok("  · hers are marked as hers", r.messages?.[0]?.mine === true && r.messages?.at(-1)?.mine === false);

  const mirror = await get(`/workspaces/${ws.slug}/dm/${alice.id}`, bob.token);
  ok("  · and bob sees the same three the other way round",
    mirror.messages?.length === 3 && mirror.messages?.at(-1)?.mine === true);
}
{
  const r = await get(`/workspaces/${ws.slug}/dm/${bob.id}`, carol.token);
  ok("carol's thread with bob is her own, and empty", r.status === 200 && r.messages?.length === 0,
    `status ${r.status}, ${r.messages?.length} messages`);
}
{
  const r = await get(`/workspaces/${ws.slug}/dm/${bob.id}`, stranger.token);
  ok("an outsider reads no thread here", r.status === 401, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${elsewhere.slug}/dm/${bob.id}`, stranger.token);
  ok("nor by asking from a space of their own", r.status === 404, `status ${r.status}`);
}

// ---- the list, and what is unread -------------------------------------------

{
  // carol has read nothing from bob yet
  await post(`/workspaces/${ws.slug}/dm/${carol.id}`, { text: "ถึง carol 1" }, bob.token);
  await post(`/workspaces/${ws.slug}/dm/${carol.id}`, { text: "ถึง carol 2" }, bob.token);

  const list = await get(`/workspaces/${ws.slug}/dm`, carol.token);
  const withBob = list.threads?.find((t) => t.peerId === bob.id);
  ok("a thread appears in the list once written to", !!withBob);
  ok("  · with the newest line on it", withBob?.text === "ถึง carol 2", withBob?.text);
  ok("  · and both lines counted as unread", withBob?.unread === 2, String(withBob?.unread));
  ok("  · named after the other person", withBob?.name === "bob", withBob?.name);

  await get(`/workspaces/${ws.slug}/dm/${bob.id}`, carol.token);   // reading it
  const after = await get(`/workspaces/${ws.slug}/dm`, carol.token);
  ok("reading the thread clears the count",
    after.threads?.find((t) => t.peerId === bob.id)?.unread === 0,
    String(after.threads?.find((t) => t.peerId === bob.id)?.unread));

  await post(`/workspaces/${ws.slug}/dm/${carol.id}`, { text: "ถึง carol 3" }, bob.token);
  const again = await get(`/workspaces/${ws.slug}/dm`, carol.token);
  ok("  · and a new line starts counting again",
    again.threads?.find((t) => t.peerId === bob.id)?.unread === 1);

  const bobList = await get(`/workspaces/${ws.slug}/dm`, bob.token);
  ok("bob's own list holds both his threads", bobList.threads?.length === 2,
    bobList.threads?.map((t) => t.name).join(", "));
  // He wrote everything to carol and read alice thread above, so nothing is
  // waiting for him here. Stated exactly: an assertion that cannot fail is
  // worse than no assertion at all.
  ok("  · and nothing waiting, having sent or read all of it",
    bobList.threads?.every((t) => t.unread === 0) === true,
    bobList.threads?.map((t) => `${t.name}:${t.unread}`).join(" "));
}

// ---- over the socket --------------------------------------------------------

{
  const join = (token, name) => new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token, name });
  let gameUp = true;
  let aliceRoom, bobRoom;
  try {
    aliceRoom = await join(alice.token, "alice");
    bobRoom = await join(bob.token, "bob");
  } catch (e) {
    gameUp = false;
    console.log(`  skip  the game server is not running on 2567 (${e.message})`);
  }

  if (gameUp) {
    // the room has to know who each player is before it can address one
    await new Promise((r) => setTimeout(r, 800));
    const mine = [...bobRoom.state.players.values()].map((p) => p.userId).filter(Boolean);
    ok("players carry their account id", mine.length >= 2, mine.length + " of " + bobRoom.state.players.size);

    const delivered = new Promise((res) => {
      bobRoom.onMessage("dm", (m) => res(m));
      setTimeout(() => res(null), 4000);
    });
    aliceRoom.onMessage("dm", () => {});
    aliceRoom.send("dm", { to: bob.id, text: "ส่งสดผ่านซ็อกเก็ต" });

    const got = await delivered;
    ok("a private line reaches the other person live", !!got, got ? "" : "nothing arrived in 4s");
    ok("  · addressed from the sender's account", got?.from === alice.id, got?.from);

    await new Promise((r) => setTimeout(r, 1000));
    const thread = await get(`/workspaces/${ws.slug}/dm/${alice.id}`, bob.token);
    ok("  · and is written down as well", thread.messages?.some((m) => m.text === "ส่งสดผ่านซ็อกเก็ต"));

    const room = await get(`/workspaces/${ws.slug}/messages`, carol.token);
    ok("  · without leaking into the room", !(room.messages ?? []).some((m) => m.text === "ส่งสดผ่านซ็อกเก็ต"));

    await aliceRoom.leave();
    await bobRoom.leave();
  }
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
