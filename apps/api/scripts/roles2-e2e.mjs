#!/usr/bin/env node
/**
 * What each role may see and do — the parts added after the original roles
 * suite: reading the guest list, and being shown the door.
 *
 * The line this draws is between seeing and doing. "Who is that visitor by the
 * pantry" is a fair question for anybody who works here, so a member may read
 * the guest list. A pass code is the thing that lets somebody in, so a member
 * never receives one — a code they can copy is a pass they can issue.
 *
 * Removing somebody ends a visit and nothing more. There is no list of the
 * banned, so this checks that they can come back, which is the behaviour rather
 * than a gap in the test.
 *
 *   npm run dev
 *   node apps/api/scripts/roles2-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { Client } from "colyseus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3995;
const API = `http://127.0.0.1:${PORT}`;
const GAME = "ws://localhost:2567";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, path, { body, token } = {}) => {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const get = (p, token) => call("GET", p, { token });
const post = (p, body, token) => call("POST", p, { body, token });

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

console.log("\nwhat each role may see and do\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await settle(500); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast -----------------------------------------------------------------------

const stamp = Date.now();
const person = async (who) => {
  const d = await post("/auth/register", { email: `r2-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });
  return { name: who, token: d.token, id: d.user?.id };
};

const owner = await person("owner");
const admin = await person("admin");
const member = await person("member");
const other = await person("other");
const outsider = await person("outsider");

const ws = (await post("/workspaces", { name: `r2-${stamp}` }, owner.token)).workspace;
for (const p of [admin, member, other]) await post("/workspaces/join", { code: ws.inviteCode }, p.token);
await call("PATCH", `/workspaces/${ws.slug}/members/${admin.id}`, { body: { role: "admin" }, token: owner.token });
const guestPass = (await post(`/workspaces/${ws.slug}/guests`, { name: "ผู้มาเยือน" }, owner.token)).guest;
// closed, so an account outside the space is genuinely outside it
await call("PATCH", `/workspaces/${ws.slug}`, { body: { allowGuests: false }, token: owner.token });

// ---- the guest list --------------------------------------------------------------

{
  const r = await get(`/workspaces/${ws.slug}/guests`, owner.token);
  ok("an owner sees the guest list", r.status === 200 && r.guests?.length === 1, `status ${r.status}`);
  ok("  · with the code, which is what lets somebody in", !!r.guests?.[0]?.code);
}
{
  const r = await get(`/workspaces/${ws.slug}/guests`, admin.token);
  ok("an admin sees it too, code and all", r.status === 200 && !!r.guests?.[0]?.code, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/guests`, member.token);
  ok("a member may now read it", r.status === 200 && r.guests?.length === 1, `status ${r.status}`);
  ok("  · seeing who is visiting", r.guests?.[0]?.name === "ผู้มาเยือน", JSON.stringify(r.guests?.[0]?.name));
  ok("  · and never the code", r.guests?.[0]?.code === undefined, JSON.stringify(r.guests?.[0]));
  ok("  · but still knowing whether the pass is live", r.guests?.[0]?.state === "active", r.guests?.[0]?.state);
}
{
  const r = await get(`/workspaces/${ws.slug}/guests`, outsider.token);
  ok("an account outside the space sees nothing", r.status === 403, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/guests`, { name: "ของฉัน" }, member.token);
  ok("a member cannot issue a pass", r.status === 403, `status ${r.status}`);
}
{
  const r = await call("PATCH", `/workspaces/${ws.slug}/guests/${guestPass.id}`,
    { body: { revoked: true }, token: member.token });
  ok("  · nor revoke one", r.status === 403, `status ${r.status}`);
  const after = await get(`/workspaces/${ws.slug}/guests`, owner.token);
  ok("  · and the pass is untouched", after.guests?.[0]?.state === "active", after.guests?.[0]?.state);
}

// ---- showing somebody the door ----------------------------------------------------

const open = [];
const join = async (who) => {
  const room = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token: who.token, name: who.name });
  const kicked = [];
  room.onMessage("kicked", (m) => kicked.push(m));
  room.onMessage("chat", () => {});
  room.onMessage("roomchat", () => {});
  open.push(room);
  return { ...who, room, kicked };
};

let oRoom, aRoom, mRoom, tRoom;
try {
  oRoom = await join(owner);
  aRoom = await join(admin);
  mRoom = await join(member);
  tRoom = await join(other);
} catch (e) {
  console.log(`  skip  the game server is not running on 2567 — start it with npm run dev  (${e.message})`);
  stop();
  process.exit(0);
}
await settle(900);

const here = () => oRoom.room.state.players.size;

{
  const before = here();
  mRoom.room.send("kick", { to: tRoom.room.sessionId });
  await settle(900);
  ok("a member cannot show anybody the door", here() === before && !tRoom.kicked.length,
    `${here()} still in the room`);
}
{
  aRoom.room.send("kick", { to: oRoom.room.sessionId });
  await settle(900);
  ok("an admin cannot remove the owner", !oRoom.kicked.length, JSON.stringify(oRoom.kicked));
}
{
  oRoom.room.send("kick", { to: oRoom.room.sessionId });
  await settle(700);
  ok("nobody can remove themselves by accident", !oRoom.kicked.length, JSON.stringify(oRoom.kicked));
}
{
  const before = here();
  aRoom.room.send("kick", { to: tRoom.room.sessionId });
  await settle(1400);
  ok("an admin can remove a member", tRoom.kicked.length === 1, JSON.stringify(tRoom.kicked));
  ok("  · saying who did it, so it is not mistaken for the network",
    tRoom.kicked[0]?.by === "admin", JSON.stringify(tRoom.kicked[0]));
  ok("  · and the room is one smaller", here() === before - 1, `${before} → ${here()}`);
}
{
  // Ending a visit is all it does. Somebody who still belongs here can walk
  // back in, which is the behaviour and not a hole in the test.
  const again = await join(other);
  await settle(900);
  ok("they can come back, because this ends a visit rather than a membership",
    [...oRoom.room.state.players.values()].some((p) => p.name === "other"),
    [...oRoom.room.state.players.values()].map((p) => p.name).join(","));
  await again.room.leave();
  await settle(900); // let that leave land before the next case counts heads
}
{
  const before = here();
  oRoom.room.send("kick", { to: aRoom.room.sessionId });
  await settle(1400);
  ok("the owner can remove an admin", aRoom.kicked.length === 1, JSON.stringify(aRoom.kicked));
  ok("  · and the room is one smaller again", here() === before - 1, `${before} → ${here()}`);
}

// Bounded, because a leave that never resolves takes the whole gate with it.
// Two of the sockets here have already been closed by the server — that is what
// the last few cases were about — and awaiting a goodbye from a connection that
// is gone is how this suite hung twice inside preflight while passing alone.
for (const r of open) {
  await Promise.race([
    r.leave().catch(() => {}),
    new Promise((done) => setTimeout(done, 1500)),
  ]);
}
stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
