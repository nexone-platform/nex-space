/**
 * Rooms held for a while, and the file that gets them into a real calendar.
 *
 * The booking half is ordinary. The interesting half is that the way out is an
 * .ics feed rather than a Google integration: writing to somebody's Google
 * Calendar needs the `calendar` scope, which Google treats as sensitive and
 * will not grant to an unverified app — that is a review with a privacy policy
 * and a demo video attached, and it is the operator's to run, not ours. A
 * subscribable feed needs none of it and is read by Google Calendar, Outlook
 * and Apple Calendar alike.
 */
import { createHmac, randomBytes } from "crypto";

/** the shortest meeting worth holding a room for */
export const MIN_MINUTES = 5;
/** the longest. A day-long booking is a room being taken, not a meeting. */
export const MAX_MINUTES = Number(process.env.BOOKING_MAX_MINUTES || 8 * 60);
/** how far ahead anybody may reach */
export const MAX_DAYS_AHEAD = Number(process.env.BOOKING_MAX_DAYS || 90);
/**
 * How late a start may be and still count as "now".
 *
 * Filling in a form takes a minute, and a booking that is refused because the
 * start time went past while you typed is a booking form that fights you.
 */
export const GRACE_MS = 5 * 60 * 1000;

const MIN_MS = 60 * 1000;

export type When = { startsAt: Date; endsAt: Date };

/**
 * Is this a time somebody may hold a room for?
 *
 * Returns the complaint, or null when it is fine. A sentence rather than a
 * code, because every one of these is shown to the person who typed it.
 */
export function checkWhen(startsAt: Date, endsAt: Date, now = Date.now()): string | null {
  if (isNaN(+startsAt) || isNaN(+endsAt)) return "those are not times";
  if (+endsAt <= +startsAt) return "it has to end after it starts";

  const minutes = (+endsAt - +startsAt) / MIN_MS;
  if (minutes < MIN_MINUTES) return `a booking is at least ${MIN_MINUTES} minutes`;
  if (minutes > MAX_MINUTES) return `a booking is at most ${MAX_MINUTES / 60} hours`;

  if (+startsAt < now - GRACE_MS) return "that time has already passed";
  if (+startsAt > now + MAX_DAYS_AHEAD * 24 * 60 * MIN_MS)
    return `you can book up to ${MAX_DAYS_AHEAD} days ahead`;
  return null;
}

/**
 * Do two spans of time collide?
 *
 * Touching is not colliding: a meeting ending at 10:00 and one starting at
 * 10:00 are back to back, which is how rooms are actually used.
 */
export const overlaps = (a: When, b: When) => +a.startsAt < +b.endsAt && +b.startsAt < +a.endsAt;

/** the key that opens one space's feed — long-lived, and rotatable on its own */
export const newCalendarKey = () => randomBytes(18).toString("base64url");

/**
 * A short signature over a booking id, for the single-event download.
 *
 * The feed has its own key; this is for "add this one to my calendar", which
 * should not hand out the key to everything.
 */
export const eventSig = (secret: Buffer | string, id: string) =>
  createHmac("sha256", secret).update(`ics:${id}`).digest("base64url").slice(0, 24);

// ---- the file itself ---------------------------------------------------------

/** RFC 5545 wants CRLF, and a comma or a semicolon in a title is not a delimiter */
const esc = (v: string) =>
  String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** 20260827T093000Z — always UTC, so no calendar has to guess our timezone */
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Fold at 75 octets, counted in bytes rather than characters.
 *
 * A Thai room name is three bytes a character, so a line that looks short is
 * not, and a fold placed mid-character produces a file some calendars refuse
 * and others render as mojibake.
 */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    // 75 on the first line, 74 after (the leading space counts toward the limit)
    let take = Math.min(out.length === 0 ? 75 : 74, bytes.length - start);
    // never split a UTF-8 sequence: back off while the next byte is a continuation
    while (take > 1 && (bytes[start + take] & 0xc0) === 0x80) take--;
    out.push((out.length ? " " : "") + bytes.subarray(start, start + take).toString("utf8"));
    start += take;
  }
  return out.join("\r\n");
}

export type IcsEvent = {
  id: string;
  title: string;
  roomLabel: string;
  hostName: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
};

/** one VCALENDAR holding however many events were handed in */
export function ics(name: string, events: IcsEvent[], now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NexSpace//Office Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    // Ask subscribers not to hammer us. Advisory, and honoured by most.
    "X-PUBLISHED-TTL:PT30M",
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@nexspace`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(e.startsAt)}`,
      `DTEND:${stamp(e.endsAt)}`,
      `SUMMARY:${esc(e.title)}`,
      `LOCATION:${esc(e.roomLabel)}`,
      `DESCRIPTION:${esc(`จองโดย ${e.hostName}`)}`,
      `CREATED:${stamp(e.createdAt)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
