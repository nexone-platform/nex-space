// Where this tab's world comes from.
//
// It used to come from `pickTheme()` at import time, because the scene had to
// choose a layout before it could await anything. That forced a guess from a
// localStorage cache, and a page reload whenever the guess turned out wrong —
// which is what you saw on a first visit to somebody else's space.
//
// Now the map is fetched before the scene module is even imported, so there is
// nothing to guess and nothing to reload. It also means a map no longer has to
// be one of ours: the API can hand back a stored one, made rather than written.

import { THEMES, classicTheme, type MapTheme } from "./mapThemes";
import { themeFromDoc, mapDocProblem } from "./mapFormat";
import { WORKSPACE, themeOverride, cachedTheme, rememberTheme } from "../workspace";
import { API } from "../api";

/**
 * The API is on the other side of a network, and a space that will not open
 * because a request is hanging is worse than one that opens on last visit's
 * layout. Four seconds is well past a healthy answer and well short of a person
 * deciding the app is broken.
 */
const PATIENCE_MS = 4000;

let resolved: MapTheme | null = null;
/** how we got here, for the boot log — a silent fallback is the confusing kind */
let origin = "";

/** the built-in this browser would fall back to with no answer from anyone */
const stock = () => THEMES[cachedTheme()] ?? classicTheme;

/**
 * Fetch the space's map, once, before anything renders.
 *
 * Every path returns a usable world. There is no failure mode where the app
 * comes up without a map, because the stock layouts are compiled in and one of
 * them is always available — the worst case is being on the wrong one until
 * the next reload, which is exactly where this code started.
 */
export async function loadMap(): Promise<MapTheme> {
  if (resolved) return resolved;

  // A ?theme= preview is for looking at one of ours; it deliberately never
  // asks the server, so it works on a space that has a stored map too.
  const preview = themeOverride();
  if (preview && THEMES[preview]) {
    origin = `preview ?theme=${preview}`;
    return (resolved = THEMES[preview]);
  }

  try {
    const r = await fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}/map`, {
      signal: AbortSignal.timeout(PATIENCE_MS),
    });
    if (r.ok) {
      const d = await r.json();
      if (d?.map) {
        // Checked on the way in as well as on the way out. The API validates
        // before it stores, but a row written by an older format, or by a
        // future one, would still arrive here — and a half-valid map draws a
        // floor with no walls, which reads as the app being broken rather than
        // as the map being wrong.
        const problem = mapDocProblem(d.map);
        if (problem) {
          console.warn(`[map] the stored map for "${WORKSPACE}" is not readable (${problem}) — using the built-in`);
        } else {
          origin = `stored map "${d.map.id}"`;
          return (resolved = themeFromDoc(d.map));
        }
      }
      const id: string = d?.builtin || "";
      if (THEMES[id]) {
        // Remembered so the next boot is right even with no network at all.
        rememberTheme(WORKSPACE, id);
        origin = `built-in "${id}"`;
        return (resolved = THEMES[id]);
      }
    }
  } catch (e) {
    console.warn(`[map] could not ask the server which map "${WORKSPACE}" uses:`, e);
  }

  resolved = stock();
  origin = `built-in "${resolved.id}" from the local cache`;
  return resolved;
}

/**
 * The map this tab is running. Throws rather than picking one, because a scene
 * that quietly renders a different world from the one everybody else is in is
 * the bug this module exists to remove.
 */
export function currentTheme(): MapTheme {
  if (!resolved) throw new Error("loadMap() has not finished — the scene was imported too early");
  return resolved;
}

/** how the map was chosen, for the boot log */
export const mapOrigin = () => origin;
