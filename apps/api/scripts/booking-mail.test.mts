/**
 * A room booking, on its way into somebody's real calendar.
 *
 * The feed this app publishes is fine for a standing subscription and no use
 * for news: Google refreshes an external .ics somewhere between eight and
 * twenty-four hours, on its own schedule, with no refresh button for anybody.
 * So a booking is also emailed, as a calendar invitation — which arrives now,
 * needs no OAuth, and is understood by Outlook and Gmail alike.
 *
 * What decides whether a client offers "accept / decline" rather than a file to
 * download is the MIME type of the part, not the bytes inside it. And a
 * cancellation only removes an event that was already accepted if it outranks
 * it. Both are easy to get wrong in a way nothing visible complains about, so
 * both are asserted here — against the request body, with fetch replaced, so
 * this needs no dev server, no API key, and cannot email anybody by accident.
 *
 *   npm run test:bookingmail -w @nexspace/api
 */
process.env.RESEND_API_KEY = "test-key-not-real";
process.env.MAIL_FROM = "NexSpace <no-reply@mail.example.test>";
process.env.BOOKING_TZ = "Asia/Bangkok";

import { pathToFileURL } from "url";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

type Attach = { filename: string; content: string; content_type: string };
type Payload = { html: string; text: string; subject: string; reply_to?: string[]; attachments?: Attach[] };

let sent: Payload | null = null;
(globalThis as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
  sent = JSON.parse(init.body) as Payload;
  return { ok: true, status: 200, text: async () => "" };
};

const HERE = dirname(fileURLToPath(import.meta.url));
const { sendBooking } = await import(pathToFileURL(resolve(HERE, "../src/mailer.ts")).href);
const { ics } = await import(pathToFileURL(resolve(HERE, "../src/calendar.ts")).href);

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const out = () => sent as Payload;
/** the calendar file as the recipient's client will see it */
const card = () => Buffer.from(out().attachments![0].content, "base64").toString("utf8");
/** unfold first: a Thai room name is folded mid-property and reads as broken otherwise */
const unfolded = () => card().replace(/\r\n /g, "");

const BOOKING = {
  id: "bk_1", title: "รีวิวสปรินต์", roomLabel: "ห้องประชุมใหญ่", hostName: "ชาลิสา",
  startsAt: new Date("2026-09-10T03:00:00Z"), endsAt: new Date("2026-09-10T04:00:00Z"),
  createdAt: new Date("2026-09-07T00:00:00Z"),
};
const HOST = { name: "ชาลิสา", email: "chalisa@company.test" };
const URL_ = "https://nexspace.example.test/?w=test&m=office";

console.log("\na booking, on its way into a real calendar\n");

await sendBooking({
  to: "them@example.test", toName: "สมชาย", space: "Test",
  booking: BOOKING, organizer: HOST, url: URL_, method: "REQUEST",
});

ok("an invitation carries a calendar file", !!out().attachments?.length,
  JSON.stringify(out().attachments?.map((a) => a.filename)));
ok("  · typed as an invitation, which is what offers accept and decline",
  out().attachments![0].content_type === "text/calendar; method=REQUEST; charset=utf-8",
  out().attachments![0].content_type);
ok("  · and the file agrees", unfolded().includes("METHOD:REQUEST"));
ok("  · standing, not cancelled", unfolded().includes("STATUS:CONFIRMED") && unfolded().includes("SEQUENCE:0"));
ok("the reader can get to the room from their calendar", unfolded().includes(`URL:${URL_}`),
  (/URL:[^\r\n]*/.exec(unfolded()) || ["none"])[0]);
ok("the host is the organiser, so a reply reaches a person",
  unfolded().includes("ORGANIZER;CN=ชาลิสา:mailto:chalisa@company.test"));
ok("  · and is the Reply-To on the email as well",
  JSON.stringify(out().reply_to) === '["chalisa@company.test"]', JSON.stringify(out().reply_to));
ok("the recipient is named as an attendee, so RSVP has somebody to be from",
  unfolded().includes("mailto:them@example.test") && unfolded().includes("RSVP=TRUE"));
ok("a Thai room name survives folding and base64",
  unfolded().includes("LOCATION:ห้องประชุมใหญ่"),
  (/LOCATION:[^\r\n]*/.exec(unfolded()) || ["none"])[0]);
ok("the time is in the reader's words, not just the file's",
  out().text.includes("10") && /09:|10:/.test(out().text), out().text.split("\n")[3] ?? "");
ok("  · and the subject says which room", out().subject.includes("ห้องประชุมใหญ่"), out().subject);

// ---- taking it back ---------------------------------------------------------
sent = null;
await sendBooking({
  to: "them@example.test", toName: "สมชาย", space: "Test",
  booking: BOOKING, organizer: HOST, url: URL_, method: "CANCEL",
});

ok("a cancellation is a calendar file too", !!out().attachments?.length);
ok("  · typed as one", out().attachments![0].content_type.includes("method=CANCEL"),
  out().attachments![0].content_type);
ok("  · and outranks the invitation it removes, or clients ignore it",
  unfolded().includes("SEQUENCE:1") && unfolded().includes("STATUS:CANCELLED"),
  (/SEQUENCE:\d/.exec(unfolded()) || ["none"])[0]);
ok("  · with the same UID, or it cancels nothing",
  unfolded().includes("UID:bk_1@nexspace"));
ok("  · and says so in words", out().subject.startsWith("ยกเลิก"), out().subject);
ok("  · without inviting anybody into a meeting that is off",
  !out().html.includes("เข้าห้อง "), "no join button");

// ---- the feed is a different thing and must stay one ------------------------
const feed = ics("Test", [
  { ...BOOKING, url: "https://nexspace.example.test/?w=test&m=office" },
  { ...BOOKING, id: "bk_2", url: "https://nexspace.example.test/?w=test&m=departments" },
], {}).replace(/\r\n /g, "");
ok("a subscribed feed is still PUBLISH, not an invitation to anything",
  feed.includes("METHOD:PUBLISH") && !feed.includes("METHOD:REQUEST"));
ok("  · and each event links to the map it is actually on",
  feed.includes("m=office") && feed.includes("m=departments"));
ok("  · with no organiser, since nobody is being asked to reply",
  !feed.includes("ORGANIZER"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
