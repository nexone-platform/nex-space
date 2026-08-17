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

/** shareable invite URL for the current workspace */
export const inviteLink = () =>
  `${location.origin}${location.pathname}?w=${encodeURIComponent(WORKSPACE)}`;

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
