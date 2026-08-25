#!/usr/bin/env node
/**
 * Gestures and stickers.
 *
 * Two things that look alike and behave differently on purpose. A gesture is a
 * moment: it goes to everybody who can SEE you, which is a wider circle than
 * the one that can hear you — a wave across a room is the whole point of
 * waving. A sticker is a thing left behind: it goes into room state so it is
 * still there for somebody who walks past later, and only the person who left
 * it can pick it up again.
 *
 * Both are held to an allow-list, because both are drawn in other people's
 * windows and an open text field there is a way to write on somebody's screen.
 *
 *   npm run dev
 *   node apps/api/scripts/emote-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { Client } from "colyseus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3993;
const API = `http://127.0.0.1:${PORT}`;
const GAME = "ws://localhost:2567";
const TILE = 32;

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

console.log("\ngestures and stickers\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await settle(500); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- a space with two maps -------------------------------------------------------

const stamp = Date.now();
const owner = await post("/auth/register", { email: `emote-${stamp}@test.local`, name: "owner", password: "hunter2pw" });
// A plain member, because "somebody else cannot pick up your sticker" is a rule
// about roles: with everyone signed in as the owner it could never be tested,
// since an owner tidying up anybody's sticker is the intended escape hatch.
const member = await post("/auth/register", { email: `emote-m-${stamp}@test.local`, name: "member", password: "hunter2pw" });
const ws = (await post("/workspaces", { name: `emote-${stamp}` }, owner.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, member.token);

const plainMap = (id, label) => ({
  v: 1, id, label, cols: 20, rows: 16,
  spawn: { x: 2, y: 13 }, meetingRoom: { x0: 0, x1: 0, y0: 0, y1: 0 },
  floors: Array.from({ length: 16 }, () => Array.from({ length: 20 }, () => 0)),
  walls: [], furniture: [], outdoor: [], decals: [], decor: [], desks: [], interactives: [], areas: [],
});
for (const [id, label] of [["ground", "ชั้นล่าง"], ["second", "ชั้นสอง"]]) {
  const r = await fetch(`${API}/workspaces/${ws.slug}/map/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ map: plainMap(id, label) }),
  });
  if (!r.ok) { console.error(`! could not store the ${id} map`); stop(); process.exit(1); }
}

// ---- the cast ----------------------------------------------------------------------

const open = [];
const join = async (name, map, token = owner.token) => {
  const room = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token, name });
  const emotes = [];
  room.onMessage("emote", (m) => emotes.push(m));
  room.onMessage("chat", () => {});
  room.onMessage("roomchat", () => {});
  room.send("map", map);
  open.push(room);
  return { name, room, emotes };
};

const at = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2, dir: "down", moving: false });

let a, b, upstairs;
try {
  a = await join("a", "ground", member.token);
  b = await join("b", "ground", member.token);
  upstairs = await join("upstairs", "second", member.token);
} catch (e) {
  console.log(`  skip  the game server is not running on 2567 — start it with npm run dev  (${e.message})`);
  stop();
  process.exit(0);
}
await settle(800);

// ---- gestures --------------------------------------------------------------------

{
  // Deliberately far apart: 14 tiles, well past the five-tile earshot. Seeing a
  // gesture is not hearing one, and that difference is the feature.
  a.room.send("move", at(2, 2));
  b.room.send("move", at(16, 2));
  upstairs.room.send("move", at(2, 2));
  await settle(400);
  for (const w of [a, b, upstairs]) w.emotes.length = 0;

  a.room.send("emote", "dance");
  await settle(600);
  ok("a gesture reaches somebody across the room, far past earshot",
    b.emotes.some((m) => m.kind === "dance" && m.from === a.room.sessionId), JSON.stringify(b.emotes));
  ok("  · and comes back to the person who made it, so they see it too",
    a.emotes.some((m) => m.kind === "dance"), JSON.stringify(a.emotes));
  ok("  · but not to another floor", !upstairs.emotes.length, JSON.stringify(upstairs.emotes));
}
{
  for (const w of [a, b]) w.emotes.length = 0;
  a.room.send("emote", "เต้น <script>");
  await settle(500);
  ok("a gesture that is not on the list is refused", !b.emotes.length, JSON.stringify(b.emotes));
}
{
  // past the throttle from the gesture above, or this measures that one
  await settle(1700);
  b.emotes.length = 0;
  a.room.send("emote", "clap");
  a.room.send("emote", "clap");
  a.room.send("emote", "clap");
  await settle(600);
  ok("leaning on the button sends one, not three", b.emotes.length === 1, `${b.emotes.length} arrived`);
}

// ---- stickers ------------------------------------------------------------------------

const stickersOf = (w) => [...w.room.state.stickers.values()];
const mine = (w, emoji) => stickersOf(w).filter((s) => s.emoji === emoji);

{
  a.room.send("sticker", { emoji: "⭐", x: 5 * TILE, y: 5 * TILE });
  await settle(700);
  ok("a sticker lands in room state, where a latecomer will find it",
    mine(a, "⭐").length === 1, `${stickersOf(a).length} stickers`);
  ok("  · and reaches the other browsers", mine(b, "⭐").length === 1);
  const s = mine(b, "⭐")[0];
  ok("  · carrying where it is, who left it and which map",
    s.x === 5 * TILE && s.y === 5 * TILE && s.by === "a" && s.map === "ground", JSON.stringify(s));
}
{
  // Past the one-per-second throttle first. Sent any sooner these would be
  // dropped for being too quick, and the assertion would hold with no
  // allow-list at all — which is how a check passes for the wrong reason.
  await settle(1200);
  const before = stickersOf(a).length;
  a.room.send("sticker", { emoji: "not an emoji", x: 100, y: 100 });
  await settle(600);
  ok("a sticker that is not on the list is refused", stickersOf(a).length === before, `${stickersOf(a).length}`);
}
{
  await settle(1200);
  const before = stickersOf(a).length;
  a.room.send("sticker", { emoji: "❤️" });
  await settle(600);
  ok("  · and so is one with nowhere to go", stickersOf(a).length === before, `${stickersOf(a).length}`);
}
{
  // somebody upstairs leaves one on their own floor
  upstairs.room.send("sticker", { emoji: "🔥", x: 3 * TILE, y: 3 * TILE });
  await settle(700);
  const s = mine(a, "🔥")[0];
  ok("a sticker knows which floor it is stuck to", s?.map === "second", JSON.stringify(s));
}
{
  // Only the person who left it may take it back. Everybody can see every
  // sticker in state, so the rule has to be on the server.
  const id = [...b.room.state.stickers.entries()].find(([, s]) => s.emoji === "⭐")?.[0];
  b.room.send("unsticker", id);
  await settle(600);
  ok("another member cannot pick up your sticker", mine(a, "⭐").length === 1, `${mine(a, "⭐").length} left`);
  a.room.send("unsticker", id);
  await settle(600);
  ok("  · and you can", mine(a, "⭐").length === 0, `${mine(a, "⭐").length} left`);
}
{
  // Somebody has to be able to tidy up after a person who has gone home, and
  // the space's owner is who that is.
  a.room.send("sticker", { emoji: "❗", x: 7 * TILE, y: 7 * TILE });
  await settle(700);
  const boss = await join("boss", "ground", owner.token);
  await settle(700);
  const id = [...boss.room.state.stickers.entries()].find(([, s]) => s.emoji === "❗")?.[0];
  boss.room.send("unsticker", id);
  await settle(700);
  ok("the space's owner can tidy up anybody's", mine(a, "❗").length === 0, `${mine(a, "❗").length} left`);
}
{
  // The per-person ceiling drops the oldest rather than refusing the newest: a
  // button that silently does nothing is worse than a short memory.
  const before = stickersOf(a).length;
  for (let i = 0; i < 15; i++) {
    a.room.send("sticker", { emoji: "🌿", x: (i + 1) * TILE, y: 9 * TILE });
    await settle(1100); // past the one-per-second throttle
  }
  await settle(600);
  const leaves = mine(a, "🌿").length;
  ok("one person cannot paper the whole floor", leaves === 12, `${leaves} of 15 kept`);
  ok("  · and it is the oldest that goes",
    !mine(a, "🌿").some((s) => s.x === 1 * TILE), JSON.stringify(mine(a, "🌿").map((s) => s.x / TILE)));
  ok("  · leaving other people's alone", stickersOf(a).length >= before);
}

for (const r of open) { try { await r.leave(); } catch { /* going anyway */ } }
stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
