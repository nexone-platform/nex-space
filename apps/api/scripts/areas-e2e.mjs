#!/usr/bin/env node
/**
 * Private areas: standing in the same room beats standing close.
 *
 * The rule has two halves and the second is the one worth testing. That people
 * in a room hear each other across it is a feature; that somebody one tile the
 * other side of the doorway hears NOTHING is a promise, and a promise that
 * breaks quietly — the message still arrives, just to one person too many.
 *
 * Everything here goes through real sockets, because the browser's copy of the
 * rule decides who you can hear and the server's copy decides who receives what
 * you type. Only the server's can be tested from here, and it is the one that
 * would leak.
 *
 *   npm run dev                         # API on 3001 and the game server on 2567
 *   node apps/api/scripts/areas-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { Client } from "colyseus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3987;
const API = `http://127.0.0.1:${PORT}`;
const GAME = "ws://localhost:2567";
const TILE = 32;
/** a player standing in the middle of a tile, in the pixels the client sends */
const at = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2, dir: "down", moving: false });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const post = async (path, body, token) => {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

// ---- a server of our own, on the same database the game server reads --------

try {
  await fetch(`${API}/health`, { signal: AbortSignal.timeout(700) });
  console.error(`! something is already listening on ${PORT} — stop it first`);
  process.exit(1);
} catch { /* free, as it should be */ }

const api = spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
api.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[api] ${d}`));
const stop = () => { try { api.kill(); } catch { /* gone */ } };
process.on("exit", stop);

console.log("\nprivate areas\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await settle(500); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- one space on the classic map -------------------------------------------

const stamp = Date.now();
const owner = await post("/auth/register", { email: `area-${stamp}@test.local`, name: "owner", password: "hunter2pw" });
const ws = (await post("/workspaces", { name: `area-${stamp}`, theme: "classic" }, owner.token)).workspace;
if (!ws?.slug || ws.theme !== "classic") {
  console.error("! the fixture space did not come back on the classic map:", ws?.theme);
  stop(); process.exit(1);
}

// ---- the cast, all in one room ----------------------------------------------

const joined = [];
const join = async (name) => {
  const room = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token: owner.token, name });
  const heard = [];
  room.onMessage("chat", (m) => heard.push(m));
  room.onMessage("roomchat", () => {});
  joined.push(room);
  return { name, room, heard };
};

let a;
try {
  a = await join("a");
} catch (e) {
  console.log(`  skip  the game server is not running on 2567 — start it with npm run dev  (${e.message})`);
  stop();
  process.exit(0);
}
const b = await join("b"), c = await join("c"), d = await join("d");
await settle(700);

/**
 * Put everyone where the case needs them, let one of them speak, and report who
 * received it. The listeners are cleared first so one case cannot read another's
 * message, and the sender's own echo is not a result — everybody hears
 * themselves.
 */
const speak = async (place, from, text) => {
  for (const [who, tile] of place) who.room.send("move", at(tile[0], tile[1]));
  await settle(450);
  for (const [who] of place) who.heard.length = 0;
  from.room.send("chat", { text });
  await settle(650);
  return place
    .filter(([who]) => who !== from && who.heard.some((m) => m.text === text))
    .map(([who]) => who.name);
};

// The classic map: the meeting room is tiles 20-26 x 4-9, its door is at 23,10.
// The lounge (5-11) and the team pod (13-18) share the same rows, one wall apart.

{
  // corner to corner is 7.8 tiles, well past the 5-tile radius
  const got = await speak([[a, [20, 4]], [b, [26, 9]]], a, `ประชุม-${stamp}`);
  ok("across a private area, far past the proximity radius", got.includes("b"),
    got.length ? `heard by ${got}` : "nobody heard it — is the room on the classic map?");
}
{
  // one tile apart, one of them through the doorway
  const got = await speak([[a, [23, 9]], [b, [23, 10]]], a, `ในห้อง-${stamp}`);
  ok("someone one tile outside the door hears nothing", !got.includes("b"), `heard by ${got}`);
}
{
  // and the same in reverse: the person outside is not overheard either
  const got = await speak([[a, [23, 9]], [b, [23, 10]]], b, `นอกห้อง-${stamp}`);
  ok("  · and is not overheard from inside", !got.includes("a"), `heard by ${got}`);
}
{
  // the lounge and the team pod are two tiles apart across one wall
  const got = await speak([[a, [11, 6]], [b, [13, 6]]], a, `คนละโซน-${stamp}`);
  ok("two people in different areas do not hear each other", !got.includes("b"), `heard by ${got}`);
}
{
  // out on the open floor the radius is still the rule
  const got = await speak([[a, [15, 13]], [b, [18, 13]]], a, `ใกล้กัน-${stamp}`);
  ok("out in the open, three tiles apart, still heard", got.includes("b"),
    got.length ? "" : "the plain proximity rule stopped working");
}
{
  const got = await speak([[a, [13, 13]], [b, [20, 13]]], a, `ไกลกัน-${stamp}`);
  ok("  · seven tiles apart, not heard", !got.includes("b"), `heard by ${got}`);
}
{
  // Three in the room and one at the door. The speaker stands beside the door
  // so the person outside it is ONE tile away and the far corner is six: under
  // the old rule the results would be exactly inverted, which is the point.
  const got = await speak([[a, [24, 9]], [b, [20, 4]], [c, [22, 6]], [d, [23, 10]]], a, `ทั้งห้อง-${stamp}`);
  ok("the far corner of the area hears it", got.includes("b") && got.includes("c"), `heard by ${got}`);
  ok("  · and the one tile outside the door does not", !got.includes("d"), `heard by ${got}`);
}
{
  // The open floor is not itself an area: two people out on it hear each other,
  // and the one two tiles away through the meeting-room wall does not.
  const got = await speak([[a, [22, 11]], [b, [21, 12]], [c, [22, 9]]], a, `โถงกลาง-${stamp}`);
  ok("two on the open floor hear each other", got.includes("b"), `heard by ${got}`);
  ok("  · and the one two tiles away inside the room does not", !got.includes("c"), `heard by ${got}`);
}

for (const r of joined) { try { await r.leave(); } catch { /* going anyway */ } }
stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
