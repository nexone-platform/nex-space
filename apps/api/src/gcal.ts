import { prisma } from "./db.js";

/**
 * Writing a booking into somebody's own Google Calendar.
 *
 * The feed beside this is a subscription, which Google re-reads on its own
 * schedule somewhere between eight and twenty-four hours — fine for seeing the
 * month, useless for "I booked a room at ten past nine". This is the other
 * half: with one person's permission, the event is put into their calendar
 * within the second.
 *
 * Per person and never the whole domain. Each individual grants
 * `calendar.events`, which can write events and cannot read anything else, and
 * what comes back is stored against that one account. Nobody's calendar
 * becomes reachable because a colleague connected theirs.
 *
 * Nothing here decides whether somebody should be in a meeting. An event is
 * written for a person who said they are coming, and removed when they say
 * they are not — the same list the invitation email uses.
 */

const ID = process.env.GOOGLE_CLIENT_ID || "";
const SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
export const gcalEnabled = !!(ID && SECRET);

/**
 * The narrowest scope that can do the job.
 *
 * `calendar.events` writes events and reads nothing else — not the free/busy
 * of other calendars, not the list of calendars, not settings. `calendar`
 * would cover all of it and is the one people reach for.
 */
export const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const API = "https://www.googleapis.com/calendar/v3";
const TIMEOUT_MS = Number(process.env.GCAL_TIMEOUT_MS || 15_000);
const TZ = process.env.BOOKING_TZ || "Asia/Bangkok";

// ---- tokens --------------------------------------------------------------------

/**
 * An access token for one person, minted from the refresh token each time.
 *
 * Not cached. An access token lives an hour and a booking is a few requests a
 * day, so a cache here would be a second place for a stale credential to live
 * for the sake of a round trip nobody is waiting on.
 *
 * `invalid_grant` means the person revoked the grant, or changed their
 * password, or the token expired from disuse. It is not a thing to retry: the
 * row is cleared so the app stops pretending there is a connection, and says
 * so where they can see it.
 */
export async function accessTokenFor(userId: string): Promise<string | null> {
  const row = await prisma.googleCalendar.findUnique({ where: { userId } });
  if (!row) return null;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ID, client_secret: SECRET,
      refresh_token: row.refreshToken, grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => { throw new Error(`could not reach Google: ${(e as Error).message}`); });

  const tok = (await r.json().catch(() => ({}))) as
    { access_token?: string; error?: string; error_description?: string };
  if (tok.access_token) return tok.access_token;

  const why = tok.error_description || tok.error || `HTTP ${r.status}`;
  if (tok.error === "invalid_grant") {
    await prisma.googleCalendar.delete({ where: { userId } }).catch(() => {});
    console.warn(`[gcal] ${row.email}: the grant is gone (${why}) — disconnected`);
    return null;
  }
  await noteFailure(userId, why);
  return null;
}

async function noteFailure(userId: string, detail: string) {
  await prisma.googleCalendar
    .update({ where: { userId }, data: { lastError: detail.slice(0, 300), lastErrorAt: new Date() } })
    .catch(() => {});
}

// ---- the event ------------------------------------------------------------------

export type BookingEvent = {
  id: string;
  title: string;
  roomLabel: string;
  hostName: string;
  startsAt: Date;
  endsAt: Date;
  /** the room, in the app */
  url?: string;
};

/**
 * What a booking looks like as a Google event.
 *
 * The times go as a wall clock plus a named zone rather than as UTC. Both are
 * legal; the difference shows when somebody travels, and an office booking is
 * a thing that happens at ten in that office.
 *
 * `iCalUID` is the same id the .ics feed uses. Anybody subscribed to the feed
 * *and* connected here would otherwise see the meeting twice — Google collapses
 * two events that agree on it.
 */
function asEvent(b: BookingEvent) {
  return {
    summary: b.title,
    location: b.roomLabel,
    description: [`จองโดย ${b.hostName}`, ...(b.url ? ["", b.url] : [])].join("\n"),
    start: { dateTime: b.startsAt.toISOString(), timeZone: TZ },
    end: { dateTime: b.endsAt.toISOString(), timeZone: TZ },
    iCalUID: `${b.id}@nexspace`,
    source: b.url ? { title: "NexSpace", url: b.url } : undefined,
    // Whoever is reading this calendar is the only person in it. The invitation
    // to everybody else is their own event in their own calendar — sending
    // Google an attendee list would make it mail them a second invitation.
    attendees: undefined,
    reminders: { useDefault: true },
  };
}

/** a request to one person's calendar, with the failure recorded rather than thrown */
async function call(
  userId: string,
  path: string,
  init: RequestInit & { method: string },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; detail: string }> {
  const token = await accessTokenFor(userId);
  if (!token) return { ok: false, status: 401, body: {}, detail: "no connected calendar" };

  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => { throw new Error(`could not reach Google: ${(e as Error).message}`); });

  const said = await r.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try { body = said ? JSON.parse(said) : {}; } catch { /* not JSON */ }
  const err = body.error as { message?: string } | undefined;
  const detail = err?.message || said.slice(0, 200) || `HTTP ${r.status}`;
  if (!r.ok) await noteFailure(userId, detail);
  return { ok: r.ok, status: r.status, body, detail };
}

/**
 * Put this booking in this person's calendar, or take it out.
 *
 * Both are best-effort and neither may fail the thing they are about: a room is
 * held whether or not Google answered. What a failure does is get written down
 * — against the connection, where the person can read it — rather than thrown
 * at a route that was doing something else.
 */
export async function pushEvent(userId: string, b: BookingEvent): Promise<string | null> {
  const row = await prisma.googleCalendar.findUnique({ where: { userId } });
  if (!row) return null;
  const r = await call(userId, `/calendars/${encodeURIComponent(row.calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(asEvent(b)),
  });
  if (r.ok) {
    await prisma.googleCalendar
      .update({ where: { userId }, data: { lastError: null, lastErrorAt: null } })
      .catch(() => {});
    return String(r.body.id ?? "") || null;
  }
  // 409 is this exact meeting already being in that calendar, which is the
  // state that was wanted. Everything else is worth saying out loud.
  if (r.status === 409) return null;
  console.warn(`[gcal] could not add "${b.title}" for ${row.email}: ${r.detail}`);
  return null;
}

export async function dropEvent(userId: string, eventId: string): Promise<boolean> {
  const row = await prisma.googleCalendar.findUnique({ where: { userId } });
  if (!row || !eventId) return false;
  const r = await call(userId, `/calendars/${encodeURIComponent(row.calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
  // Already gone is the state that was wanted, however it got there — somebody
  // deleting it in Google is not a failure to delete it.
  if (r.ok || r.status === 404 || r.status === 410) return true;
  console.warn(`[gcal] could not remove an event for ${row.email}: ${r.detail}`);
  return false;
}

/** does the connection still work? — asked without writing anything */
export async function gcalCheck(userId: string): Promise<{ ok: boolean; detail: string }> {
  const row = await prisma.googleCalendar.findUnique({ where: { userId } });
  if (!row) return { ok: false, detail: "no calendar connected" };
  const r = await call(userId, `/calendars/${encodeURIComponent(row.calendarId)}`, { method: "GET" });
  return r.ok
    ? { ok: true, detail: `connected as ${row.email}` }
    : { ok: false, detail: r.detail };
}
