/**
 * When a repeating reminder actually goes off.
 *
 * Pure arithmetic over dates, and the only part of the feature where being
 * wrong is silent: every failure here is an email that arrives on the wrong day
 * or does not arrive at all, and neither leaves anything behind to notice.
 *
 *   npm run test:remind -w @nexspace/api
 */
import { reminderMoments } from "../src/calendar.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

/** a Thursday, ten in the morning */
const START = new Date("2026-09-17T10:00:00+07:00");
const LONG_AGO = new Date("2026-01-01T00:00:00+07:00");
const show = (ds: Date[]) =>
  ds.map((d) => d.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })).join(" | ");

console.log("\nwhen a repeating reminder goes off\n");

// ---- not repeating at all --------------------------------------------------------
{
  const at = reminderMoments({ minutes: 30, repeat: "none", times: 1 }, START, LONG_AGO);
  ok("one that does not repeat goes off once", at.length === 1, show(at));
  ok("  · thirty minutes before it starts", +at[0] === +START - 30 * 60_000, show(at));
  const asked = reminderMoments({ minutes: 30, repeat: "none", times: 5 }, START, LONG_AGO);
  ok("  · and asking for five of it changes nothing", asked.length === 1, show(asked));
}

// ---- daily -----------------------------------------------------------------------
{
  const at = reminderMoments({ minutes: 30, repeat: "daily", times: 3 }, START, LONG_AGO);
  ok("daily three times goes off three times", at.length === 3, show(at));
  ok("  · oldest first, which is the order they will be sent in",
    +at[0] < +at[1] && +at[1] < +at[2], show(at));
  ok("  · the last of them at the lead time that was chosen",
    +at[2] === +START - 30 * 60_000, show(at));
  ok("  · and each a day apart, at the same time of day",
    +at[1] - +at[0] === 86_400_000 && +at[2] - +at[1] === 86_400_000, show(at));
}

// ---- every working day -----------------------------------------------------------
{
  // Thursday back four working days is Wed, Tue, Mon — no weekend crossed yet,
  // which is worth having as the case that does not exercise the rule.
  const four = reminderMoments({ minutes: 30, repeat: "weekdays", times: 4 }, START, LONG_AGO);
  ok("four working days back does not reach a weekend", four.length === 4
    && four[0].getDay() === 1, show(four));

  // Five does. The fifth step lands on Sunday and has to keep going to Friday —
  // the first version of this test expected that of the fourth, which is the
  // assertion being wrong rather than the code.
  const at = reminderMoments({ minutes: 30, repeat: "weekdays", times: 5 }, START, LONG_AGO);
  ok("every working day steps over the weekend", at.length === 5, show(at));
  const days = at.map((d) => d.getDay());
  ok("  · so none of them lands on one", !days.includes(0) && !days.includes(6), show(at));
  ok("  · and the earliest is the Friday before, not the Sunday",
    days[0] === 5, show(at));
}

// ---- weekly ----------------------------------------------------------------------
{
  const at = reminderMoments({ minutes: 0, repeat: "weekly", times: 2 }, START, LONG_AGO);
  ok("weekly twice is a week apart", +at[1] - +at[0] === 7 * 86_400_000, show(at));
  ok("  · on the same weekday", at[0].getDay() === at[1].getDay(), show(at));
}

// ---- moments that were already gone when it was booked ---------------------------
{
  /**
   * A meeting booked an hour before it starts, with a reminder set to repeat
   * daily for three days. Two of those three moments are in the past already.
   * Sending them would be two emails at once about days that are over.
   */
  const madeAt = new Date(+START - 60 * 60_000);
  const at = reminderMoments({ minutes: 30, repeat: "daily", times: 3 }, START, madeAt);
  ok("a moment that had passed before the booking existed never happens",
    at.length === 1, show(at));
  ok("  · leaving the one that is still ahead", +at[0] === +START - 30 * 60_000, show(at));

  const tooLate = reminderMoments({ minutes: 30, repeat: "daily", times: 3 }, START,
    new Date(+START - 10 * 60_000));
  ok("  · and a booking made after even that is reminded of nothing",
    tooLate.length === 0, show(tooLate) || "none");
}

// ---- the ceiling -----------------------------------------------------------------
{
  const at = reminderMoments({ minutes: 0, repeat: "daily", times: 99 }, START, LONG_AGO);
  ok("no more copies than the ceiling, whatever is asked for", at.length <= 10, String(at.length));
  const none = reminderMoments({ minutes: 0, repeat: "daily", times: 0 }, START, LONG_AGO);
  ok("  · and never fewer than one", none.length === 1, String(none.length));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
