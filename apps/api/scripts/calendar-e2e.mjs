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
  cwd: API_DIR,
  // Every transport off, deliberately. Booking a room now emails a calendar
  // invitation to everyone coming, and the people in this suite are made up —
  // inheriting a real key from the machine running it would send mail to
  // addresses at test.local, which bounce and are charged to the sender's
  // reputation. The suite is about the routes, not about the mail.
  env: {
    ...process.env, PORT: String(PORT),
    SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", RESEND_API_KEY: "",
    // Google credentials that are not credentials: enough for the connect
    // routes to exist and be checked, and useless to anybody who finds them.
    GOOGLE_CLIENT_ID: "e2e-client", GOOGLE_CLIENT_SECRET: "e2e-secret",
    // The real deployment sits behind two proxies and X-Forwarded-Proto does
    // not survive the trip, so the callback built from the request came out as
    // http:// on an https site and Google refused it. APP_URL is what the rest
    // of the app already trusts for this, trailing slash and all.
    APP_URL: "https://app.example.test/",
  },
  stdio: ["ignore", "pipe", "pipe"],
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
  const email = `c-${who}-${stamp}@test.local`;
  const d = await post("/auth/register", { email, name: who, password: "hunter2pw" });
  return { name: who, email, token: d.token, id: d.user?.id };
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
  // The code, not only the sentence. The browser translates the code, and a
  // refusal with none of it reaches a Thai reader in English.
  ok("  · with a code the browser can translate", r.why === "backwards", JSON.stringify(r.why));
}
{
  const r = await book({ ...ROOM, title: "แวบเดียว", startsAt: at(3), endsAt: new Date(+base + 3 * H + 60_000).toISOString() });
  ok("a one-minute booking is refused", r.status === 400, `status ${r.status}`);
  ok("  · saying how short is too short", r.why === "too-short" && typeof r.n === "number",
    `${r.why} n=${r.n}`);
}
{
  const r = await book({ ...ROOM, title: "ทั้งวันทั้งคืน", startsAt: at(3), endsAt: at(15) });
  ok("a twelve-hour booking is refused", r.status === 400, `status ${r.status}`);
  // The limit is a setting, so the number comes from the server or the client
  // would quote one that is not in force.
  ok("  · and quoting the limit in force", r.why === "too-long" && typeof r.n === "number",
    `${r.why} n=${r.n}`);
}
{
  const r = await book({ ...ROOM, title: "เมื่อวาน", startsAt: at(-48), endsAt: at(-47) });
  ok("a time that has passed is refused", r.status === 400, `status ${r.status}`);
  ok("  · as past, which is the one the week grid now prevents", r.why === "past", JSON.stringify(r.why));
}
{
  const r = await book({ ...ROOM, title: "ปีหน้า", startsAt: at(24 * 200), endsAt: at(24 * 200 + 1) });
  ok("a booking two hundred days out is refused", r.status === 400, `status ${r.status}`);
  ok("  · as too far ahead, with how far is allowed", r.why === "too-far" && typeof r.n === "number",
    `${r.why} n=${r.n}`);
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

// ---- one meeting, for somebody who does not want the whole feed ----------------

{
  // The signature is computed from a server key the browser does not hold, so
  // this link has to arrive with the booking. Until it did, the route existed
  // with no possible caller.
  const list = await get(`/workspaces/${ws.slug}/bookings`, owner.token);
  const one = (list.bookings ?? []).find((b) => b.id === first.id);
  ok("a booking arrives with a link to itself as a calendar file",
    typeof one?.ics === "string" && one.ics.includes("sig="), JSON.stringify(one?.ics));

  const r = await fetch(API + one.ics);
  const text = await r.text();
  ok("  · which opens", r.status === 200, `status ${r.status}`);
  ok("  · as a calendar", (r.headers.get("content-type") || "").startsWith("text/calendar"),
    r.headers.get("content-type"));
  ok("  · holding exactly that one meeting",
    (text.match(/BEGIN:VEVENT/g) || []).length === 1 && text.includes("SUMMARY:ประชุมทีม"),
    String((text.match(/BEGIN:VEVENT/g) || []).length));
  ok("  · offered as a download, since it is meant for a calendar app",
    (r.headers.get("content-disposition") || "").startsWith("attachment"),
    r.headers.get("content-disposition"));

  const tampered = await fetch(API + one.ics.replace(/sig=./, "sig=A"));
  ok("  · and a changed signature opens nothing", tampered.status === 403, `status ${tampered.status}`);

  const feedKeyReused = await fetch(API + one.ics.replace(/sig=.*/, "sig="));
  ok("  · nor an empty one", feedKeyReused.status === 403, `status ${feedKeyReused.status}`);
}

// ---- connecting one person's own Google Calendar -------------------------------
//
// The routes only, because the other side is Google. What is worth checking
// here is who may ask, what is sent to Google, and that the note carried
// through the round trip cannot be written by somebody else — it names a user
// account, and a forgeable one would let anybody attach their calendar to
// somebody else's name.

{
  const mine = await get("/me/google-calendar", owner.token);
  ok("somebody who has connected nothing is told so", mine.connected === false, JSON.stringify(mine.connected));
  ok("  · and that the server can do it at all", mine.available === true, JSON.stringify(mine.available));
  // The one string that has to be registered with Google by hand, and the one
  // that cannot be worked out by reading the code — it is built from the
  // headers whatever sits in front of this server sends.
  ok("  · and is told exactly what to register with Google",
    mine.redirectUri === "https://app.example.test/auth/google/calendar/callback", mine.redirectUri);
  ok("  · on the scheme the app is actually reached on, not the one the proxy speaks",
    String(mine.redirectUri).startsWith("https://"), mine.redirectUri);

  const anon = await fetch(API + "/me/google-calendar");
  ok("  · and it is nobody else's business", anon.status === 401, `status ${anon.status}`);
}

let startUrl = "";
{
  const r = await post("/me/google-calendar/start", { back: "https://app.test/" }, owner.token);
  startUrl = String(r.url || "");
  ok("a signed-in person is given somewhere to go", /^https:\/\/accounts\.google\.com\//.test(startUrl),
    startUrl.slice(0, 60));
  const q = new URL(startUrl).searchParams;
  ok("  · asking only to write events", q.get("scope") === "https://www.googleapis.com/auth/calendar.events",
    q.get("scope"));
  ok("  · offline, or the server can do nothing an hour later",
    q.get("access_type") === "offline" && q.get("prompt") === "consent",
    `${q.get("access_type")} ${q.get("prompt")}`);
  ok("  · coming back to the address that was registered, character for character",
    q.get("redirect_uri") === "https://app.example.test/auth/google/calendar/callback",
    q.get("redirect_uri"));
  ok("  · and carrying no session token in the URL",
    !startUrl.includes(owner.token),
    "a token in a query string is a working credential in nginx logs and browser history");
}

{
  const anon = await fetch(API + "/me/google-calendar/start", { method: "POST" });
  ok("nobody can be sent to connect a calendar without signing in", anon.status === 401, `status ${anon.status}`);
}

{
  const state = new URL(startUrl).searchParams.get("state") || "";
  const bad = state.slice(0, -1) + (state.endsWith("A") ? "B" : "A");
  const r = await fetch(`${API}/auth/google/calendar/callback?code=x&state=${encodeURIComponent(bad)}`,
    { redirect: "manual" });
  ok("a note somebody edited is refused", (r.headers.get("location") || "").includes("gcal=expired"),
    r.headers.get("location"));

  const none = await fetch(`${API}/auth/google/calendar/callback?code=x`, { redirect: "manual" });
  ok("  · and so is one that is missing", (none.headers.get("location") || "").includes("gcal=expired"),
    none.headers.get("location"));

  const refused = await fetch(
    `${API}/auth/google/calendar/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    { redirect: "manual" });
  ok("  · somebody who said no is brought back saying so",
    (refused.headers.get("location") || "").includes("gcal=access_denied"),
    refused.headers.get("location"));
}

{
  const r = await del("/me/google-calendar", owner.token);
  ok("disconnecting nothing is not an error", r.ok === true && r.already === true, JSON.stringify(r));
}

// ---- the people the host puts on a meeting -------------------------------------
//
// Two fields on the form, one list on the wire, and the split between member
// and guest decided here rather than by the browser — a client that calls an
// outsider a member must not make one.

{
  const r = await book({
    ...ROOM, title: "มีคนอื่นด้วย", startsAt: at(20), endsAt: at(21),
    invitees: [mate.email, "someone@outside.test", "  NOT AN EMAIL ", mate.email],
  });
  ok("a booking can be made with people on it", r.status === 200, `status ${r.status}`);

  const list = r.booking?.invitees ?? [];
  ok("  · the same address twice is one person", list.length === 2,
    list.map((i) => i.email).join(" ") || "nobody");
  ok("  · something that is not an address is dropped rather than refused",
    !list.some((i) => /NOT AN EMAIL/i.test(i.email)),
    "a typo in one row should not lose the other four");

  const known = list.find((i) => i.email === mate.email.toLowerCase());
  ok("  · somebody in this space is marked as one", known?.member === true, JSON.stringify(known));
  ok("    · and named, not left as an address", known?.name === mate.name, known?.name);
  const outsider = list.find((i) => i.email === "someone@outside.test");
  ok("  · somebody who is not, is not", outsider?.member === false, JSON.stringify(outsider));

  ok("  · and being invited is not being counted as coming",
    r.booking.going === 1 && list.every((i) => i.going === false),
    `going=${r.booking.going}`);
  // Four states, and the one everybody forgets is the default.
  ok("  · nobody has answered yet, which is not the same as declining",
    list.every((i) => i.reply === "needsAction"), list.map((i) => i.reply).join(" "));

  // The host is on it already; saying so twice would email them twice.
  const withHost = await book({
    ...ROOM, title: "เชิญตัวเอง", startsAt: at(22), endsAt: at(23),
    invitees: [owner.email],
  });
  ok("  · and the host is not invited to their own meeting",
    (withHost.booking?.invitees ?? []).length === 0,
    JSON.stringify(withHost.booking?.invitees));
  if (withHost.booking) await del(`/workspaces/${ws.slug}/bookings/${withHost.booking.id}`, owner.token);

  // What a client claims about who is a member changes nothing.
  const lying = await book({
    ...ROOM, title: "โกหก", startsAt: at(24), endsAt: at(25),
    invitees: [{ email: "fake@outside.test", member: true }, "real@outside.test"],
  });
  ok("  · an invitee sent as an object rather than an address is ignored",
    (lying.booking?.invitees ?? []).length === 1
    && lying.booking.invitees[0].email === "real@outside.test",
    JSON.stringify(lying.booking?.invitees));
  if (lying.booking) await del(`/workspaces/${ws.slug}/bookings/${lying.booking.id}`, owner.token);

  // Everybody who was asked can read the meeting, and it is on their list.
  const theirs = await get(`/workspaces/${ws.slug}/bookings?from=${at(0)}&to=${at(48)}`, mate.token);
  const seen = (theirs.bookings ?? []).find((x) => x.id === r.booking.id);
  ok("  · and the meeting is visible to the person invited", !!seen, seen ? "yes" : "not in their list");

  if (r.booking) await del(`/workspaces/${ws.slug}/bookings/${r.booking.id}`, owner.token);
}

{
  // A list long enough to be a mailing list is not one.
  const many = Array.from({ length: 80 }, (_, i) => `flood${i}@outside.test`);
  const r = await book({ ...ROOM, title: "เยอะไป", startsAt: at(26), endsAt: at(27), invitees: many });
  ok("an invitation list has a ceiling", (r.booking?.invitees ?? []).length <= 50,
    `${(r.booking?.invitees ?? []).length} of ${many.length}`);
  if (r.booking) await del(`/workspaces/${ws.slug}/bookings/${r.booking.id}`, owner.token);
}

// ---- being told before it starts -----------------------------------------------
//
// A lead time and a way to say it, chosen per meeting. Minutes on the wire
// whatever the form showed: "2 hours" and "120 minutes" are one fact.

{
  const r = await book({
    ...ROOM, title: "มีเตือน", startsAt: at(30), endsAt: at(31),
    reminders: [
      { method: "email", minutes: 120 },
      { method: "popup", minutes: 10 },
      { method: "email", minutes: 120 },          // the same one twice
      { method: "email", minutes: -5 },           // before the heat death
      { method: "email", minutes: 60 * 24 * 40 }, // further ahead than Google allows
      { method: "shout", minutes: 5 },            // not a way of saying anything
    ],
  });
  ok("a booking can carry reminders", r.status === 200, `status ${r.status}`);
  const got = r.booking?.reminders ?? [];
  ok("  · the same reminder twice is one", got.filter((x) => x.minutes === 120).length === 1,
    JSON.stringify(got));
  ok("  · a lead time before the meeting exists is dropped",
    !got.some((x) => x.minutes < 0), JSON.stringify(got.map((x) => x.minutes)));
  ok("  · and one further ahead than a calendar will take",
    !got.some((x) => x.minutes > 4 * 7 * 24 * 60),
    "Google refuses a reminder over four weeks, and refuses the event with it");
  ok("  · a way of saying it nobody has is read as a notice in the app",
    got.every((x) => x.method === "email" || x.method === "popup"),
    got.map((x) => x.method).join(" "));
  ok("  · and what survives is what was asked for",
    got.some((x) => x.method === "email" && x.minutes === 120)
    && got.some((x) => x.method === "popup" && x.minutes === 10),
    JSON.stringify(got));

  const listed = await get(`/workspaces/${ws.slug}/bookings?from=${at(0)}&to=${at(48)}`, owner.token);
  const seen = (listed.bookings ?? []).find((x) => x.id === r.booking.id);
  ok("  · and comes back on the listing, so the browser can draw them",
    (seen?.reminders ?? []).length === got.length, JSON.stringify(seen?.reminders));
  // "Will be sent" and "was sent" is the question somebody asks when an
  // expected email has not arrived, and it was not answerable anywhere.
  ok("  · saying of each email one whether it has gone yet",
    got.filter((x) => x.method === "email").every((x) => x.sentAt === null),
    JSON.stringify(got.map((x) => x.sentAt)));

  if (r.booking) await del(`/workspaces/${ws.slug}/bookings/${r.booking.id}`, owner.token);
}

{
  // Six is one more than a calendar will hold.
  const many = Array.from({ length: 9 }, (_, i) => ({ method: "popup", minutes: i + 1 }));
  const r = await book({ ...ROOM, title: "เตือนเยอะ", startsAt: at(32), endsAt: at(33), reminders: many });
  ok("no more reminders than a calendar will hold", (r.booking?.reminders ?? []).length <= 5,
    `${(r.booking?.reminders ?? []).length} of ${many.length}`);
  if (r.booking) await del(`/workspaces/${ws.slug}/bookings/${r.booking.id}`, owner.token);
}

{
  const r = await book({ ...ROOM, title: "ไม่เตือน", startsAt: at(34), endsAt: at(35) });
  ok("a booking with none asked for carries none", (r.booking?.reminders ?? []).length === 0,
    JSON.stringify(r.booking?.reminders));
  if (r.booking) await del(`/workspaces/${ws.slug}/bookings/${r.booking.id}`, owner.token);
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
