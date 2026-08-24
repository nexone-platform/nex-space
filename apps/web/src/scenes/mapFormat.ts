// Between a map written as code and a map stored as data.
//
// The three built-in layouts are TypeScript objects with `floorAt(x, y)` and
// `walls()` as functions — pleasant to write by hand, and impossible to store.
// A map that can only exist as compiled code can only be made by us, which is
// the single thing standing between here and a map editor.
//
// So: bake a theme down to plain JSON, and read plain JSON back into something
// the scene renders without knowing which of the two it got. The functions
// become arrays — a grid of floor indices and a list of wall keys — both of
// which an editor can produce by clicking, and neither of which can carry
// behaviour into the browser the way a stored function would.

import type { MapTheme } from "./mapThemes";
import type { MapDoc } from "./mapValidate";

export type { MapDoc } from "./mapValidate";
export { mapDocProblem, isMapDoc } from "./mapValidate";

/** one of the built-in layouts, flattened into something storable */
export function bakeTheme(t: MapTheme): MapDoc {
  const floors: number[][] = [];
  for (let y = 0; y < t.rows; y++) {
    const row: number[] = [];
    for (let x = 0; x < t.cols; x++) row.push(t.floorAt(x, y));
    floors.push(row);
  }
  return {
    v: 1,
    id: t.id,
    label: t.label,
    cols: t.cols,
    rows: t.rows,
    spawn: { ...t.spawn },
    meetingRoom: { ...t.meetingRoom },
    floors,
    walls: [...t.walls()],
    furniture: t.furniture,
    outdoor: t.outdoor,
    decals: t.decals,
    decor: t.decor,
    desks: t.desks,
    interactives: t.interactives,
    areas: t.areas,
  };
}

/**
 * The other direction: a stored map wearing the interface the scene already
 * knows, so nothing downstream has to care where its world came from.
 *
 * The two lookups close over the arrays rather than rebuilding anything per
 * call. `floorAt` runs once per tile at boot and `walls()` once, so the cost
 * that matters is building the Set — and it happens here, once, rather than on
 * every call the way a naive `walls: () => new Set(d.walls)` would.
 */
export function themeFromDoc(d: MapDoc): MapTheme {
  const walls = new Set(d.walls);
  return {
    id: d.id,
    label: d.label,
    cols: d.cols,
    rows: d.rows,
    spawn: d.spawn,
    meetingRoom: d.meetingRoom,
    // outside the grid is grass, which is the answer the hand-written themes give
    floorAt: (x, y) => d.floors[y]?.[x] ?? 1,
    walls: () => walls,
    furniture: d.furniture,
    outdoor: d.outdoor,
    decals: d.decals,
    decor: d.decor,
    desks: d.desks,
    interactives: d.interactives,
    areas: d.areas,
  };
}
