// Checks the realtime half of the guest restriction: the API can refuse a desk
// all it likes, but the authority for what other players see is the Colyseus
// room. This joins the real room over a socket as a guest and as a member.
//
//   npm run dev            # api + game server
//   node apps/api/scripts/desk-guard-e2e.mjs

import { Client } from "colyseus.js";

const API = "http://localhost:3001";
const GAME = "ws://localhost:2567";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const call = async (m, p, { body, token } = {}) => {
  const r = await fetch(API + p, {
    method: m,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
};

const stamp = Date.now();
const mk = async (who) => {
  const email = `desk-${who}-${stamp}@test.local`;
  const d = await call("POST", "/auth/register", { body: { email, name: who, password: "hunter2pw" } });
  return { who, token: d.token, id: d.user.id };
};

const owner = await mk("owner");
const guest = await mk("guest");
const member = await mk("member");
const w = await call("POST", "/workspaces", { token: owner.token, body: { name: `Desk ${stamp}` } });
const slug = w.workspace.slug;
for (const u of [guest, member]) {
  await call("POST", "/workspaces/join", { token: u.token, body: { code: w.workspace.inviteCode } });
}
await call("PATCH", `/workspaces/${slug}/members/${guest.id}`, { token: owner.token, body: { role: "guest" } });

/** join the room, try to take a desk, report what the server let happen */
async function tryDesk(user, deskId) {
  const room = await new Client(GAME).joinOrCreate("office", {
    workspace: slug, token: user.token, name: user.who, avatar: "1",
  });
  const denied = new Promise((r) => { room.onMessage("deskDenied", () => r(true)); setTimeout(() => r(false), 1200); });
  room.send("claimDesk", deskId);
  const wasDenied = await denied;
  await new Promise((r) => setTimeout(r, 200));
  const mine = room.state.players.get(room.sessionId)?.desk ?? "";
  await room.leave();
  return { wasDenied, mine };
}

const g = await tryDesk(guest, "desk-1");
ok("the room refuses a guest's desk claim", g.wasDenied === true && g.mine === "",
  `denied=${g.wasDenied} desk="${g.mine}"`);

const m = await tryDesk(member, "desk-1");
ok("a member still gets the desk", m.wasDenied === false && m.mine === "desk-1",
  `denied=${m.wasDenied} desk="${m.mine}"`);

// the public space must keep working for everyone, signed in or not
const anon = await new Client(GAME).joinOrCreate("office", { workspace: "main", name: "anon", avatar: "1" });
anon.send("claimDesk", "desk-9");
await new Promise((r) => setTimeout(r, 400));
ok("the public workspace still admits an anonymous player and lets them sit",
  anon.state.players.get(anon.sessionId)?.desk === "desk-9");
await anon.leave();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
