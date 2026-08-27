#!/usr/bin/env node
/**
 * Rooms held for a while.
 *
 * The rule that carries the feature is that two meetings cannot hold the same
 * room at the same time, so most of this is about the edges of "at the same
 * time" — touching, containing, straddling — and about the fact that a
 * different room, or a different floor, is not the same room.
 *
 *   node apps/api/scripts/calendar-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3993;
const API = `http://127.0.0.1:${PORT}`;

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
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, headers: r.headers, ...json };
};
const get = (p, token) => call("GET", p, { token });
const post = (p, body, token) => call("POST", p, { body, token });
const del = (p, token) => call("DELETE", p, { token });

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

console.log("\nrooms held for a while\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await settle(500); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast --------------------------------------------------------------------

const stamp = Date.now();
const person = async (who) => {
  const d = await post("/auth/register", { email: `c-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });
  return { name: who, token: d.token, id: d.user?.id };
};

const owner = await person("owner");
const mate = await person("mate");
const outsider = await person("outsider");

const ws = (await post("/workspaces", { name: `cal-${stamp}` }, owner.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, mate.token);
const visitor = (await post(`/workspaces/${ws.slug}/guests`, { name: "visitor" }, owner.token)).guest;
await call("PATCH", `/workspaces/${ws.slug}`, { body: { allowGuests: false }, token: owner.token });

// Every time in this suite hangs off one hour, so the cases read as clock
// times rather than as arithmetic.
const H = 60 * 60 * 1000;
const base = new Date(Math.ceil((Date.now() + H) / H) * H);   // the next whole hour
const at = (hours) => new Date(+base + hours * H).toISOString();

const book = (body, token = owner.token) => post(`/workspaces/${ws.slug}/bookings`, body, token);
const ROOM = { roomId: "meeting", roomLabel: "ห้องประชุม", mapSlug: "main" };

// ---- holding one -------------------------------------------------------------

let first;
{
  const r = await book({ ...ROOM, title: "ประชุมทีม", startsAt: at(0), endsAt: at(1) });
  first = r.booking;
  ok("a member can hold a room", r.status === 200 && !!first?.id, `status ${r.status}`);
  ok("  · it comes back naming the room and the host", first?.room === "ห้องประชุม" && first?.host === "owner",
    `${first?.room} / ${first?.host}`);
  ok("  · and whoever booked it is already going", first?.going === 1 && first?.imGoing === true,
    `going=${first?.going} imGoing=${first?.imGoing}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/bookings`, mate.token);
  ok("everybody in the space sees it", (r.bookings ?? []).some((b) => b.id === first.id), `status ${r.status}`);
  const seen = (r.bookings ?? []).find((b) => b.id === first.id);
  ok("  · but it is not theirs to cancel", seen?.mine === false, JSON.stringify(seen?.mine));
}
{
  const r = await get(`/workspaces/${ws.slug}/bookings?guest=${encodeURIComponent(visitor.code)}`);
  ok("a visitor can see what a room is taken for", r.status === 200 && (r.bookings ?? []).length >= 1,
    `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/bookings`,
    { ...ROOM, title: "ของแขก", startsAt: at(20), endsAt: at(21) }, undefined);
  ok("  · and cannot hold one", r.status === 403, `status ${r.status}`);
}
{
  const r = await book({ ...ROOM, title: "ของคนนอก", startsAt: at(20), endsAt: at(21) }, outsider.token);
  ok("somebody outside the space cannot hold a room", r.status === 403, `status ${r.status}`);
}

// ---- the same room at the same time -------------------------------------------

{
  const r = await book({ ...ROOM, title: "ซ้อนพอดี", startsAt: at(0), endsAt: at(1) });
  ok("the same hour again is refused", r.status === 409, `status ${r.status}`);
  ok("  · saying what is in the way", r.clash?.title === "ประชุมทีม", JSON.stringify(r.clash?.title));
}
{
  const r = await book({ ...ROOM, title: "ซ้อนครึ่ง", startsAt: at(0.5), endsAt: at(1.5) });
  ok("an overlap at the end is refused", r.status === 409, `status ${r.status}`);
}
{
  const r = await book({ ...ROOM, title: "ซ้อนหัว", startsAt: at(-0.5), endsAt: at(0.5) });
  ok("an overlap at the start is refused", r.status === 409, `status ${r.status}`);
}
{
  const r = await book({ ...ROOM, title: "คร่อม", startsAt: at(-1), endsAt: at(2) });
  ok("a booking that swallows it whole is refused", r.status === 409, `status ${r.status}`);
}
{
  const r = await book({ ...ROOM, title: "ข้างใน", startsAt: at(0.25), endsAt: at(0.5) });
  ok("one that sits entirely inside it is refused", r.status === 409, `status ${r.status}`);
}
{
  // Touching is not overlapping, and this is the case that matters most: it is
  // how rooms are actually used, back to back all afternoon.
  const r = await book({ ...ROOM, title: "ต่อท้าย", startsAt: at(1), endsAt: at(2) });
  ok("but starting exactly when the last one ends is fine", r.status === 200, `status ${r.status}`);
  if (r.booking) await del(`/workspaces/${ws.slug}/bookings/${r.booking.id}`, owner.token);
}
{
  const r = await book({ ...ROOM, roomId: "pantry", roomLabel: "ห้องครัว", title: "อีกห้อง", startsAt: at(0), endsAt: at(1) });
  ok("the same hour in a different room is fine", r.status === 200, `status ${r.status}`);
  if (r.booking) await del(`/workspaces/${ws.slug}/bookings/${r.booking.id}`, owner.token);
}
{
  const r = await book({ ...ROOM, mapSlug: "floor2", title: "อีกชั้น", startsAt: at(0), endsAt: at(1) });
  ok("and the same room id on another map is another room", r.status === 200, `status ${r.status}`);
  if (r.booking) await del(`/workspaces/${ws.slug}/bookings/${r.booking.id}`, owner.token);
}

// ---- times that are not times --------------------------------------------------

{
  const r = await book({ ...ROOM, title: "ย้อนเวลา", startsAt: at(3), endsAt: at(2) });
  ok("ending before it starts is refused", r.status === 400, `status ${r.status}`);
}
{
  const r = await book({ ...ROOM, title: "แวบเดียว", startsAt: at(3), endsAt: new Date(+base + 3 * H + 60_000).toISOString() });
  ok("a one-minute booking is refused", r.status === 400, `status ${r.status}`);
}
{
  const r = await book({ ...ROOM, title: "ทั้งวันทั้งคืน", startsAt: at(3), endsAt: at(15) });
  ok("a twelve-hour booking is refused", r.status === 400, `status ${r.status}`);
}
{
  const r = await book({ ...ROOM, title: "เมื่อวาน", startsAt: at(-48), endsAt: at(-47) });
  ok("a time that has passed is refused", r.status === 400, `status ${r.status}`);
}
{
  const r = await book({ ...ROOM, title: "ปีหน้า", startsAt: at(24 * 200), endsAt: at(24 * 200 + 1) });
  ok("a booking two hundred days out is refused", r.status === 400, `status ${r.status}`);
}
{
  const r = await book({ ...ROOM, title: "", startsAt: at(3), endsAt: at(4) });
  ok("a meeting with no name is refused", r.status === 400, `status ${r.status}`);
}

// ---- who is coming ---------------------------------------------------------------

{
  const r = await post(`/workspaces/${ws.slug}/bookings/${first.id}/going`, { going: true }, mate.token);
  ok("somebody else can say they are coming", r.booking?.going === 2, `going=${r.booking?.going}`);
  ok("  · and it is their own attendance they changed", r.booking?.imGoing === true, JSON.stringify(r.booking?.imGoing));
}
{
  const r = await post(`/workspaces/${ws.slug}/bookings/${first.id}/going`, { going: false }, mate.token);
  ok("and can take it back", r.booking?.going === 1 && r.booking?.imGoing === false,
    `going=${r.booking?.going} imGoing=${r.booking?.imGoing}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/bookings/${first.id}/going`, { going: true }, mate.token);
  const again = await post(`/workspaces/${ws.slug}/bookings/${first.id}/going`, { going: true }, mate.token);
  ok("saying it twice does not count twice", again.booking?.going === 2,
    `${r.booking?.going} then ${again.booking?.going}`);
}

// ---- giving the room back ----------------------------------------------------------

{
  const r = await del(`/workspaces/${ws.slug}/bookings/${first.id}`, mate.token);
  ok("somebody else cannot cancel your meeting", r.status === 403, `status ${r.status}`);
}
{
  const held = (await book({ ...ROOM, title: "ของ mate", startsAt: at(5), endsAt: at(6) }, mate.token)).booking;
  const r = await del(`/workspaces/${ws.slug}/bookings/${held.id}`, owner.token);
  ok("but the owner of the space can", r.status === 200, `status ${r.status}`);
  const after = await get(`/workspaces/${ws.slug}/bookings`, owner.token);
  ok("  · and it is gone", !(after.bookings ?? []).some((b) => b.id === held.id));
}
{
  const held = (await book({ ...ROOM, title: "ชั่วคราว", startsAt: at(7), endsAt: at(8) })).booking;
  await del(`/workspaces/${ws.slug}/bookings/${held.id}`, owner.token);
  const r = await book({ ...ROOM, title: "หลังยกเลิก", startsAt: at(7), endsAt: at(8) });
  ok("cancelling really frees the hour", r.status === 200, `status ${r.status}`);
  if (r.booking) await del(`/workspaces/${ws.slug}/bookings/${r.booking.id}`, owner.token);
}

// ---- the calendar file ------------------------------------------------------------

let feed;
{
  const r = await get(`/workspaces/${ws.slug}/calendar-url`, owner.token);
  feed = r.url;
  ok("a member is given a feed address", r.status === 200 && /calendar\.ics\?key=/.test(feed || ""), feed);
}
{
  const r = await get(`/workspaces/${ws.slug}/calendar-url`, outsider.token);
  ok("  · and somebody outside the space is not", r.status === 403, `status ${r.status}`);
}
{
  const path = feed.slice(feed.indexOf("/workspaces"));
  const r = await fetch(API + path);
  const text = await r.text();
  ok("the feed is served without a session, because a calendar app has none", r.status === 200, `status ${r.status}`);
  ok("  · as a calendar", (r.headers.get("content-type") || "").startsWith("text/calendar"),
    r.headers.get("content-type"));
  ok("  · holding the meetings", text.includes("SUMMARY:ประชุมทีม"), text.split("\r\n").find((l) => l.startsWith("SUMMARY")));
  ok("  · naming the room as the location", text.includes("LOCATION:ห้องประชุม"));
  ok("  · with CRLF line endings, which the format requires", text.includes("\r\n") && !/[^\r]\n/.test(text));
  ok("  · opening and closing properly", text.startsWith("BEGIN:VCALENDAR") && text.trimEnd().endsWith("END:VCALENDAR"));
  ok("  · and every line inside 75 bytes",
    text.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75),
    String(Math.max(...text.split("\r\n").map((l) => Buffer.byteLength(l, "utf8")))));
}
{
  // The line above never folded: the longest line in that file was 39 bytes, so
  // it proved the fold code was not reached rather than that it works. A long
  // Thai title is three bytes a character and folds several times.
  const long = "ประชุมทบทวนแผนงานประจำไตรมาสร่วมกับฝ่ายขายและฝ่ายการตลาด รอบบ่าย";
  const made = await book({ ...ROOM, title: long, startsAt: at(9), endsAt: at(10) });
  ok("a long Thai title is accepted", made.status === 200, `status ${made.status}`);

  const path = feed.slice(feed.indexOf("/workspaces"));
  const text = await (await fetch(API + path)).text();
  const lines = text.split("\r\n");
  const longest = Math.max(...lines.map((l) => Buffer.byteLength(l, "utf8")));
  ok("  · and is folded rather than sent as one long line", longest <= 75, String(longest));
  ok("  · with the continuations marked by a leading space",
    lines.some((l) => l.startsWith(" ")), String(lines.filter((l) => l.startsWith(" ")).length));

  // Unfold the way a calendar client does, and the title must come back whole —
  // a fold placed inside a UTF-8 sequence would corrupt it invisibly.
  const unfolded = text.replace(/\r\n /g, "");
  ok("  · and unfolds back to exactly what was typed", unfolded.includes(`SUMMARY:${long}`),
    unfolded.split("\r\n").find((l) => l.startsWith("SUMMARY:ประชุมทบทวน"))?.slice(0, 40));

  if (made.booking) await del(`/workspaces/${ws.slug}/bookings/${made.booking.id}`, owner.token);
}
{
  const path = feed.slice(feed.indexOf("/workspaces")).replace(/key=.*/, "key=guessed");
  const r = await fetch(API + path);
  ok("a wrong key opens nothing", r.status === 403, `status ${r.status}`);
}
{
  const path = feed.slice(feed.indexOf("/workspaces")).replace(/\?key=.*/, "");
  const r = await fetch(API + path);
  ok("no key at all opens nothing", r.status === 403, `status ${r.status}`);
}
{
  const rotated = await post(`/workspaces/${ws.slug}/calendar-url`, {}, owner.token);
  ok("the owner can rotate the address", rotated.status === 200 && rotated.url !== feed, rotated.url);
  const old = await fetch(API + feed.slice(feed.indexOf("/workspaces")));
  ok("  · which is what makes a leaked one recoverable", old.status === 403, `status ${old.status}`);
  const fresh = await fetch(API + rotated.url.slice(rotated.url.indexOf("/workspaces")));
  ok("  · and the new one works", fresh.status === 200, `status ${fresh.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/calendar-url`, {}, mate.token);
  ok("a plain member cannot rotate it out from under everybody", r.status === 403, `status ${r.status}`);
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
