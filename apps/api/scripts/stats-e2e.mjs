#!/usr/bin/env node
/**
 * Attendance, and the dashboard built on it.
 *
 * Two things matter here and they pull in opposite directions. The numbers have
 * to be right — a report somebody staffs an office from must not invent hours —
 * and the record has to be private, because "who was where and for how long" is
 * a different thing from "who is online". So: only owners and admins may read
 * it, and a visit that never closed contributes arrivals and no time at all.
 *
 * Rows are written straight to the database with dates in the past rather than
 * by waiting around: a test that measured real elapsed time could only ever
 * check that a few seconds is a few seconds.
 *
 *   npm run dev
 *   node apps/api/scripts/stats-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3991;
const API = `http://127.0.0.1:${PORT}`;
const HOUR = 3600_000, DAY = 24 * HOUR;

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

console.log("\nattendance and the dashboard\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await settle(500); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast ---------------------------------------------------------------------

const stamp = Date.now();
const person = async (who) => {
  const d = await post("/auth/register", { email: `stat-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });
  return { name: who, token: d.token, id: d.user?.id };
};

const owner = await person("owner");
const admin = await person("admin");
const member = await person("member");
const outsider = await person("outsider");

const ws = (await post("/workspaces", { name: `stat-${stamp}` }, owner.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, admin.token);
await post("/workspaces/join", { code: ws.inviteCode }, member.token);
await call("PATCH", `/workspaces/${ws.slug}/members/${admin.id}`, { body: { role: "admin" }, token: owner.token });
const guest = (await post(`/workspaces/${ws.slug}/guests`, { name: "ผู้มาเยือน" }, owner.token)).guest;
// Closed, so "a member" and "anybody holding an account" are different things.
// Left open, an outsider is admitted as a guest and counting them would be right.
await call("PATCH", `/workspaces/${ws.slug}`, { body: { allowGuests: false }, token: owner.token });

// ---- the door -------------------------------------------------------------------

{
  const r = await get(`/workspaces/${ws.slug}/stats`);
  ok("the dashboard is closed to a stranger with no token", r.status === 401, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/stats`, outsider.token);
  ok("  · and to an account outside the space", r.status === 403, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/stats`, member.token);
  ok("  · and to a plain member — this is who was where, not who is online",
    r.status === 403, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/stats`, admin.token);
  ok("an admin may read it", r.status === 200, `status ${r.status}`);
}

// ---- writing a visit -------------------------------------------------------------

{
  const r = await post(`/workspaces/${ws.slug}/visits`, {});
  ok("a visit cannot be logged without a credential", r.status === 401, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/visits`, {}, outsider.token);
  ok("  · nor by an account with no way into the space", r.status === 401, `status ${r.status}`);
}
let visitId;
{
  const r = await post(`/workspaces/${ws.slug}/visits`, {}, member.token);
  visitId = r.id;
  ok("a member's arrival is logged", r.status === 200 && !!r.id, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/visits?guest=${guest.code}`, {});
  ok("  · and a pass holder's", r.status === 200 && !!r.id, `status ${r.status}`);
}
{
  const r = await call("PATCH", `/workspaces/${ws.slug}/visits/${visitId}`, {
    body: { areas: { "main/meeting": 600 } }, token: member.token,
  });
  ok("the visit can be closed", r.status === 200, `status ${r.status}`);
  const again = await call("PATCH", `/workspaces/${ws.slug}/visits/${visitId}`, { body: {}, token: member.token });
  ok("  · and closing it twice does not move the clock", again.status === 200 && again.already === true);
}
{
  const r = await call("PATCH", `/workspaces/${ws.slug}/visits/nope-${stamp}`, { body: {}, token: member.token });
  ok("closing a visit that does not exist is a 404", r.status === 404, `status ${r.status}`);
}

// ---- the numbers -----------------------------------------------------------------
//
// Written directly, with dates chosen so every figure below is one somebody
// could work out on paper.

const prisma = new PrismaClient();
const w = await prisma.workspace.findUnique({ where: { slug: ws.slug } });
await prisma.visit.deleteMany({ where: { workspaceId: w.id } }); // start from a clean slate

const at = (daysAgo, hour, minute = 0) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const visit = (userId, name, joined, left, areas) => prisma.visit.create({
  data: { workspaceId: w.id, userId, name, guest: !userId, joinedAt: joined, leftAt: left,
          ...(areas ? { areas: JSON.stringify(areas) } : {}) },
});

// two hours yesterday, in one sitting, all of it in the meeting room
await visit(owner.id, "owner", at(1, 9), at(1, 11), { "main/meeting": 7200 });
// half an hour yesterday, on the open floor
await visit(member.id, "member", at(1, 14), at(1, 14, 30), { "main/": 1800 });
// an hour the day before, split between a room and the floor
await visit(owner.id, "owner", at(2, 10), at(2, 11), { "main/meeting": 1800, "main/": 1800 });
// a guest, one hour yesterday
await visit(null, "ผู้มาเยือน", at(1, 16), at(1, 17), { "main/": 3600 });
// Somebody still in the room, and started well in the past on purpose: an
// open visit whose start is in the future contributes nothing whatever the
// rule is, which would make the assertion below pass by accident.
await visit(member.id, "member", at(1, 20), null, null);
// and a visit older than the window, which must not appear in a 7-day view
await visit(owner.id, "owner", at(40, 9), at(40, 17), { "main/": 28800 });

{
  const s = await get(`/workspaces/${ws.slug}/stats?days=7`, owner.token);
  ok("the window holds what is inside it and nothing else",
    s.totals.visits === 5, `${s.totals.visits} visits`);
  ok("  · counting people, not sessions", s.totals.people === 3, `${s.totals.people} people`);
  // 2h + 0.5h + 1h + 1h = 4.5h; the open visit contributes nothing
  ok("  · and only the time that actually finished",
    s.totals.seconds === 4.5 * 3600, `${s.totals.seconds / 3600} hours`);
  ok("  · saying how many are still in the room", s.totals.open === 1, `${s.totals.open} open`);
}
{
  const s = await get(`/workspaces/${ws.slug}/stats?days=7`, owner.token);
  const d = new Date(Date.now() - DAY);
  const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const row = s.daily.find((d) => d.day === yesterday);
  // 2h + 0.5h + 1h = 3.5h; four arrivals by three people, one of them still open
  ok("a day adds up on its own", row?.seconds === 3.5 * 3600 && row?.visits === 4 && row?.people === 3,
    JSON.stringify(row));
}
{
  const s = await get(`/workspaces/${ws.slug}/stats?days=7`, owner.token);
  // 09:00-11:00 covers 09 and 10 for an hour each; 10:00-11:00 the day before
  // adds another hour to 10
  ok("a stay is spread across the hours it covered, not dropped on the first",
    s.hourly[9] === 3600 && s.hourly[10] === 2 * 3600, `09:${s.hourly[9]} 10:${s.hourly[10]}`);
  ok("  · and an hour nobody was here is zero", s.hourly[3] === 0, String(s.hourly[3]));
  // 14:00-14:30 is half an hour inside one hour
  ok("  · including a stay that fits inside one hour", s.hourly[14] === 1800, String(s.hourly[14]));
}
{
  const s = await get(`/workspaces/${ws.slug}/stats?days=7`, owner.token);
  const meeting = s.rooms.find((r) => r.key === "main/meeting");
  const floor = s.rooms.find((r) => r.key === "main/");
  ok("rooms are totalled across everybody", meeting?.seconds === 9000, JSON.stringify(meeting));
  ok("  · with the open floor kept apart from them", floor?.seconds === 7200 && floor?.open === true,
    JSON.stringify(floor));
}
{
  const s = await get(`/workspaces/${ws.slug}/stats?days=7`, owner.token);
  const top = s.people[0];
  ok("people are ordered by how long they were here", top?.name === "owner" && top?.seconds === 3 * 3600,
    JSON.stringify(top));
  const g = s.people.find((p) => p.guest);
  ok("  · and a pass holder is marked as one", g?.name === "ผู้มาเยือน" && g?.userId === null, JSON.stringify(g));
}
{
  const s = await get(`/workspaces/${ws.slug}/stats?days=90`, owner.token);
  ok("a wider window reaches the older visit", s.totals.visits === 6 && s.totals.seconds === 12.5 * 3600,
    `${s.totals.visits} visits, ${s.totals.seconds / 3600} hours`);
}
{
  const s = await get(`/workspaces/${ws.slug}/stats?days=7`, owner.token);
  ok("the daily series has one entry per day of the window, gaps included",
    s.daily.length === 7, `${s.daily.length} days`);
}

// ---- one space's attendance stays in it ------------------------------------------

{
  const other = (await post("/workspaces", { name: `other-${stamp}` }, outsider.token)).workspace;
  await prisma.visit.create({
    data: {
      workspaceId: (await prisma.workspace.findUnique({ where: { slug: other.slug } })).id,
      userId: outsider.id, name: "outsider", joinedAt: at(1, 9), leftAt: at(1, 17),
    },
  });
  const s = await get(`/workspaces/${ws.slug}/stats?days=7`, owner.token);
  ok("another space's hours do not leak into this one", s.totals.seconds === 4.5 * 3600,
    `${s.totals.seconds / 3600} hours`);
}

// ---- the sweep --------------------------------------------------------------------

{
  const old = await visit(owner.id, "owner", new Date(Date.now() - 400 * DAY), new Date(Date.now() - 400 * DAY + HOUR));
  const recent = await prisma.visit.findFirst({ where: { workspaceId: w.id }, orderBy: { joinedAt: "desc" } });

  const sweeper = spawn(process.execPath, [TSX, "src/index.ts"], {
    cwd: API_DIR, env: { ...process.env, PORT: String(PORT + 1), STATS_KEEP_DAYS: "365" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let alive = false;
  for (let i = 0; i < 60 && !alive; i++) {
    try { alive = (await fetch(`http://127.0.0.1:${PORT + 1}/health`)).ok; } catch { await settle(500); }
  }
  await settle(1500); // the sweep fires at startup; give the delete a moment to land

  const stillOld = await prisma.visit.findUnique({ where: { id: old.id } });
  const stillRecent = await prisma.visit.findUnique({ where: { id: recent.id } });
  ok("a visit past the keep-window is swept", alive && stillOld === null, alive ? "" : "the second API never came up");
  ok("  · and this week's is not", stillRecent !== null);
  sweeper.kill();
}

await prisma.$disconnect();
stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
