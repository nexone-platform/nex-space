// End-to-end test of workspace roles and the per-member permission menu.
//
//   npm run dev -w apps/api      # in one terminal
//   npm run test:roles -w apps/api
//
// Builds one workspace with an owner, an admin, a second admin, a member and a
// guest, then checks every cell of the "who may act on whom" table — including
// the ones that must be refused.

const API = "http://localhost:3001";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

async function call(method, path, { body, token } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j ?? {} };
}

const stamp = Date.now();
const mkUser = async (who) => {
  const email = `role-${who}-${stamp}@test.local`;
  const r = await call("POST", "/auth/register", { body: { email, name: who, password: "hunter2pw" } });
  return { who, email, token: r.body.token, id: r.body.user.id };
};

const [owner, admin, admin2, member, guest] =
  await Promise.all(["owner", "admin", "admin2", "member", "guest"].map(mkUser));

// ---- build the workspace ----
const created = await call("POST", "/workspaces", { token: owner.token, body: { name: `Roles ${stamp}` } });
const slug = created.body.workspace.slug;
const invite = created.body.workspace.inviteCode;
ok("owner creates a workspace", created.status === 200 && !!slug, slug);

for (const u of [admin, admin2, member, guest]) {
  await call("POST", "/workspaces/join", { token: u.token, body: { code: invite } });
}
const setRole = (actor, target, role) =>
  call("PATCH", `/workspaces/${slug}/members/${target.id}`, { token: actor.token, body: { role } });
const kick = (actor, target) =>
  call("DELETE", `/workspaces/${slug}/members/${target.id}`, { token: actor.token });
const roster = async (u) => (await call("GET", `/workspaces/${slug}/members`, { token: u.token })).body;

ok("everyone joins as a plain member", (await roster(owner)).members.length === 5);

// ---- owner may set every rank ----
ok("owner promotes to admin", (await setRole(owner, admin, "admin")).status === 200);
ok("owner promotes a second admin", (await setRole(owner, admin2, "admin")).status === 200);
ok("owner demotes to guest", (await setRole(owner, guest, "guest")).status === 200);
ok("owner cannot change their own role", (await setRole(owner, owner, "admin")).status === 400);

const seen = (await roster(owner)).members;
const roleOf = (u, list = seen) => list.find((m) => m.id === u.id)?.role;
ok("roles stuck", roleOf(admin) === "admin" && roleOf(guest) === "guest" && roleOf(member) === "member",
  seen.map((m) => `${m.name}:${m.role}`).join(" "));

// ---- admin: manages below, blocked at its own rank and above ----
ok("admin demotes a member to guest", (await setRole(admin, member, "guest")).status === 200);
ok("admin restores a guest to member", (await setRole(admin, member, "member")).status === 200);
ok("admin CANNOT create another admin", (await setRole(admin, member, "admin")).status === 403);
ok("admin CANNOT demote a fellow admin", (await setRole(admin, admin2, "member")).status === 403);
ok("admin CANNOT touch the owner", [400, 403].includes((await setRole(admin, owner, "member")).status));
ok("admin CANNOT remove a fellow admin", (await kick(admin, admin2)).status === 403);
ok("admin CANNOT remove the owner", (await kick(admin, owner)).status === 400);

// ---- member and guest manage nobody ----
ok("member CANNOT change anyone", (await setRole(member, guest, "member")).status === 403);
ok("guest CANNOT change anyone", (await setRole(guest, member, "guest")).status === 403);
ok("member CANNOT remove anyone", (await kick(member, guest)).status === 403);

// ---- the roster tells the client exactly which menu entries to draw ----
const asOwner = (await roster(owner)).members;
const asAdmin = (await roster(admin)).members;
const asMember = (await roster(member)).members;
const flags = (list, u) => list.find((m) => m.id === u.id);
ok("owner is offered promote+manage on an admin",
  flags(asOwner, admin).canPromote === true && flags(asOwner, admin).canManage === true);
ok("nobody is offered actions on the owner row",
  flags(asOwner, owner).canManage === false && flags(asAdmin, owner).canPromote !== true);
ok("admin gets manage but never promote",
  flags(asAdmin, member).canManage === true && flags(asAdmin, member).canPromote !== true);
ok("admin gets nothing on a fellow admin", flags(asAdmin, admin2).canManage === false);
ok("member gets no actions at all",
  asMember.every((m) => m.canManage === false && m.canPromote !== true));
ok("roster reports last-active and join time",
  !!flags(asOwner, owner).lastSeenAt && !!flags(asOwner, owner).joinedAt);

// ---- guest restrictions are real, not just hidden buttons ----
const guestDesk = await call("PUT", "/me/desk", { token: guest.token, body: { workspace: slug, desk: "d-1" } });
ok("a guest cannot claim a desk", guestDesk.status === 403, JSON.stringify(guestDesk.body));
const memberDesk = await call("PUT", "/me/desk", { token: member.token, body: { workspace: slug, desk: "d-1" } });
ok("a member still can", memberDesk.status === 200);

// a demoted member keeps the desk row but must be able to give it up
await setRole(owner, member, "guest");
ok("a demoted member may still release their desk",
  (await call("PUT", "/me/desk", { token: member.token, body: { workspace: slug, desk: "" } })).status === 200);
ok("...but cannot take it again",
  (await call("PUT", "/me/desk", { token: member.token, body: { workspace: slug, desk: "d-1" } })).status === 403);
await setRole(owner, member, "member");

const guestList = await call("GET", "/workspaces", { token: guest.token });
ok("a guest is not handed the invite code",
  guestList.body.workspaces.find((w) => w.slug === slug)?.inviteCode === undefined);
const memberList = await call("GET", "/workspaces", { token: member.token });
ok("a member still sees it", !!memberList.body.workspaces.find((w) => w.slug === slug)?.inviteCode);

// the single-workspace lookup is the one the settings dialog calls, and it is
// reachable without a token at all — every caller has to fail closed
ok("the single lookup withholds the code from a guest",
  (await call("GET", `/workspaces/${slug}`, { token: guest.token })).body.workspace.inviteCode === undefined);
ok("...and from an anonymous visitor who guessed the slug",
  (await call("GET", `/workspaces/${slug}`)).body.workspace.inviteCode === undefined);
ok("...but still gives it to a member",
  !!(await call("GET", `/workspaces/${slug}`, { token: member.token })).body.workspace.inviteCode);
ok("the public lookup still returns the name for the invite screen",
  (await call("GET", `/workspaces/${slug}`)).body.workspace.name === `Roles ${stamp}`);

// ---- map theme: one per workspace, managers only ----
ok("a new workspace starts on the classic layout",
  (await call("GET", `/workspaces/${slug}`, { token: owner.token })).body.workspace.theme === "classic");
ok("owner switches the layout",
  (await call("PATCH", `/workspaces/${slug}`, { token: owner.token, body: { theme: "office" } })).status === 200);
ok("everyone is told the new layout",
  (await call("GET", `/workspaces/${slug}`, { token: member.token })).body.workspace.theme === "office");
ok("a junk theme is refused rather than shipped to every client",
  (await call("PATCH", `/workspaces/${slug}`, { token: owner.token, body: { theme: "../etc/passwd" } })).status === 400);
ok("the refused write left the layout alone",
  (await call("GET", `/workspaces/${slug}`, { token: owner.token })).body.workspace.theme === "office");
ok("an admin may switch it too",
  (await call("PATCH", `/workspaces/${slug}`, { token: admin.token, body: { theme: "classic" } })).status === 200);
ok("a plain member may not",
  (await call("PATCH", `/workspaces/${slug}`, { token: member.token, body: { theme: "office" } })).status === 403);
ok("renaming without naming a theme keeps the current one",
  (await call("PATCH", `/workspaces/${slug}`, { token: owner.token, body: { name: `Roles ${stamp}` } }))
    .body.workspace.theme === "classic");
ok("the workspace list carries the theme so a card can preload it",
  (await call("GET", "/workspaces", { token: member.token }))
    .body.workspaces.find((w) => w.slug === slug)?.theme === "classic");

// ---- the game server reads the role from the access check ----
const access = await call("GET", `/workspaces/${slug}/access?token=${guest.token}`);
ok("access check reports the role to the game server",
  access.body.allowed === true && access.body.role === "guest", JSON.stringify(access.body));

// ---- leaving still works for everyone ----
ok("a guest may remove themselves", (await kick(guest, guest)).status === 200);
ok("an admin may remove a plain member", (await kick(admin, member)).status === 200);
ok("the owner cannot be removed at all", (await kick(owner, owner)).status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
