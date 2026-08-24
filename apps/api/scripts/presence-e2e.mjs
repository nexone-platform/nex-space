#!/usr/bin/env node
/**
 * The rules the room enforces about interrupting somebody.
 *
 * These live in the game server rather than the API, so they are tested through
 * a real socket: two people join, and one of them tries to call the other over.
 * What is being checked is that the server refuses on the callee's behalf —
 * "do not disturb" that only silences your own machine is a setting, not a rule,
 * and the person calling would never learn their request went nowhere.
 *
 *   npm run dev                        # api + game server
 *   node apps/api/scripts/presence-e2e.mjs
 */
import { Client } from "colyseus.js";

const API = "http://localhost:3001";
const GAME = "ws://localhost:2567";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const post = async (path, body, token) => {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

/** wait for one message, or give up */
const awaited = (room, type, ms = 2500) =>
  new Promise((res) => {
    const timer = setTimeout(() => res(null), ms);
    room.onMessage(type, (m) => { clearTimeout(timer); res(m); });
  });

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

console.log("\npresence and interruptions\n");

try {
  if (!(await fetch(API + "/health")).ok) throw new Error("not ok");
} catch {
  console.error("! no API on 3001 — start it with npm run dev");
  process.exit(1);
}

const stamp = Date.now();
const person = async (who) => {
  const d = await post("/auth/register", { email: `pr-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });
  return { name: who, token: d.token, id: d.user?.id };
};

const alice = await person("alice");
const bob = await person("bob");
const ws = (await post("/workspaces", { name: `pr-${stamp}` }, alice.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, bob.token);

let aliceRoom, bobRoom;
try {
  aliceRoom = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token: alice.token, name: "alice" });
  bobRoom = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token: bob.token, name: "bob" });
} catch (e) {
  console.error(`! could not join the room on 2567 (${e.message}) — is the game server running?`);
  process.exit(1);
}
// we cause pingSent by asking; ignoring it quietly keeps the output readable
aliceRoom.onMessage("pingSent", () => {});
bobRoom.onMessage("pingSent", () => {});
await settle();

const sessionOf = (room, name) => {
  for (const [id, p] of room.state.players) if (p.name === name) return id;
  return "";
};
const bobId = sessionOf(aliceRoom, "bob");
const aliceId = sessionOf(bobRoom, "alice");
ok("both are in the room", !!bobId && !!aliceId, `${aliceId} / ${bobId}`);

// ---- an ordinary call over --------------------------------------------------

{
  const arriving = awaited(bobRoom, "ping");
  aliceRoom.send("ping", { to: bobId });
  const got = await arriving;
  ok("a call over reaches the other person", !!got, got ? "" : "nothing arrived");
  ok("  · carrying where to go", typeof got?.x === "number" && typeof got?.y === "number", JSON.stringify([got?.x, got?.y]));
  ok("  · and who is asking", got?.name === "alice", got?.name);
}

// ---- the throttle -----------------------------------------------------------

{
  const second = awaited(bobRoom, "ping", 1500);
  aliceRoom.send("ping", { to: bobId });
  ok("asking again straight away is dropped", (await second) === null);
}

// ---- do not disturb ---------------------------------------------------------

{
  bobRoom.send("status", "busy");
  await settle();
  const asSeenByAlice = aliceRoom.state.players.get(bobId)?.status;
  ok("the room accepts a chosen status", asSeenByAlice === "busy", String(asSeenByAlice));

  // a different pair, so the throttle above is not what refuses this one
  const refused = awaited(aliceRoom, "pingRefused");
  const delivered = awaited(bobRoom, "ping", 1500);
  bobRoom.send("status", "busy");
  await settle(300);
  aliceRoom.send("ping", { to: bobId });          // throttled pair, so use the other direction too
  bobRoom.send("ping", { to: aliceId });

  // alice is not busy, so bob calling her must still work
  const toAlice = await awaited(aliceRoom, "ping", 1500);
  ok("someone who is not busy still gets called", !!toAlice, toAlice ? "" : "nothing arrived");

  ok("a call to someone on do not disturb is not delivered", (await delivered) === null);
  void refused;
}

// ---- and the caller is told why ---------------------------------------------

{
  // a fresh pair to dodge the throttle: alice leaves and comes back
  await aliceRoom.leave();
  const alice2 = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token: alice.token, name: "alice" });
  alice2.onMessage("pingSent", () => {});
  await settle();
  const bobId2 = sessionOf(alice2, "bob");

  const refused = awaited(alice2, "pingRefused");
  alice2.send("ping", { to: bobId2 });
  const r = await refused;
  ok("the caller is told, rather than left wondering", !!r, r ? "" : "no refusal came back");
  ok("  · naming who is busy", r?.name === "bob", r?.name);

  bobRoom.send("status", "online");
  await settle();
  ok("and it can be turned off again", alice2.state.players.get(bobId2)?.status === "online",
    String(alice2.state.players.get(bobId2)?.status));

  await alice2.leave();
}

// ---- waving ------------------------------------------------------------------
// A wave asks for nothing, so unlike a call to come over it goes through even to
// somebody who has asked not to be interrupted. That difference is the whole
// point of having both, so it is what this section checks.

{
  const alice3 = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token: alice.token, name: "alice" });
  alice3.onMessage("pingSent", () => {});
  await settle();
  const bobId3 = sessionOf(alice3, "bob");

  bobRoom.send("status", "busy");
  await settle();

  const arriving = awaited(bobRoom, "wave");
  const confirmed = awaited(alice3, "waveSent");
  const bubble = awaited(alice3, "chat");
  alice3.send("wave", { to: bobId3 });

  const got = await arriving;
  ok("a wave reaches the other person", !!got, got ? "" : "nothing arrived");
  ok("  · naming who waved", got?.name === "alice", got?.name);
  ok("  · even though they are on do not disturb",
    !!got && bobRoom.state.players.get(sessionOf(bobRoom, "bob"))?.status === "busy");

  const back = await confirmed;
  ok("the waver is told it went", back?.name === "bob", back?.name);

  const seen = await bubble;
  ok("and it shows over their own head, the way a reaction does", seen?.text === "👋", seen?.text);

  bobRoom.onMessage("chat", () => {});   // the bubble reaches them too; not this test's business
  const second = awaited(bobRoom, "wave", 1200);
  alice3.send("wave", { to: bobId3 });
  ok("waving again straight away is dropped", (await second) === null);

  bobRoom.send("status", "online");
  await alice3.leave();
}

await bobRoom.leave();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
