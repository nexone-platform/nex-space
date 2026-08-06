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

export const WORKSPACE = normalizeSlug(new URLSearchParams(location.search).get("w") ?? "");

/** label shown in the UI ("main" -> "NexSpace") */
export const workspaceLabel = () => (WORKSPACE === DEFAULT ? "NexSpace" : WORKSPACE);

/** shareable invite URL for the current workspace */
export const inviteLink = () =>
  `${location.origin}${location.pathname}?w=${encodeURIComponent(WORKSPACE)}`;

/** per-workspace localStorage key, so a guest's desk in one space doesn't leak to another */
export const wsKey = (key: string) => `${key}:${WORKSPACE}`;
