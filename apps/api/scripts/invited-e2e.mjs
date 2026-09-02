#!/usr/bin/env node
/**
 * Invitations addressed to one person.
 *
 * The space's invite code is a door: anybody holding it walks through, and it
 * says nothing about who was expected. This is the other thing — one address,
 * single use, expiring — so most of what is worth checking is that it cannot
 * quietly become the first thing: forwarded and used by somebody else, spent
 * twice, or still good after it was taken back.
 *
 * No SMTP here, which is the point of one of the cases: the invitation still
 * exists and still carries a link.
 *
 *   node apps/api/scripts/invited-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3990;
const API = `http://127.0.0.1:${PORT}`;
const stamp = Date.now();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const call = async (method, p, body, token) => {
  const r = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const get = (p, t) => call("GET", p, undefined, t);
const post = (p, b, t) => call("POST", p, b, t);
const del = (p, t) => call("DELETE", p, undefined, t);

try {
  await fetch(`${API}/health`, { signal: AbortSignal.timeout(700) });
  console.error(`! something is already listening on ${PORT} — stop it first`);
  process.exit(1);
} catch { /* free */ }

const api = spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR,
  // INVITE_DAYS small enough to reason about, and no SMTP on purpose
  env: { ...process.env, PORT: String(PORT), INVITE_DAYS: "14", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
api.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[api] ${d}`));
const stop = () => { try { api.kill(); } catch { /* gone */ } };
process.on("exit", stop);

console.log("\ninvitations addressed to one person\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast -----------------------------------------------------------------------

const mail = (who) => `iv2-${who}-${stamp}@test.local`;
const reg = (who) => post("/auth/register", { email: mail(who), name: who, password: "hunter2pw" });

const owner = await reg("owner");
const admin = await reg("admin");
const mate = await reg("mate");
const wrongPerson = await reg("wrong");
const ws = (await post("/workspaces", { name: `iv2-${stamp}` }, owner.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, admin.token);
await post("/workspaces/join", { code: ws.inviteCode }, mate.token);
await call("PATCH", `/workspaces/${ws.slug}/members/${admin.user.id}`, { role: "admin" }, owner.token);

// the person being invited has an account but is not in the space
const guestOfHonour = await reg("newcomer");

// ---- asking somebody ------------------------------------------------------------

let invite;
{
  const r = await post(`/workspaces/${ws.slug}/invites`, { email: mail("newcomer") }, owner.token);
  invite = r.invite;
  ok("an owner can invite an address", r.status === 200 && invite?.state === "pending", `status ${r.status}`);
  ok("  · it is pending, not accepted", invite?.state === "pending", String(invite?.state));
  ok("  · as a member unless asked otherwise", invite?.role === "member", String(invite?.role));

  // No SMTP in this run. The invitation must survive that, and say so.
  ok("with no SMTP configured it still exists", !!invite?.id);
  ok("  · and admits the email did not go", invite?.emailed === false, String(invite?.emailed));
  ok("  · and hands over a link to pass on by hand",
    typeof invite?.link === "string" && invite.link.includes("invite="), String(invite?.link));
}
{
  const r = await get(`/workspaces/${ws.slug}/invites`, owner.token);
  ok("it shows up in the pending list", (r.invites ?? []).some((i) => i.email === mail("newcomer")),
    `${(r.invites ?? []).length} listed`);
}

// ---- who may ask ----------------------------------------------------------------

{
  const r = await post(`/workspaces/${ws.slug}/invites`, { email: `stranger-${stamp}@test.local` }, mate.token);
  ok("a plain member cannot invite anybody", r.status === 403, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/invites`, mate.token);
  ok("  · nor read who has been asked", r.status === 403, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/invites`, { email: `a2-${stamp}@test.local`, role: "admin" }, admin.token);
  ok("an admin cannot invite another admin", r.status === 403, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/invites`, { email: `a3-${stamp}@test.local`, role: "admin" }, owner.token);
  ok("  · but the owner can", r.status === 200 && r.invite?.role === "admin", `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/invites`, { email: mail("mate") }, owner.token);
  ok("inviting somebody already here is refused, and says why", r.status === 409, `status ${r.status}`);
}
{
  for (const bad of ["", "not-an-email", "no@domain", "@nope.com"]) {
    const r = await post(`/workspaces/${ws.slug}/invites`, { email: bad }, owner.token);
    ok(`  · "${bad}" is not an address`, r.status === 400, `status ${r.status}`);
  }
}

// ---- reading it before signing in -----------------------------------------------

{
  const r = await get(`/invites/${invite.link.split("invite=")[1]}`);
  ok("the link can be read without signing in", r.status === 200, `status ${r.status}`);
  ok("  · naming the space and who asked",
    r.invite?.space === ws.name && r.invite?.invitedBy === "owner",
    `${r.invite?.space} / ${r.invite?.invitedBy}`);
  ok("  · and it does not hand back the token again", r.invite?.token === undefined);
}
{
  const r = await get(`/invites/made-up-token-${stamp}`);
  ok("a made-up token reads as nothing", r.status === 404, `status ${r.status}`);
}

// ---- spending it -----------------------------------------------------------------

const token = invite.link.split("invite=")[1];
{
  const r = await post(`/invites/${token}/accept`, {}, wrongPerson.token);
  ok("somebody the invitation was not sent to cannot spend it", r.status === 403, `status ${r.status}`);
  const after = await get(`/workspaces/${ws.slug}/invites`, owner.token);
  const still = (after.invites ?? []).find((i) => i.email === mail("newcomer"));
  ok("  · and it is still pending afterwards", still?.state === "pending", String(still?.state));
}
{
  const before = (await get(`/workspaces/${ws.slug}/members`, owner.token)).members.length;
  const r = await post(`/invites/${token}/accept`, {}, guestOfHonour.token);
  ok("the person it was addressed to can", r.status === 200, `status ${r.status}`);
  const after = (await get(`/workspaces/${ws.slug}/members`, owner.token)).members.length;
  ok("  · and the space is one bigger", after === before + 1, `${before} -> ${after}`);

  const them = (await get(`/workspaces/${ws.slug}/members`, owner.token)).members
    .find((m) => m.name === "newcomer");
  ok("  · with the role the invitation named", them?.role === "member", String(them?.role));
}
{
  const r = await post(`/invites/${token}/accept`, {}, guestOfHonour.token);
  ok("it cannot be spent twice", r.status === 410, `status ${r.status}`);
  const list = await get(`/workspaces/${ws.slug}/invites`, owner.token);
  const row = (list.invites ?? []).find((i) => i.email === mail("newcomer"));
  ok("  · and reads as accepted, not pending", row?.state === "accepted", String(row?.state));
  ok("  · a spent invitation stops carrying its link", row?.link === undefined, JSON.stringify(row?.link));
}

// ---- taking it back ---------------------------------------------------------------

{
  const asked = (await post(`/workspaces/${ws.slug}/invites`, { email: `late-${stamp}@test.local` }, owner.token)).invite;
  const tok = asked.link.split("invite=")[1];
  const r = await del(`/workspaces/${ws.slug}/invites/${asked.id}`, owner.token);
  ok("an invitation can be taken back", r.status === 200 && r.invite?.state === "revoked", String(r.invite?.state));

  const later = await reg("late");
  const spend = await post(`/invites/${tok}/accept`, {}, later.token);
  ok("  · and then it opens nothing", spend.status === 410, `status ${spend.status}`);
  ok("  · which is what a revoked link has to do", spend.error === "revoked", String(spend.error));
}
{
  const asked = (await post(`/workspaces/${ws.slug}/invites`, { email: `mine-${stamp}@test.local` }, owner.token)).invite;
  const r = await del(`/workspaces/${ws.slug}/invites/${asked.id}`, mate.token);
  ok("a plain member cannot take one back", r.status === 403, `status ${r.status}`);
}

// ---- asking twice ------------------------------------------------------------------

{
  const first = (await post(`/workspaces/${ws.slug}/invites`, { email: `twice-${stamp}@test.local` }, owner.token)).invite;
  const again = (await post(`/workspaces/${ws.slug}/invites`, { email: `twice-${stamp}@test.local` }, owner.token)).invite;
  ok("asking the same address again replaces the invitation", first.id === again.id, `${first.id} / ${again.id}`);
  ok("  · with a new link, so the old one stops working", first.link !== again.link);

  const list = await get(`/workspaces/${ws.slug}/invites`, owner.token);
  const rows = (list.invites ?? []).filter((i) => i.email === `twice-${stamp}@test.local`);
  ok("  · and there is still only one row for them", rows.length === 1, String(rows.length));

  const oldTok = first.link.split("invite=")[1];
  const dead = await get(`/invites/${oldTok}`);
  ok("  · the superseded link is gone entirely", dead.status === 404, `status ${dead.status}`);
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
