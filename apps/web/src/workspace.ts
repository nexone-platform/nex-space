// Which workspace (company / community) this tab is in.
//
// The workspace is carried in the URL as ?w=<slug>, so an invite link is just
// the app URL with that slug — anyone who opens it lands in the same space.
// Everything that must not leak between workspaces (the Colyseus room, the
// LiveKit room, claimed desks) is keyed off this value.

const DEFAULT = "main";

/** keep slugs short and URL/room-name safe */
export function normalizeSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").slice(0, 32) || DEFAULT;
}

const param = new URLSearchParams(location.search).get("w");

/** true when the URL explicitly names a workspace (i.e. an invite link) */
export const HAS_WORKSPACE_PARAM = !!param;

export const WORKSPACE = normalizeSlug(param ?? "");

export const IS_DEFAULT_WORKSPACE = WORKSPACE === DEFAULT;

/** label shown in the UI ("main" -> "NexSpace"); replaced by the real name once known */
export const workspaceLabel = () => (IS_DEFAULT_WORKSPACE ? "NexSpace" : WORKSPACE);

/** switch workspace by reloading with the new slug (constants above are read once) */
export const gotoWorkspace = (slug: string) => {
  location.href = `${location.origin}${location.pathname}?w=${encodeURIComponent(normalizeSlug(slug))}`;
};

/**
 * The invite code an invite link is carrying, as ?join=<code>.
 *
 * Read from the URL and never cached — the code is what an owner replaces to
 * revoke an old link, and a copy kept in this browser would outlive that.
 */
export const JOIN_CODE = new URLSearchParams(location.search).get("join") ?? "";

/**
 * An emailed invitation, as ?invite=<token>.
 *
 * Different from JOIN_CODE above in the way that matters to the person holding
 * it: this one was addressed to their email and only works for that address, so
 * the sign-in screen can say who asked and which space before they commit to
 * anything.
 */
export const INVITE_TOKEN = new URLSearchParams(location.search).get("invite") ?? "";

/**
 * A shareable invite URL.
 *
 * Without the code this is only a link to the front door: whoever opens it is
 * let in as a visitor if the space allows guests, refused outright if it does
 * not, and in neither case do they become a member — which is what the button
 * offering it says it does. The code is the invitation; the slug is only the
 * address.
 */
export const inviteLink = (code?: string) =>
  `${location.origin}${location.pathname}?w=${encodeURIComponent(WORKSPACE)}`
  + (code ? `&join=${encodeURIComponent(code)}` : "");

/**
 * A guest pass carried as ?g=<code>. Deliberately read from the URL only and
 * never cached: the pass is what an admin revokes, so a copy kept in this
 * browser would outlive the revocation.
 */
export const GUEST_CODE = new URLSearchParams(location.search).get("g") ?? "";

/** the link handed to one named visitor — the pass rides along with the slug */
export const guestLinkFor = (slug: string, code: string) =>
  `${location.origin}${location.pathname}?w=${encodeURIComponent(normalizeSlug(slug))}`
  + `&g=${encodeURIComponent(code)}`;

// ---- which map ----
// A space may hold several. The URL names one so a link can point at a floor,
// and so a portal has somewhere to send you; absent means the landing map.

/** the map this tab is on, "" for whichever the space lands people on */
export const MAP_SLUG = (new URLSearchParams(location.search).get("m") ?? "")
  .toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);

/** where a portal put you down, as tiles — read once and never remembered */
export const ARRIVE_AT = (() => {
  const raw = new URLSearchParams(location.search).get("at") ?? "";
  const m = /^([0-9]{1,3}),([0-9]{1,3})$/.exec(raw);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
})();

/**
 * Walk to another map of this space.
 *
 * A reload rather than a swap: the scene reads its world once, at import time,
 * and rebuilding a live Phaser scene around a different map is a far larger
 * change than changing floors is worth. Gather shows a transition here too.
 */
export const gotoMap = (slug: string, at?: { x: number; y: number }) => {
  const q = new URLSearchParams();
  if (!IS_DEFAULT_WORKSPACE || HAS_WORKSPACE_PARAM) q.set("w", WORKSPACE);
  if (slug) q.set("m", slug);
  if (at) q.set("at", `${Math.floor(at.x)},${Math.floor(at.y)}`);
  if (GUEST_CODE) q.set("g", GUEST_CODE);
  location.href = `${location.origin}${location.pathname}?${q}`;
};

/** per-workspace localStorage key, so a guest's desk in one space doesn't leak to another */
export const wsKey = (key: string) => `${key}:${WORKSPACE}`;

/** same, but for a workspace other than the current page's (e.g. before navigating there) */
export const wsKeyFor = (slug: string, key: string) => `${key}:${normalizeSlug(slug)}`;

// ---- map theme ----
// The scene must choose its layout before it can await anything, so the
// workspace's theme is cached here and refreshed from the API afterwards.
const THEME_KEY = "nexspace-ws-theme";

export const cachedTheme = () => {
  try { return localStorage.getItem(wsKey(THEME_KEY)) ?? ""; } catch { return ""; }
};

export const rememberTheme = (slug: string, id: string) => {
  try { localStorage.setItem(wsKeyFor(slug, THEME_KEY), id); } catch { /* private mode */ }
};

/** a `?theme=` in the URL previews a layout for this visit only */
export const themeOverride = () => new URLSearchParams(location.search).get("theme") ?? "";
