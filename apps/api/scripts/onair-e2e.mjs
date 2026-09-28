#!/usr/bin/env node
/**
 * Broadcasting, through real sockets.
 *
 * onair-check covers the rule itself against a fake clock. This covers the part
 * that rule cannot see: that the room asks it at all, that the role it asks
 * about is the one the API issued rather than one the browser claimed, and that
 * the answer reaches every other window in the space.
 *
 * The case worth the whole file is the second one. A member being refused is
 * enforced in exactly one place — here — and a browser does not have to be
 * involved to send this message. If the check ever moves to the client, every
 * other test in the project still passes.
 *
 *   npm run dev                          # API on 3001 and the game server on 2567
 *   node apps/api/scripts/onair-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { Client } from "colyseus.js";
import { MAX_ON_AIR_MS } from "../../game-server/src/onair.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3988;
const API = `http://127.0.0.1:${PORT}`;
const GAME = "ws://localhost:2567";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, path, body, token) => {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const post = (p, b, t) => call("POST", p, b, t);

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

console.log("\nspeaking to the whole map\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await settle(500); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- one space, four roles --------------------------------------------------

const stamp = Date.now();
const person = async (who) => post("/auth/register",
  { email: `air-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });

const owner = await person("owner");
const admin = await person("admin");
const staff = await person("staff");
const ws = (await post("/workspaces", { name: `air-${stamp}` }, owner.token)).workspace;
for (const p of [admin, staff]) await post("/workspaces/join", { code: ws.inviteCode }, p.token);
await call("PATCH", `/workspaces/${ws.slug}/members/${admin.user.id}`, { role: "admin" }, owner.token);

// ---- everybody in the room --------------------------------------------------

const joined = [];
const join = async (name, token) => {
  const room = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token, name });
  const said = [];       // the "onair" cues
  const refused = [];    // the refusals, which only ever come to the asker
  room.onMessage("onair", (m) => said.push(m));
  room.onMessage("onairDenied", (m) => refused.push(m));
  room.onMessage("chat", () => {});
  room.onMessage("roomchat", () => {});
  joined.push(room);
  return { name, room, said, refused };
};

let A;
try {
  A = await join("owner", owner.token);
} catch (e) {
  console.log(`  skip  the game server is not running on 2567 — start it with npm run dev  (${e.message})`);
  stop();
  process.exit(0);
}
const B = await join("admin", admin.token);
const C = await join("staff", staff.token);
await settle(800);

/** whether this window believes that session is on air */
const seesOnAir = (who, sid) => !!who.room.state.players.get(sid)?.onAir;
const clear = () => { for (const w of [A, B, C]) { w.said.length = 0; w.refused.length = 0; } };

// ---- who may -----------------------------------------------------------------

{
  clear();
  C.room.send("onair", { on: true });
  await settle(500);
  ok("a member asking to broadcast is refused", C.refused[0]?.reason === "not-allowed",
    JSON.stringify(C.refused[0] ?? null));
  ok("  · and nobody is put on air by it",
    !seesOnAir(A, C.room.sessionId) && !seesOnAir(C, C.room.sessionId),
    "the check lives on the server; this message needs no browser to send");
  ok("  · and nothing is announced to the room", A.said.length === 0 && B.said.length === 0);
}

{
  clear();
  B.room.send("onair", { on: true });
  await settle(600);
  ok("an admin takes the floor", seesOnAir(A, B.room.sessionId),
    "read from the owner's window, not the speaker's");
  ok("  · and every window is told, including the speaker's",
    A.said[0]?.on === true && B.said[0]?.on === true && C.said[0]?.on === true);
  ok("  · with the speaker's name on it", A.said[0]?.name === "admin", A.said[0]?.name);
  ok("  · and when it will end", typeof A.said[0]?.until === "number"
    && A.said[0].until - Date.now() > MAX_ON_AIR_MS - 5000,
    `${Math.round(((A.said[0]?.until ?? 0) - Date.now()) / 1000)}s left of ${MAX_ON_AIR_MS / 1000}`);
}

{
  clear();
  A.room.send("onair", { on: true });
  await settle(500);
  ok("the owner cannot talk over them", A.refused[0]?.reason === "someone-else",
    JSON.stringify(A.refused[0] ?? null));
  ok("  · and is told whose voice it is", A.refused[0]?.who === "admin", A.refused[0]?.who);
  ok("  · the floor does not change hands", !seesOnAir(A, A.room.sessionId) && seesOnAir(A, B.room.sessionId));
}

{
  clear();
  C.room.send("onair", { on: false });
  await settle(400);
  ok("somebody else cannot stop it either", seesOnAir(A, B.room.sessionId),
    "a member sending the off switch would be a way to cut off an announcement");
}

{
  clear();
  B.room.send("onair", { on: false });
  await settle(500);
  ok("the speaker gives it back", !seesOnAir(A, B.room.sessionId));
  ok("  · and the room is told why", A.said[0]?.on === false && A.said[0]?.why === "stopped");
}

{
  clear();
  A.room.send("onair", { on: true });
  await settle(500);
  ok("and now the owner can have it", seesOnAir(B, A.room.sessionId));
}

// ---- a closed tab is the likeliest ending ------------------------------------

{
  clear();
  const sid = A.room.sessionId;
  await A.room.leave();
  // and out of the teardown list with it: leaving a room twice never resolves,
  // which reads as the whole suite hanging after its last line has printed
  joined.splice(joined.indexOf(A.room), 1);
  await settle(800);
  ok("leaving the room ends the broadcast",
    !B.said.some((m) => m.on) && B.said.some((m) => !m.on && m.from === sid && m.why === "gone"),
    JSON.stringify(B.said));
  ok("  · and the floor is free again", (B.room.send("onair", { on: true }), await settle(500),
    seesOnAir(C, B.room.sessionId)));
}

for (const r of joined) { try { await r.leave(); } catch { /* going anyway */ } }
stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
