/**
 * Writing a booking into somebody's own Google Calendar.
 *
 * No Google anywhere near this: fetch is replaced and the module is asked what
 * it sends and what it does with each answer. What is worth checking is the
 * part a mistake in is quiet — an event addressed to the wrong calendar, a
 * revoked grant retried forever, or a "failed" that was actually the state
 * being asked for.
 *
 *   npm run test:gcal -w @nexspace/api
 */
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.BOOKING_TZ = "Asia/Bangkok";
process.env.DATABASE_URL ||= "file:./dev.db";

import { pathToFileURL } from "url";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => import(pathToFileURL(resolve(HERE, "../src/" + f)).href);

const { prisma } = await load("db.js");
const { pushEvent, dropEvent, accessTokenFor, gcalEnabled, GCAL_SCOPE } = await load("gcal.js");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

// ---- a Google that answers however this file says ------------------------------
const sent: { url: string; method: string; body: string }[] = [];
let tokenAnswer: unknown = { access_token: "at_1", expires_in: 3600 };
let apiStatus = 200;
let apiAnswer: unknown = { id: "ev_1" };

globalThis.fetch = (async (url: string, init: any = {}) => {
  const u = String(url);
  sent.push({ url: u, method: init.method ?? "GET", body: String(init.body ?? "") });
  if (u.includes("oauth2.googleapis.com/token")) {
    return { ok: true, status: 200, json: async () => tokenAnswer, text: async () => JSON.stringify(tokenAnswer) };
  }
  return {
    ok: apiStatus < 400, status: apiStatus,
    json: async () => apiAnswer, text: async () => JSON.stringify(apiAnswer),
  };
}) as unknown as typeof fetch;

const stamp = Date.now();
const user = await prisma.user.create({
  data: { email: `gcal-${stamp}@test.local`, name: "ชาลิสา" },
});
const cleanUp = async () => {
  await prisma.googleCalendar.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
};
process.on("exit", () => { void cleanUp(); });

const connect = () => prisma.googleCalendar.upsert({
  where: { userId: user.id },
  update: { refreshToken: "rt_1", email: user.email, lastError: null },
  create: { userId: user.id, refreshToken: "rt_1", email: user.email },
});

const BOOKING = {
  id: "bk_9", title: "รีวิวสปรินต์", roomLabel: "ห้องประชุมใหญ่", hostName: "ชาลิสา",
  startsAt: new Date("2026-09-14T03:00:00Z"), endsAt: new Date("2026-09-14T04:00:00Z"),
  url: "https://nexspace.example.test/?w=test&m=office",
};

console.log("\na booking, written into one person's own calendar\n");

ok("the feature is on when Google is configured", gcalEnabled === true);
ok("  · asking for the narrowest scope that can write an event",
  GCAL_SCOPE === "https://www.googleapis.com/auth/calendar.events",
  GCAL_SCOPE);

// ---- nobody connected ----------------------------------------------------------
{
  sent.length = 0;
  const id = await pushEvent(user.id, BOOKING);
  ok("somebody who connected nothing has nothing written", id === null);
  ok("  · and Google is never called for them", sent.length === 0, sent.map((s) => s.url).join(" | ") || "nothing");
}

// ---- the event itself ----------------------------------------------------------
await connect();
{
  sent.length = 0;
  apiStatus = 200; apiAnswer = { id: "ev_1" };
  const id = await pushEvent(user.id, BOOKING);
  ok("a connected calendar gets the event", id === "ev_1", String(id));

  const call = sent.find((s) => s.url.includes("/calendar/v3/"))!;
  ok("  · in their primary calendar", call.url.includes("/calendars/primary/events"), call.url);
  const body = JSON.parse(call.body);
  ok("  · with the title and the room", body.summary === BOOKING.title && body.location === BOOKING.roomLabel);
  ok("  · the time in the office's own zone, not the reader's",
    body.start.timeZone === "Asia/Bangkok" && body.end.timeZone === "Asia/Bangkok",
    `${body.start.timeZone}`);
  ok("  · carrying the same id as the .ics feed, so it is not in there twice",
    body.iCalUID === "bk_9@nexspace", body.iCalUID);
  ok("  · and no attendee list, which would make Google send its own invitations",
    body.attendees === undefined, JSON.stringify(body.attendees));
  ok("  · a way back to the room", JSON.stringify(body).includes(BOOKING.url!));
}

// ---- what an answer means ------------------------------------------------------
{
  sent.length = 0;
  apiStatus = 409; apiAnswer = { error: { message: "The requested identifier already exists" } };
  const id = await pushEvent(user.id, BOOKING);
  ok("an event that is already there is not an error", id === null,
    "409 is the state that was wanted, reached by somebody else");
}
{
  apiStatus = 200; apiAnswer = {};
  const gone = await dropEvent(user.id, "ev_1");
  ok("an event can be taken back out", gone === true);
  ok("  · by DELETE on that one event",
    sent.some((s) => s.method === "DELETE" && s.url.includes("/events/ev_1")),
    sent.filter((s) => s.method === "DELETE").map((s) => s.url).join(" | ") || "nothing");
}
{
  for (const status of [404, 410]) {
    apiStatus = status; apiAnswer = { error: { message: "Not Found" } };
    ok(`  · and one already gone (${status}) counts as removed`, await dropEvent(user.id, "ev_1") === true,
      "somebody deleting it in Google is not a failure to delete it");
  }
  apiStatus = 403; apiAnswer = { error: { message: "Rate Limit Exceeded" } };
  ok("  · but a real refusal is reported as one", await dropEvent(user.id, "ev_1") === false);
}

// ---- a failure is written down where the person can see it ---------------------
{
  await connect();
  apiStatus = 500; apiAnswer = { error: { message: "Backend Error" } };
  await pushEvent(user.id, BOOKING);
  const row = await prisma.googleCalendar.findUnique({ where: { userId: user.id } });
  ok("a refusal is recorded against the connection", (row?.lastError ?? "").includes("Backend Error"),
    String(row?.lastError));
  apiStatus = 200; apiAnswer = { id: "ev_2" };
  await pushEvent(user.id, BOOKING);
  const after = await prisma.googleCalendar.findUnique({ where: { userId: user.id } });
  ok("  · and cleared when it works again", after?.lastError === null, String(after?.lastError));
}

// ---- a grant that is gone --------------------------------------------------------
{
  await connect();
  tokenAnswer = { error: "invalid_grant", error_description: "Token has been expired or revoked." };
  const token = await accessTokenFor(user.id);
  ok("a revoked grant returns nothing", token === null);
  const row = await prisma.googleCalendar.findUnique({ where: { userId: user.id } });
  ok("  · and is disconnected rather than retried forever", row === null,
    "the person has to be told, once, not have it fail quietly every booking");
  tokenAnswer = { access_token: "at_1", expires_in: 3600 };
}

// ---- the refresh itself ----------------------------------------------------------
{
  await connect();
  sent.length = 0;
  await accessTokenFor(user.id);
  const call = sent.find((s) => s.url.includes("oauth2.googleapis.com/token"))!;
  ok("an access token is minted from the refresh token each time",
    call.body.includes("grant_type=refresh_token") && call.body.includes("refresh_token=rt_1"),
    call.body.replace(/client_secret=[^&]*/, "client_secret=…"));
  ok("  · and the secret is sent to Google and nowhere else",
    sent.every((s) => !s.body.includes("test-secret") || s.url.startsWith("https://oauth2.googleapis.com/")),
    "a client secret in a request to anywhere else is a leaked credential");
}

await cleanUp();
console.log(`\n${pass} passed, ${fail} failed\n`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
