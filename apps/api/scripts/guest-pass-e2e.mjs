// Guest passes end to end: who may issue them, what each pass state does to the
// door, and that a pass is scoped to the one space that issued it.
//
// The interesting rule is that a live pass gets its holder in while the space is
// closed to guests, and that revoking/expiring one drops them back to whatever
// the space's own setting says — nothing more.
//
//   npm run dev            # api + game server
//   node apps/api/scripts/guest-pass-e2e.mjs

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
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

const stamp = Date.now();
const mk = async (who) => {
  const email = `gp-${who}-${stamp}@test.local`;
  const d = await call("POST", "/auth/register", { body: { email, name: who, password: "hunter2pw" } });
  return { who, token: d.token, id: d.user.id };
};

/** the room is the real gate — the API's answer only matters if the socket agrees */
const canEnter = async (slug, { token, guest } = {}) => {
  try {
    const room = await new Client(GAME).joinOrCreate("office", {
      workspace: slug, token: token ?? "", guest: guest ?? "", name: "probe", avatar: "1",
    });
    // the join resolving IS the answer; state arrives a beat later and reading it
    // here only invents a race
    await room.leave();
    return { in: true };
  } catch (e) {
    return { in: false, why: String(e?.message || e) };
  }
};

const owner = await mk("owner");
const admin = await mk("admin");
const plain = await mk("member");

const w = await call("POST", "/workspaces", {
  token: owner.token, body: { name: `Guests ${stamp}`, allowGuests: false },
});
const slug = w.workspace.slug;
for (const u of [admin, plain]) {
  await call("POST", "/workspaces/join", { token: u.token, body: { code: w.workspace.inviteCode } });
}
await call("PATCH", `/workspaces/${slug}/members/${admin.id}`, { token: owner.token, body: { role: "admin" } });

// a second space, to prove a pass does not travel
const other = await call("POST", "/workspaces", { token: owner.token, body: { name: `Other ${stamp}` } });

// ---- who may manage passes ----
const listedByMember = await call("GET", `/workspaces/${slug}/guests`, { token: plain.token });
ok("a plain member cannot see the guest list", listedByMember.status === 403, `status=${listedByMember.status}`);

const madeByMember = await call("POST", `/workspaces/${slug}/guests`, { token: plain.token, body: { name: "X" } });
ok("a plain member cannot issue a pass", madeByMember.status === 403, `status=${madeByMember.status}`);

const byAdmin = await call("POST", `/workspaces/${slug}/guests`, { token: admin.token, body: { name: "จากแอดมิน", days: 7 } });
ok("an admin may issue a pass", byAdmin.status === 200 && byAdmin.guest?.state === "active",
  `status=${byAdmin.status} state=${byAdmin.guest?.state}`);

const noName = await call("POST", `/workspaces/${slug}/guests`, { token: owner.token, body: { name: "  " } });
ok("a pass needs a name", noName.status === 400, `status=${noName.status}`);

const silly = await call("POST", `/workspaces/${slug}/guests`, { token: owner.token, body: { name: "Y", days: 36500 } });
ok("an arbitrary pass length is refused", silly.status === 400, `status=${silly.status}`);

// ---- the door ----
const closed = await canEnter(slug);
ok("with allowGuests off, a visitor with no pass is refused", closed.in === false, closed.why ?? "");

const visitor = await call("POST", `/workspaces/${slug}/guests`, {
  token: owner.token, body: { name: "คุณสมชาย (ลูกค้า)", days: 7 },
});
const code = visitor.guest.code;
ok("the pass code is a full-entropy hex string", /^[0-9a-f]{32}$/.test(code || ""), `code=${code?.slice(0, 8)}…`);

const withPass = await canEnter(slug, { guest: code });
ok("a live pass gets its holder into a space closed to guests", withPass.in === true, withPass.why ?? "");

const wrongSpace = await canEnter(other.workspace.slug, { guest: code });
// the other space allows guests, so entry proves nothing — the pass must not be
// what let them in. Check the API's own answer instead.
const otherAccess = await call("GET", `/workspaces/${other.workspace.slug}/access?guest=${code}`);
ok("a pass is not honoured by another space",
  otherAccess.reason !== "guest-pass", `reason=${otherAccess.reason} joined=${wrongSpace.in}`);

// a pass is a guest pass, so the guest rules must follow it into the room —
// otherwise it would be a way to get a desk without being on the team
const seat = await (async () => {
  const room = await new Client(GAME).joinOrCreate("office", {
    workspace: slug, guest: code, name: "probe", avatar: "1",
  });
  const denied = new Promise((r) => { room.onMessage("deskDenied", () => r(true)); setTimeout(() => r(false), 1200); });
  room.send("claimDesk", "desk-1");
  const wasDenied = await denied;
  await new Promise((r) => setTimeout(r, 200));
  const mine = room.state.players.get(room.sessionId)?.desk ?? "";
  await room.leave();
  return { wasDenied, mine };
})();
ok("a pass holder is still refused a desk", seat.wasDenied === true && seat.mine === "",
  `denied=${seat.wasDenied} desk="${seat.mine}"`);

// ---- the visit is recorded ----
const afterVisit = await call("GET", `/workspaces/${slug}/guests`, { token: owner.token });
const row = afterVisit.guests.find((g) => g.id === visitor.guest.id);
ok("using a pass records the visit", row?.visits === 1 && !!row?.lastSeenAt,
  `visits=${row?.visits} lastSeenAt=${row?.lastSeenAt ? "set" : "null"}`);

// ---- the holder may read their own pass, and only that ----
const lookup = await call("GET", `/guest-pass/${code}`);
ok("the holder can read the name on their pass",
  lookup.name === "คุณสมชาย (ลูกค้า)" && lookup.state === "active" && lookup.workspace?.slug === slug,
  `name=${lookup.name} state=${lookup.state}`);
ok("the pass lookup leaks no invite code", lookup.inviteCode === undefined && lookup.code === undefined);

// ---- revoke ----
await call("PATCH", `/workspaces/${slug}/guests/${visitor.guest.id}`, { token: owner.token, body: { revoked: true } });
const revoked = await canEnter(slug, { guest: code });
ok("a revoked pass no longer opens the door", revoked.in === false, revoked.why ?? "");

const revokedState = (await call("GET", `/workspaces/${slug}/guests`, { token: owner.token }))
  .guests.find((g) => g.id === visitor.guest.id);
ok("a revoked pass is listed as revoked", revokedState?.state === "revoked", `state=${revokedState?.state}`);

// ---- restore ----
await call("PATCH", `/workspaces/${slug}/guests/${visitor.guest.id}`, { token: owner.token, body: { revoked: false } });
const restored = await canEnter(slug, { guest: code });
ok("restoring a pass opens the door again", restored.in === true, restored.why ?? "");

// ---- expiry ----
// an expiry in the past is what the "หมดอายุแล้ว" tab lists; set it directly,
// since the API only mints the offered lengths
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
await prisma.guestPass.update({
  where: { id: visitor.guest.id }, data: { expiresAt: new Date(Date.now() - 60_000) },
});
const expiredState = (await call("GET", `/workspaces/${slug}/guests`, { token: owner.token }))
  .guests.find((g) => g.id === visitor.guest.id);
ok("a pass past its date reads as expired", expiredState?.state === "expired", `state=${expiredState?.state}`);

const expired = await canEnter(slug, { guest: code });
ok("an expired pass does not open the door", expired.in === false, expired.why ?? "");

await call("PATCH", `/workspaces/${slug}/guests/${visitor.guest.id}`, { token: owner.token, body: { days: 7 } });
const renewed = await canEnter(slug, { guest: code });
ok("extending an expired pass brings it back", renewed.in === true, renewed.why ?? "");

// ---- archive ----
await call("PATCH", `/workspaces/${slug}/guests/${visitor.guest.id}`, { token: owner.token, body: { archived: true } });
const archivedState = (await call("GET", `/workspaces/${slug}/guests`, { token: owner.token }))
  .guests.find((g) => g.id === visitor.guest.id);
ok("archiving outranks the other states in the list", archivedState?.state === "archived",
  `state=${archivedState?.state}`);
const archived = await canEnter(slug, { guest: code });
ok("an archived pass does not open the door", archived.in === false, archived.why ?? "");

// ---- an open space keeps working ----
await call("PATCH", `/workspaces/${slug}`, { token: owner.token, body: { allowGuests: true } });
const openDoor = await canEnter(slug);
ok("turning guests back on admits a visitor with no pass", openDoor.in === true, openDoor.why ?? "");

// a garbage code must not become a way in that bypasses the check
const closedAgain = await call("PATCH", `/workspaces/${slug}`, { token: owner.token, body: { allowGuests: false } });
ok("the space is closed again for the last check", closedAgain.workspace?.allowGuests === false);
const junk = await canEnter(slug, { guest: "not-a-real-code" });
ok("an unknown pass code is simply ignored", junk.in === false, junk.why ?? "");

await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
