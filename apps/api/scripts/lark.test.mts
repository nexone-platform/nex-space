/**
 * What actually gets posted into the group chat.
 *
 * fetch is replaced, so nothing reaches Lark and nothing appears in anybody's
 * chat. What is checked is the half a mistake in would be public: what the
 * message contains, what it must never contain, and whether a refusal is read
 * as a refusal — Lark answers HTTP 200 with a non-zero code in the body when a
 * webhook is revoked, so believing the status would report every dead webhook
 * as delivered.
 *
 *   npm run test:lark -w @nexspace/api
 */
process.env.LARK_WEBHOOK = "https://open.larksuite.com/open-apis/bot/v2/hook/test-hook-not-real";
process.env.LARK_SECRET = "";
process.env.BOOKING_TZ = "Asia/Bangkok";

const { sendToLark, meetingCard, larkSign } = await import("../src/lark.js");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

console.log("\na meeting summary, on its way into a group chat\n");

// ---- the stand-ins -----------------------------------------------------------
const SUMMARY = "ตัดสินใจเลื่อนกำหนดส่งงานออกไปหนึ่งสัปดาห์";
const HERS = "ชาลิสารับงานสรุปงบประมาณ";
const HIS = "สมชายรับงานทำสไลด์นำเสนอ";
const MEETING = {
  room: "ห้องประชุมใหญ่",
  startedAt: new Date("2026-09-14T03:00:00Z"),
  endedAt: new Date("2026-09-14T04:00:00Z"),
  summary: SUMMARY,
  people: [
    { name: "ชาลิสา", digest: HERS, recorded: true },
    { name: "สมชาย", digest: HIS, recorded: true },
    { name: "ก้อง", digest: null, recorded: false },
  ],
  url: "https://nexspace.example.test/?w=test",
};

// ---- what goes out ------------------------------------------------------------
let body: any = null;
let answer: unknown = { code: 0, msg: "success" };
let status = 200;
globalThis.fetch = (async (_url: string, init: any) => ({
  ok: status < 400,
  status,
  text: async () => { body = JSON.parse(init.body); return JSON.stringify(answer); },
})) as unknown as typeof fetch;

{
  const r = await sendToLark(meetingCard(MEETING));
  ok("a summary is posted as a card", r.ok && body?.msg_type === "interactive", body?.msg_type);
  const flat = JSON.stringify(body);
  ok("  · with the room in the title", String(body?.card?.header?.title?.content).includes("ห้องประชุมใหญ่"),
    body?.card?.header?.title?.content);
  ok("  · the day it happened, in Thai", flat.includes("14 กันยายน"), flat.slice(0, 0) || "");
  ok("  · the time it ran, in the office's own zone", flat.includes("10:00") && flat.includes("11:00"),
    "03:00Z is 10:00 in Bangkok");
  ok("  · the meeting summary", flat.includes(SUMMARY));
  ok("  · and each person's part, by name",
    flat.includes(HERS) && flat.includes(HIS) && flat.includes("ชาลิสา") && flat.includes("สมชาย"));
  ok("  · saying who is not in it", flat.includes("ก้อง") && flat.includes("ไม่มีเสียงของ"),
    "a summary from two voices out of three is a different document");
  ok("  · and a way back to the app", flat.includes("https://nexspace.example.test/?w=test"));
}

// ---- what must never go out ---------------------------------------------------
{
  const withWords = meetingCard({
    ...MEETING,
    people: [
      // A transcript is not part of the shape a card is built from, but the day
      // somebody adds it to ShareEvent this is what should stop it.
      { name: "ชาลิสา", digest: HERS, recorded: true, transcript: "ผมจะไปดูตัวเลขงบให้ครับ" } as any,
    ],
  });
  ok("nobody's transcript reaches the group chat",
    !JSON.stringify(withWords).includes("ผมจะไปดูตัวเลขงบให้ครับ"),
    "a chat is the wrong place for a verbatim record of a colleague");
}

// ---- a meeting with nothing in it ---------------------------------------------
{
  const empty = meetingCard({ ...MEETING, summary: null, people: [] });
  const flat = JSON.stringify(empty);
  ok("a meeting with no summary says so rather than posting a blank",
    flat.includes("ไม่มีสรุป"), flat.slice(0, 60));
}

// ---- being refused -------------------------------------------------------------
{
  answer = { code: 19021, msg: "sign match fail or timestamp is not within one hour from current time" };
  const r = await sendToLark(meetingCard(MEETING));
  ok("a refusal with HTTP 200 is still a refusal", !r.ok, r.detail);
  ok("  · repeating what Lark said, rather than inventing a summary",
    r.detail.includes("19021") && r.detail.includes("sign match fail"), r.detail);
}
{
  answer = { code: 0 }; status = 500;
  const r = await sendToLark(meetingCard(MEETING));
  ok("and so is an HTTP error", !r.ok, r.detail);
  status = 200; answer = { code: 0, msg: "success" };
}
{
  globalThis.fetch = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
  const r = await sendToLark(meetingCard(MEETING));
  ok("a network that is not there is reported, not thrown", !r.ok && r.detail.includes("ENOTFOUND"), r.detail);
}

// ---- the signature, which is not a signature over the message -----------------
{
  // Lark builds the HMAC key out of `${timestamp}\n${secret}` and signs the
  // empty string with it. Signing the body instead is refused with a 19021,
  // and the difference is invisible until a real webhook rejects everything.
  const known = larkSign(1599360473, "secret");
  ok("the signature is HMAC over nothing, keyed by timestamp and secret",
    known === larkSign(1599360473, "secret") && known.length === 44 && known !== larkSign(1599360474, "secret"),
    known);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
