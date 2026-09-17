/**
 * Writing a booking into somebody's own Outlook calendar.
 *
 * No Microsoft anywhere near this: fetch is replaced and the module is asked
 * what it sends and what it does with each answer. The parts worth checking are
 * the ones Graph does differently from Google — a refresh token that rotates on
 * every use, a time zone name with two dialects, and an answer vocabulary of
 * its own.
 *
 *   npm run test:mscal -w @nexspace/api
 */
process.env.MS_CLIENT_ID = "test-client";
process.env.MS_CLIENT_SECRET = "test-secret";
process.env.MS_TENANT = "common";
process.env.DATABASE_URL ||= "file:./dev.db";

import { pathToFileURL } from "url";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => import(pathToFileURL(resolve(HERE, "../src/" + f)).href);

const { prisma } = await load("db.js");
const {
  msPushEvent, msDropEvent, msReadReplies, msAccessTokenFor, msEnabled, MS_SCOPE,
} = await load("mscal.js");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

// ---- a Graph that answers however this file says --------------------------------
const sent: { url: string; method: string; body: string }[] = [];
let tokenAnswer: unknown = { access_token: "at_1", refresh_token: "rt_2", expires_in: 3600 };
let apiStatus = 200;
let apiAnswer: unknown = { id: "ev_1" };

globalThis.fetch = (async (url: string, init: any = {}) => {
  const u = String(url);
  sent.push({ url: u, method: init.method ?? "GET", body: String(init.body ?? "") });
  if (u.includes("login.microsoftonline.com")) {
    return { ok: true, status: 200, json: async () => tokenAnswer, text: async () => JSON.stringify(tokenAnswer) };
  }
  return {
    ok: apiStatus < 400, status: apiStatus,
    json: async () => apiAnswer, text: async () => JSON.stringify(apiAnswer),
  };
}) as unknown as typeof fetch;

const stamp = Date.now();
const user = await prisma.user.create({
  data: { email: `mscal-${stamp}@test.local`, name: "ชาลิสา" },
});
const cleanUp = async () => {
  await prisma.microsoftCalendar.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
};
process.on("exit", () => { void cleanUp(); });

const connect = () => prisma.microsoftCalendar.upsert({
  where: { userId: user.id },
  update: { refreshToken: "rt_1", email: user.email, lastError: null },
  create: { userId: user.id, refreshToken: "rt_1", email: user.email },
});

const BOOKING = {
  id: "bk_9", title: "รีวิวสปรินต์", roomLabel: "ห้องประชุมใหญ่", hostName: "ชาลิสา",
  startsAt: new Date("2026-09-14T03:00:00Z"), endsAt: new Date("2026-09-14T04:00:00Z"),
  url: "https://nexspace.example.test/?w=test&m=office",
};

console.log("\na booking, written into one person's own Outlook calendar\n");

ok("the feature is on when Microsoft is configured", msEnabled === true);
ok("  · asking for the mailbox's calendar and nothing else",
  MS_SCOPE === "offline_access Calendars.ReadWrite User.Read", MS_SCOPE);

// ---- nobody connected ------------------------------------------------------------
{
  sent.length = 0;
  ok("somebody who connected nothing has nothing written",
    await msPushEvent(user.id, BOOKING) === null);
  ok("  · and Microsoft is never called for them", sent.length === 0,
    sent.map((s) => s.url).join(" | ") || "nothing");
}

// ---- the event itself ------------------------------------------------------------
await connect();
{
  sent.length = 0;
  apiStatus = 200; apiAnswer = { id: "ev_1" };
  ok("a connected calendar gets the event", await msPushEvent(user.id, BOOKING) === "ev_1");

  const call = sent.find((s) => s.url.includes("graph.microsoft.com"))!;
  ok("  · posted to their own calendar", call.url.endsWith("/me/events"), call.url);
  const body = JSON.parse(call.body);
  ok("  · with the title and the room",
    body.subject === BOOKING.title && body.location.displayName === BOOKING.roomLabel);
  /**
   * Graph speaks Windows zone names by default and IANA ones only when asked.
   * "Asia/Bangkok" against the wrong dialect is a meeting an hour out with
   * nothing on screen to say so, and UTC is the one name both spell the same.
   */
  ok("  · the time as UTC, which both of Graph's dialects spell the same",
    body.start.timeZone === "UTC" && body.end.timeZone === "UTC",
    `${body.start.timeZone}`);
  ok("    · and at the instant it was booked for, to the second",
    body.start.dateTime === "2026-09-14T03:00:00" && body.end.dateTime === "2026-09-14T04:00:00",
    `${body.start.dateTime} → ${body.end.dateTime}`);
  ok("  · carrying an id that makes a retry the same event, not a second one",
    body.transactionId === "nexspace-bk_9", body.transactionId);
  ok("  · no attendee list, which is what makes Graph send its own invitations",
    body.attendees === undefined, JSON.stringify(body.attendees));
  ok("  · and a way back to the room", JSON.stringify(body).includes(BOOKING.url));
}

// ---- with people on it -----------------------------------------------------------
{
  sent.length = 0;
  const guests = [
    { email: "somchai@company.test", name: "สมชาย" },
    { email: "client@outside.test", name: "client@outside.test" },
  ];
  await msPushEvent(user.id, BOOKING, guests);
  const body = JSON.parse(sent.find((s) => s.url.includes("graph.microsoft.com"))!.body);
  ok("a guest list goes on the event", body.attendees?.length === 2, JSON.stringify(body.attendees?.length));
  ok("  · with the address and the name",
    body.attendees[0].emailAddress.address === "somchai@company.test"
    && body.attendees[0].emailAddress.name === "สมชาย", JSON.stringify(body.attendees[0]));
  ok("  · each of them required, so the invitation is one",
    body.attendees.every((a: { type: string }) => a.type === "required"));
  // Graph says plainly that it sends the invitation itself whenever an event
  // has attendees, and that this cannot be turned off. No flag to pass and no
  // flag to forget — which is the opposite of Google.
  ok("  · and nothing asked for beyond that, because Graph sends them itself",
    !JSON.stringify(body).includes("sendUpdates"), "Graph mails attendees on its own");
}

// ---- what an answer means --------------------------------------------------------
{
  apiStatus = 409; apiAnswer = { error: { message: "A transaction with this id already exists" } };
  ok("an event already created by the same request is not an error",
    await msPushEvent(user.id, BOOKING) === null,
    "409 on the transaction id is the state that was wanted");
}
{
  apiStatus = 200; apiAnswer = {};
  ok("an event can be taken back out", await msDropEvent(user.id, "ev_1") === true);
  for (const status of [404, 410]) {
    apiStatus = status; apiAnswer = { error: { message: "Not Found" } };
    ok(`  · and one already gone (${status}) counts as removed`,
      await msDropEvent(user.id, "ev_1") === true);
  }
  apiStatus = 429; apiAnswer = { error: { message: "Too many requests" } };
  ok("  · but a real refusal is reported as one", await msDropEvent(user.id, "ev_1") === false);
}

// ---- the answers, in Graph's words and ours --------------------------------------
{
  await connect();
  apiStatus = 200;
  apiAnswer = {
    attendees: [
      { emailAddress: { address: "Somchai@Company.test" }, status: { response: "accepted" } },
      { emailAddress: { address: "no@outside.test" }, status: { response: "declined" } },
      { emailAddress: { address: "maybe@company.test" }, status: { response: "tentativelyAccepted" } },
      { emailAddress: { address: "quiet@company.test" }, status: { response: "notResponded" } },
      { emailAddress: { address: "host@company.test" }, status: { response: "organizer" } },
    ],
  };
  const said = await msReadReplies(user.id, "ev_9");
  const of = (e: string) => said?.find((a: { email: string }) => a.email === e)?.reply;
  ok("the answers come back", said?.length === 5, String(said?.length));
  ok("  · in the same four words Google's are translated into",
    of("somchai@company.test") === "accepted" && of("no@outside.test") === "declined"
    && of("maybe@company.test") === "tentative" && of("quiet@company.test") === "needsAction",
    JSON.stringify(said));
  ok("  · with the organiser counted as coming, since they called it",
    of("host@company.test") === "accepted");
  ok("  · and addresses lower-cased, since Graph echoes what was typed",
    said?.every((a: { email: string }) => a.email === a.email.toLowerCase()));
}
{
  apiStatus = 500; apiAnswer = { error: { message: "Backend error" } };
  ok("an event that cannot be read says nothing at all", await msReadReplies(user.id, "ev_9") === null,
    "an empty list would be read as everybody withdrawing");
  apiStatus = 200; apiAnswer = { attendees: [] };
  ok("  · an event with nobody on it is an empty list, not nothing",
    JSON.stringify(await msReadReplies(user.id, "ev_9")) === "[]");
}

// ---- the token that changes every time -------------------------------------------
{
  await connect();
  tokenAnswer = { access_token: "at_9", refresh_token: "rt_rotated" };
  await msAccessTokenFor(user.id);
  const row = await prisma.microsoftCalendar.findUnique({ where: { userId: user.id } });
  /**
   * Microsoft hands back a new refresh token on every use and retires the old
   * one. Missing that is a connection that works today and is silently dead the
   * next time the access token expires — hours later, with nothing to see.
   */
  ok("a rotated refresh token is kept", row?.refreshToken === "rt_rotated", String(row?.refreshToken));
}
{
  await connect();
  tokenAnswer = { error: "invalid_grant", error_description: "AADSTS70000: expired" };
  ok("a revoked grant returns nothing", await msAccessTokenFor(user.id) === null);
  ok("  · and is disconnected rather than retried forever",
    await prisma.microsoftCalendar.findUnique({ where: { userId: user.id } }) === null,
    "the person has to be told once, not have it fail quietly on every booking");
  tokenAnswer = { access_token: "at_1", refresh_token: "rt_1" };
}

await cleanUp();
console.log(`\n${pass} passed, ${fail} failed\n`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
