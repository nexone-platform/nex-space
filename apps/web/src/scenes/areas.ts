// Private areas: the rectangles where "same room" beats "close enough".
//
// Stand inside one and you hear everyone else inside it however far away they
// are, and nobody outside — not even someone standing on the other side of the
// line. Outside them, the old proximity radius is still what decides.
//
// This file is DUPLICATED at apps/game-server/src/areas.ts, because the two
// apps are built from separate Docker contexts and neither can import from the
// other. It has no imports of its own so both sides can load it anywhere, and
// scripts/areas-check.mjs fails the build if the copies ever drift apart. Edit
// one, copy it over the other.
//
// Bounds are inclusive tile coordinates, and every area listed here is a room
// or a floor-tinted corner that is already visible on the map — a boundary you
// cannot see is a boundary that feels like a bug.

export interface PrivateArea {
  /** stable id — the audio rule only ever compares these */
  id: string;
  /** shown on the map and in the "you are in …" chip */
  label: string;
  x0: number; y0: number; x1: number; y1: number;
  /**
   * A room you have to be let into. Somebody already inside admits you; an
   * empty one lets the first person walk in, because a locked door with nobody
   * behind it is a room nobody could ever enter.
   *
   * None of the built-in layouts below lock anything: a stock office where a
   * room refuses you is a surprise, and locking is something a space decides.
   */
  locked?: boolean;
}

export const AREAS: Record<string, PrivateArea[]> = {
  // walled rooms across the top, plus the two tinted corners downstairs
  classic: [
    { id: "lounge",  label: "โซนพักผ่อน", x0: 5,  y0: 4,  x1: 11, y1: 9 },
    { id: "pod",     label: "โซนทีม",     x0: 13, y0: 4,  x1: 18, y1: 9 },
    { id: "meeting", label: "ห้องประชุม", x0: 20, y0: 4,  x1: 26, y1: 9 },
    { id: "pantry",  label: "ห้องครัว",   x0: 5,  y0: 15, x1: 10, y1: 19 },
    { id: "game",    label: "ห้องเกม",    x0: 21, y0: 15, x1: 26, y1: 19 },
  ],
  // six rooms off one corridor — every one of them is walled
  departments: [
    { id: "eng",     label: "ฝ่ายวิศวกรรม", x0: 3,  y0: 3,  x1: 12, y1: 10 },
    { id: "design",  label: "ฝ่ายออกแบบ",   x0: 14, y0: 3,  x1: 21, y1: 10 },
    { id: "meeting", label: "ห้องประชุม",   x0: 23, y0: 3,  x1: 28, y1: 10 },
    { id: "sales",   label: "ฝ่ายขาย",      x0: 3,  y0: 15, x1: 11, y1: 20 },
    { id: "pantry",  label: "ห้องครัว",     x0: 18, y0: 15, x1: 22, y1: 20 },
    { id: "lounge",  label: "โซนพักผ่อน",   x0: 24, y0: 15, x1: 28, y1: 20 },
  ],
  // the open plan is deliberately not one: it is the floor everybody shares,
  // and making it private would mean the map has no public space left
  office: [
    { id: "meeting", label: "ห้องประชุม",  x0: 20, y0: 2,  x1: 27, y1: 10 },
    { id: "pantry",  label: "ห้องครัว",    x0: 3,  y0: 12, x1: 10, y1: 16 },
    { id: "lounge",  label: "โซนพักผ่อน",  x0: 20, y0: 12, x1: 27, y1: 16 },
  ],
};

/** the area a tile belongs to, or undefined out on the open floor */
export function areaAt(themeId: string, tileX: number, tileY: number): PrivateArea | undefined {
  for (const a of AREAS[themeId] ?? []) {
    if (tileX >= a.x0 && tileX <= a.x1 && tileY >= a.y0 && tileY <= a.y1) return a;
  }
  return undefined;
}

/**
 * Can these two hear each other?
 *
 * Inside an area, distance stops counting in both directions: everyone in it is
 * audible, and everyone outside is not. Out on the floor it is the radius, and
 * anyone standing in an area is deaf to it — otherwise a private area would be
 * a room with one wall missing.
 */
export function canHear(
  mine: PrivateArea | undefined,
  theirs: PrivateArea | undefined,
  withinRadius: boolean,
): boolean {
  if (mine || theirs) return !!mine && !!theirs && mine.id === theirs.id;
  return withinRadius;
}
