import { prisma } from "./db.js";

/**
 * Writing a booking into somebody's own Outlook calendar.
 *
 * The same shape as gcal.ts, against Microsoft Graph, and deliberately a second
 * file rather than one module with a provider switch: the two APIs disagree
 * about nearly every detail that matters — where the token comes from, how a
 * time is written, what an attendee's answer is called — and a file that tried
 * to say both would say each of them badly.
 *
 * Per person and never the whole tenant. Each individual grants
 * `Calendars.ReadWrite` for their own mailbox and can take it back, and there
 * is no path to a calendar nobody connected because there is no token for one.
 */

const ID = process.env.MS_CLIENT_ID || "";
const SECRET = process.env.MS_CLIENT_SECRET || "";
/**
 * Which directory signs people in.
 *
 * `common` takes both a work account and a personal one, which is the setting
 * that needs no decision up front. A company that wants only its own people
 * puts its tenant id here, and then nobody else's account can even be offered.
 */
const TENANT = (process.env.MS_TENANT || "common").trim();

export const msEnabled = !!(ID && SECRET);

/**
 * The narrowest set that can do the job.
 *
 * `Calendars.ReadWrite` is the mailbox's own calendar and nothing else — not
 * mail, not files, not the directory. `offline_access` is what makes a refresh
 * token exist at all; without it the server can do nothing an hour from now.
 * `User.Read` is only to learn which account was connected, so it can be shown
 * back to the person who connected it.
 */
export const MS_SCOPE = "offline_access Calendars.ReadWrite User.Read";

const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = Number(process.env.MS_TIMEOUT_MS || 15_000);

export const msAuthUrl = (params: URLSearchParams) =>
  `https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/oauth2/v2.0/authorize?${params}`;
const TOKEN_URL = `https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/oauth2/v2.0/token`;

// ---- tokens --------------------------------------------------------------------

/**
 * Exchange a code, or a refresh token, for an access token.
 *
 * Microsoft rotates the refresh token on every use: each response carries a new
 * one, and the old one stops working. Storing the new one is not an
 * optimisation — miss it once and the connection is dead the next time the
 * current token expires, silently, hours later.
 */
async function tokenCall(body: Record<string, string>) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ID, client_secret: SECRET, ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => { throw new Error(`could not reach Microsoft: ${(e as Error).message}`); });
  return (await r.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; scope?: string;
    error?: string; error_description?: string;
  };
}

export async function msExchangeCode(code: string, redirectUri: string) {
  return tokenCall({
    grant_type: "authorization_code", code, redirect_uri: redirectUri, scope: MS_SCOPE,
  });
}

/**
 * An access token for one person.
 *
 * `invalid_grant` means the grant is gone — revoked, or the password changed,
 * or it expired from disuse. Not a thing to retry: the row goes, so the app
 * stops claiming there is a connection, and says so where they can see it.
 */
export async function msAccessTokenFor(userId: string): Promise<string | null> {
  const row = await prisma.microsoftCalendar.findUnique({ where: { userId } });
  if (!row) return null;

  const tok = await tokenCall({
    grant_type: "refresh_token", refresh_token: row.refreshToken, scope: MS_SCOPE,
  });
  if (tok.access_token) {
    // The rotated one, kept. The old refresh token is already dead.
    if (tok.refresh_token && tok.refresh_token !== row.refreshToken) {
      await prisma.microsoftCalendar
        .update({ where: { userId }, data: { refreshToken: tok.refresh_token } })
        .catch(() => {});
    }
    return tok.access_token;
  }

  const why = tok.error_description?.split("\n")[0] || tok.error || "no token came back";
  if (tok.error === "invalid_grant") {
    await prisma.microsoftCalendar.delete({ where: { userId } }).catch(() => {});
    console.warn(`[mscal] ${row.email}: the grant is gone (${why}) — disconnected`);
    return null;
  }
  await noteFailure(userId, why);
  return null;
}

async function noteFailure(userId: string, detail: string) {
  await prisma.microsoftCalendar
    .update({ where: { userId }, data: { lastError: detail.slice(0, 300), lastErrorAt: new Date() } })
    .catch(() => {});
}

// ---- the event ------------------------------------------------------------------

export type MsBookingEvent = {
  id: string;
  title: string;
  roomLabel: string;
  hostName: string;
  startsAt: Date;
  endsAt: Date;
  url?: string;
};
export type MsGuest = { email: string; name: string };

/**
 * What a booking looks like as an Outlook event.
 *
 * The times go as UTC rather than as a named zone. Graph speaks Windows zone
 * names by default and IANA ones only when asked, and "Asia/Bangkok" against
 * the wrong dialect is a meeting an hour out with nothing to show for it. UTC
 * is the one name both dialects spell the same, and the instant is the instant.
 *
 * `transactionId` is what stops a retry becoming a second meeting: Graph
 * refuses a create that repeats one it has already seen.
 */
function asEvent(b: MsBookingEvent, guests: MsGuest[] = []) {
  const stamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "");
  return {
    subject: b.title,
    body: {
      contentType: "Text",
      content: [`จองโดย ${b.hostName}`, ...(b.url ? ["", `เข้าห้อง: ${b.url}`] : [])].join("\n"),
    },
    start: { dateTime: stamp(b.startsAt), timeZone: "UTC" },
    end: { dateTime: stamp(b.endsAt), timeZone: "UTC" },
    location: { displayName: b.roomLabel },
    /**
     * The guest list, on the host's copy and on nothing else.
     *
     * Graph sends the invitation itself the moment an event has attendees, and
     * says plainly that this cannot be switched off. That is the behaviour
     * wanted — Outlook's own invitation, with the accept and decline a person
     * expects — and it is also why this must never go on anybody else's copy:
     * every connected calendar would invite everybody all over again.
     */
    ...(guests.length
      ? {
        attendees: guests.map((g) => ({
          emailAddress: { address: g.email, name: g.name },
          type: "required",
        })),
      }
      : {}),
    transactionId: `nexspace-${b.id}`,
  };
}

async function call(
  userId: string,
  path: string,
  init: RequestInit & { method: string },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; detail: string }> {
  const token = await msAccessTokenFor(userId);
  if (!token) return { ok: false, status: 401, body: {}, detail: "no connected calendar" };

  const r = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => { throw new Error(`could not reach Microsoft: ${(e as Error).message}`); });

  const said = await r.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try { body = said ? JSON.parse(said) : {}; } catch { /* not JSON */ }
  const err = body.error as { message?: string; code?: string } | undefined;
  const detail = err?.message || said.slice(0, 200) || `HTTP ${r.status}`;
  if (!r.ok) await noteFailure(userId, detail);
  return { ok: r.ok, status: r.status, body, detail };
}

/** which account this is, asked once when it is connected */
export async function msWhoIs(accessToken: string): Promise<string> {
  const r = await fetch(`${GRAPH}/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!r?.ok) return "";
  const me = (await r.json().catch(() => ({}))) as { mail?: string; userPrincipalName?: string };
  // A work account has `mail`; a personal one often has only the principal name,
  // which is the address anyway.
  return String(me.mail || me.userPrincipalName || "").toLowerCase();
}

export async function msPushEvent(
  userId: string,
  b: MsBookingEvent,
  guests: MsGuest[] = [],
): Promise<string | null> {
  const row = await prisma.microsoftCalendar.findUnique({ where: { userId } });
  if (!row) return null;
  const r = await call(userId, "/me/events", {
    method: "POST",
    body: JSON.stringify(asEvent(b, guests)),
  });
  if (r.ok) {
    await prisma.microsoftCalendar
      .update({ where: { userId }, data: { lastError: null, lastErrorAt: null } })
      .catch(() => {});
    return String(r.body.id ?? "") || null;
  }
  // 409 is Graph refusing a transactionId it has seen: the meeting is already
  // in that calendar, which is the state that was wanted.
  if (r.status === 409) return null;
  console.warn(`[mscal] could not add "${b.title}" for ${row.email}: ${r.detail}`);
  return null;
}

/**
 * Take it back out.
 *
 * Deleting the host's copy is the cancellation Outlook mails to everybody who
 * was invited; deleting anybody else's is that person leaving, and tells
 * nobody. Graph decides which of the two it is from whose calendar the event
 * is in, so there is no flag to pass — unlike Google, where forgetting one
 * means the guests are never told.
 */
export async function msDropEvent(userId: string, eventId: string): Promise<boolean> {
  const row = await prisma.microsoftCalendar.findUnique({ where: { userId } });
  if (!row || !eventId) return false;
  const r = await call(userId, `/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  if (r.ok || r.status === 404 || r.status === 410) return true;
  console.warn(`[mscal] could not remove an event for ${row.email}: ${r.detail}`);
  return false;
}

/**
 * What the guests answered, read off the host's copy.
 *
 * Graph's words are its own: accepted, declined, tentativelyAccepted,
 * notResponded, none, organizer. They are translated here into the four this
 * app already uses for Google, so that everything downstream — the card, the
 * "who is coming" list, the reminder — reads one vocabulary rather than two.
 *
 * Null when it cannot be read at all, which is different from an empty list
 * and must not be mistaken for everybody withdrawing.
 */
export async function msReadReplies(
  userId: string,
  eventId: string,
): Promise<{ email: string; reply: string }[] | null> {
  const row = await prisma.microsoftCalendar.findUnique({ where: { userId } });
  if (!row || !eventId) return null;
  const r = await call(userId, `/me/events/${encodeURIComponent(eventId)}?$select=attendees`, {
    method: "GET",
  });
  if (!r.ok) {
    if (r.status !== 404 && r.status !== 410) {
      console.warn(`[mscal] could not read replies for ${row.email}: ${r.detail}`);
    }
    return null;
  }
  const people = (r.body.attendees ?? []) as {
    emailAddress?: { address?: string };
    status?: { response?: string };
  }[];
  const asOurs: Record<string, string> = {
    accepted: "accepted",
    declined: "declined",
    tentativelyAccepted: "tentative",
    notResponded: "needsAction",
    none: "needsAction",
    organizer: "accepted",
  };
  return people
    .filter((a) => a.emailAddress?.address)
    .map((a) => ({
      email: String(a.emailAddress!.address).toLowerCase(),
      reply: asOurs[String(a.status?.response || "none")] ?? "needsAction",
    }));
}

/** does the connection still work? — asked without writing anything */
export async function msCheck(userId: string): Promise<{ ok: boolean; detail: string }> {
  const row = await prisma.microsoftCalendar.findUnique({ where: { userId } });
  if (!row) return { ok: false, detail: "no calendar connected" };
  const r = await call(userId, "/me/calendar", { method: "GET" });
  return r.ok
    ? { ok: true, detail: `connected as ${row.email}` }
    : { ok: false, detail: r.detail };
}
