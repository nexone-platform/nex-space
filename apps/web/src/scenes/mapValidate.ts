// What a stored map looks like, and whether a given thing is one.
//
// A map used to exist only as compiled TypeScript, which meant only we could
// make one. Now it is JSON in a database, which means it arrives over the wire
// and has to be checked before anything draws it. A half-valid map is worse
// than none: the floor renders, the walls do not, and everyone walks through
// the building wondering what broke.
//
// This file is DUPLICATED at apps/api/src/mapValidate.ts. The API refuses a bad
// map at the door and the browser refuses one it is handed, because neither can
// assume the other did — and the two apps build from separate Docker contexts,
// so neither can import from the other. It has no imports of its own for that
// reason, and scripts/copies-check.mjs fails the build if the two drift apart.

/** [key, x, y, solid, scale?] — a prop, positioned on the centre of the sprite */
export type Prop = [key: string, x: number, y: number, solid: boolean, scale?: number];
/** [key, x, y] — something flat, drawn just above the floor */
export type Flat = [key: string, x: number, y: number];

export interface Desk { id: string; x: number; y: number; sx: number; sy: number }

export interface Interactive {
  type: "whiteboard" | "screen" | "portal" | "embed";
  x: number; y: number; label: string; icon: string;
  url?: string;
  target?: { x: number; y: number };
  /** a portal naming another map in the same space; absent means this one */
  map?: string;
}

export interface PrivateArea {
  id: string; label: string;
  x0: number; y0: number; x1: number; y1: number;
  /**
   * A room you have to be let into. Somebody already inside admits you; an
   * empty one lets the first person walk in, because a locked door with nobody
   * behind it is a room nobody could ever enter.
   */
  locked?: boolean;
}

/** the stored shape — everything the scene needs to draw a world */
export interface MapDoc {
  /** format version, so a stored map outlives a change to this file */
  v: 1;
  id: string;
  label: string;
  cols: number;
  rows: number;
  spawn: { x: number; y: number };
  meetingRoom: { x0: number; x1: number; y0: number; y1: number };
  /** rows of floors-atlas indices: `rows` of them, each `cols` long */
  floors: number[][];
  /** "x,y" of every wall tile */
  walls: string[];
  furniture: Prop[];
  outdoor: Prop[];
  decals: Flat[];
  decor: Flat[];
  desks: Desk[];
  interactives: Interactive[];
  areas: PrivateArea[];
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const int = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

const isRect = (v: any) =>
  !!v && int(v.x0, 0, 4096) && int(v.x1, 0, 4096) && int(v.y0, 0, 4096) && int(v.y1, 0, 4096);

const isProp = (v: any) =>
  Array.isArray(v) && v.length >= 4 && typeof v[0] === "string" && v[0].length <= 64
  && num(v[1]) && num(v[2]) && typeof v[3] === "boolean"
  && (v[4] === undefined || num(v[4]));

const isFlat = (v: any) =>
  Array.isArray(v) && v.length === 3 && typeof v[0] === "string" && v[0].length <= 64
  && num(v[1]) && num(v[2]);

const isDesk = (v: any) =>
  !!v && typeof v.id === "string" && v.id.length <= 64
  && num(v.x) && num(v.y) && num(v.sx) && num(v.sy);

const INTERACTIVE_KINDS = ["whiteboard", "screen", "portal", "embed"];
const isInteractive = (v: any) =>
  !!v && INTERACTIVE_KINDS.indexOf(v.type) >= 0 && num(v.x) && num(v.y)
  && typeof v.label === "string" && v.label.length <= 60
  && typeof v.icon === "string" && v.icon.length <= 8
  // A stored map must not be able to point a browser anywhere it likes: an
  // embed becomes an iframe, and "javascript:" in one is a script running on
  // our own origin with the signed-in user's session behind it.
  && (v.url === undefined || (typeof v.url === "string" && v.url.length <= 500 && /^https:\/\//i.test(v.url)))
  && (v.target === undefined || (num(v.target?.x) && num(v.target?.y)))
  // The name of another map in this space, which becomes a ?m= in a URL — so
  // it is held to the same shape a map's own id is.
  && (v.map === undefined || (typeof v.map === "string" && /^[a-z0-9-]{1,32}$/.test(v.map)));

const isArea = (v: any) =>
  !!v && typeof v.id === "string" && v.id.length <= 64
  && typeof v.label === "string" && v.label.length <= 60 && isRect(v)
  && (v.locked === undefined || typeof v.locked === "boolean");

const every = (v: unknown, check: (x: any) => boolean, max: number) =>
  Array.isArray(v) && v.length <= max && v.every(check);

/**
 * Is this a map? Returns the reason it is not, rather than a boolean, so the
 * caller can say something better than "invalid" — a rejected map is usually
 * one field wrong, and whoever produced it needs to be told which one.
 */
export function mapDocProblem(v: any): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "not an object";
  if (v.v !== 1) return "unknown format version " + JSON.stringify(v.v);
  if (typeof v.id !== "string" || !/^[a-z0-9-]{1,32}$/.test(v.id)) return "id must be 1-32 chars of a-z, 0-9 or -";
  if (typeof v.label !== "string" || !v.label.trim() || v.label.length > 60) return "label must be 1-60 characters";
  // The ceiling is what one browser can hold: the scene builds a cols x rows
  // tilemap and one sprite per prop, all at once, with no streaming.
  if (!int(v.cols, 4, 200) || !int(v.rows, 4, 200)) return "cols and rows must be whole numbers between 4 and 200";
  if (!num(v.spawn?.x) || !num(v.spawn?.y)) return "spawn needs x and y";
  if (!isRect(v.meetingRoom)) return "meetingRoom needs whole-number x0 x1 y0 y1";

  if (!Array.isArray(v.floors) || v.floors.length !== v.rows) return "floors must have exactly " + v.rows + " rows";
  for (let y = 0; y < v.floors.length; y++) {
    const row = v.floors[y];
    if (!Array.isArray(row) || row.length !== v.cols) return "floors row " + y + " must have exactly " + v.cols + " tiles";
    // 0-8 is the floors atlas; anything else draws nothing and leaves a hole
    for (let x = 0; x < row.length; x++) {
      if (!int(row[x], 0, 8)) return "floors row " + y + " has a tile outside 0-8";
    }
  }

  if (!every(v.walls, (s) => typeof s === "string" && /^\d{1,3},\d{1,3}$/.test(s), 40000))
    return 'walls must be strings like "12,7"';

  if (!every(v.furniture, isProp, 4000)) return "furniture has a bad entry";
  if (!every(v.outdoor, isProp, 4000)) return "outdoor has a bad entry";
  if (!every(v.decals, isFlat, 4000)) return "decals has a bad entry";
  if (!every(v.decor, isFlat, 4000)) return "decor has a bad entry";
  if (!every(v.desks, isDesk, 500)) return "desks has a bad entry";
  if (!every(v.interactives, isInteractive, 500)) return "interactives has a bad entry (a url must be https)";
  if (!every(v.areas, isArea, 200)) return "areas has a bad entry";

  const deskIds: Record<string, true> = {};
  for (const d of v.desks) {
    if (deskIds[d.id]) return 'two desks share the id "' + d.id + '"';
    deskIds[d.id] = true;
  }
  const areaIds: Record<string, true> = {};
  for (const a of v.areas) {
    if (areaIds[a.id]) return 'two areas share the id "' + a.id + '"';
    areaIds[a.id] = true;
  }

  // Spawning inside a wall leaves every new arrival stuck against it, and it is
  // the one mistake nobody notices until somebody else joins.
  if (v.walls.indexOf(Math.floor(v.spawn.x) + "," + Math.floor(v.spawn.y)) >= 0) return "spawn is inside a wall";
  return null;
}

export const isMapDoc = (v: unknown): v is MapDoc => mapDocProblem(v) === null;
