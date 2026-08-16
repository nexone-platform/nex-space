// Map layouts, separated from the scene so a workspace can pick one.
//
// `classic` is the original pastel office; `office` is built around the larger
// 48px CoolSchool desks, which cover 3x3 tiles each and so need wider rooms.
//
// Prop keys may carry a folder: "office/cs-desk" loads /assets/office/cs-desk.png,
// a bare key loads from /assets/furniture. Positions are tile coordinates of the
// sprite's CENTRE, matching how the scene places images.

import { cachedTheme, themeOverride } from "../workspace";

// scale is optional and defaults to 1. Keep it to halves: anything else lands
// source pixels between screen pixels and the art goes soft.
export type Prop = [key: string, x: number, y: number, solid: boolean, scale?: number];
export type Flat = [key: string, x: number, y: number];

export interface Interactive {
  type: "whiteboard" | "screen" | "portal" | "embed";
  x: number; y: number; label: string; icon: string;
  url?: string; target?: { x: number; y: number };
}

/** a desk players can claim: the desk tile plus the seat to sit on */
export interface Desk { id: string; x: number; y: number; sx: number; sy: number }

export interface MapTheme {
  id: string;
  label: string;
  cols: number;
  rows: number;
  spawn: { x: number; y: number };
  /** rectangle players are considered "in a meeting" inside */
  meetingRoom: { x0: number; x1: number; y0: number; y1: number };
  /** floors-atlas index for a tile: 0 cream 1 grass 2 plank 3 pink 4 mint 5 blue 6 dark-wood 7 path 8 brick */
  floorAt(x: number, y: number): number;
  /** "x,y" keys of every wall tile */
  walls(): Set<string>;
  furniture: Prop[];
  outdoor: Prop[];
  decals: Flat[];
  decor: Flat[];
  desks: Desk[];
  interactives: Interactive[];
}

const rect = (add: (x: number, y: number) => void, x0: number, y0: number, x1: number, y1: number) => {
  for (let x = x0; x <= x1; x++) { add(x, y0); add(x, y1); }
  for (let y = y0; y <= y1; y++) { add(x0, y); add(x1, y); }
};

// ---------------------------------------------------------------- classic ---
const CLASSIC_BUILD = { x0: 4, y0: 3, x1: 27, y1: 20 };

export const classicTheme: MapTheme = {
  id: "classic",
  label: "ออฟฟิศพาสเทล",
  cols: 32,
  rows: 25,
  spawn: { x: 15, y: 18 },              // entrance hall, just inside the front door
  meetingRoom: { x0: 20, x1: 26, y0: 4, y1: 9 },

  floorAt(x, y) {
    const inBuild = x >= 5 && x <= 26 && y >= 4 && y <= 19;
    if (x >= 13 && x <= 18 && y >= 21 && y <= 23) return 8; // stone plaza under the fountain
    if (!inBuild) return 1;                                 // grass
    if (x >= 5 && x <= 11 && y >= 4 && y <= 9) return 3;    // lounge
    if (x >= 13 && x <= 18 && y >= 4 && y <= 9) return 5;   // private office
    if (x >= 20 && x <= 26 && y >= 4 && y <= 9) return 4;   // meeting
    if (x >= 5 && x <= 10 && y >= 15 && y <= 19) return 2;  // pantry
    if (x >= 21 && x <= 26 && y >= 15 && y <= 19) return 6; // game room
    return 0;                                               // hall
  },

  walls() {
    const w = new Set<string>();
    const add = (x: number, y: number) => w.add(`${x},${y}`);
    rect(add, CLASSIC_BUILD.x0, CLASSIC_BUILD.y0, CLASSIC_BUILD.x1, CLASSIC_BUILD.y1);
    for (let x = 5; x <= 26; x++) add(x, 10);               // hall / rooms partition
    for (let y = 4; y <= 9; y++) { add(12, y); add(19, y); } // between the three top rooms
    // doors. The team pod's is at 13,10 rather than the middle: column 13 is its
    // walkway, so entering in the middle would put you on top of a chair
    for (const d of ["15,20", "16,20", "8,10", "13,10", "23,10"]) w.delete(d);
    return w;
  },

  furniture: [
    // lounge (pink)
    ["sofa-yellow", 6, 5, false], ["sofa-pink", 9, 5, false],
    ["side-table", 7.5, 6, false], ["floor-lamp", 11, 5, false],
    ["plant-large", 5, 8, true], ["rug-round", 8, 7, false],
    // team pod (blue) — a proper desk bank: two rows of three facing an aisle at
    // y=7, with column 13 left clear as the walkway in from the door at 13,10
    // wall props sit on the gap columns (13, 15, 17) so nothing stands on a desk
    ["whiteboard", 15, 4, true], ["plant-small", 13, 4, false], ["plant-small", 17, 4, false],
    ["desk", 14, 5, true], ["chair-12-north", 14, 6, false],
    ["desk-monitor", 16, 5, true], ["chair-13-north", 16, 6, false],
    ["desk", 18, 5, true], ["chair-14-north", 18, 6, false],
    ["desk-monitor", 14, 8, true], ["chair-15-north", 14, 9, false],
    ["desk", 16, 8, true], ["chair-9-north", 16, 9, false],
    ["desk-monitor", 18, 8, true], ["chair-11-north", 18, 9, false],
    // meeting room (mint) — one matched executive set
    ["conference-table", 23, 6, true],
    ["chair-10-south", 22, 5, false], ["chair-10-south", 24, 5, false],
    ["chair-10-north", 22, 8, false], ["chair-10-north", 24, 8, false],
    ["chair-10-east", 21, 6, false], ["chair-10-west", 25, 6, false],
    ["plant-small", 20, 4, false], ["plant-small", 26, 4, false],
    // hall: reception and a walkway. The desks that used to be scattered here in
    // pairs now live in the team pod above, so this reads as an entrance again
    ["reception-desk", 15, 16, true], ["plant", 17, 16, true],
    ["rug", 15, 13, false],
    ["plant-large", 11, 17, true], ["plant-large", 20, 17, true],
    ["plant", 5, 11, false], ["plant", 26, 11, false],
    ["plant", 5, 13, false], ["plant", 26, 13, false],
    // pantry (plank)
    ["kitchen-counter", 6, 15, true], ["coffee-machine", 8, 15, true],
    ["beverage-cooler", 9, 15, true],
    ["lounge-sofa", 6, 18, false], ["lounge-coffee-table", 7.5, 18, false], ["bean-bag", 9, 18, false],
    // game room (dark wood), symmetric around x=23.5
    ["gaming-tv", 23.5, 15, true],
    ["arcade", 21.5, 16, true], ["plant-large", 25.5, 16, true],
    ["chair-16-north", 21.5, 17, false],
    ["lounge-coffee-table", 23.5, 17, false], ["sofa-teal", 23.5, 18, false],
    ["armchair", 21.5, 18.3, false], ["armchair", 25.5, 18.3, false],
  ],

  outdoor: [
    ["fountain", 15, 22, true],
    ["tree", 1, 5, true], ["tree-oval", 2, 11, true], ["pine", 1, 17, true],
    ["tree-oval", 30, 5, true], ["tree", 29, 11, true], ["pine", 30, 17, true],
    ["pine", 6, 1, true], ["tree", 11, 1, true], ["tree-oval", 16, 1, true],
    ["pine", 21, 1, true], ["tree", 25, 1, true],
    ["tree-oval", 2, 22, true], ["tree", 29, 22, true],
    ["shrub", 5, 2, false], ["shrub", 9, 2, false], ["shrub", 22, 2, false], ["shrub", 26, 2, false],
    ["shrub", 5, 21, false], ["shrub", 26, 21, false],
    ["bench", 7, 23, false], ["bench", 24, 23, false], ["bench-sofa", 2, 15, false],
    ["planter-round", 13, 21, false], ["planter-round", 18, 21, false],
    ["lamp-post", 5, 22, true], ["lamp-post", 26, 22, true],
    ["sign-welcome", 10, 22, false], ["sign-team", 21, 22, false], ["sign-dir", 3, 9, false],
  ],

  decals: [
    ["flower-yellow", 1, 3], ["clover", 3, 8], ["flower-mixed", 1, 14], ["flower-pink", 3, 19],
    ["clover", 28, 4], ["flower-yellow", 30, 9], ["flower-mixed", 28, 15], ["flower-pink", 30, 19],
    ["clover", 8, 1], ["flower-yellow", 14, 2], ["flower-pink", 19, 2], ["flower-mixed", 24, 1],
    ["bush-blob", 4, 1], ["bush-blob", 27, 1], ["rocks", 5, 23], ["rocks", 26, 23],
    ["flower-yellow", 9, 24], ["flower-yellow", 22, 24], ["clover", 11, 24], ["clover", 20, 24],
  ],

  decor: [
    ["arched-window", 8, 3], ["arched-window", 15, 3], ["arched-window", 22, 3],
    ["window", 4, 8], ["window", 27, 8],
    ["glass-panel", 21, 10], ["glass-panel", 25, 10],
    ["art-landscape", 12, 3], ["art-poster", 6, 10], ["wall-shelf", 10, 10],
    ["wall-clock", 14, 10], ["corkboard", 17, 10], ["neon-sign", 24, 3],
  ],

  // The ids are kept exactly as they were even though every desk moved into the
  // pod: they are what people have claimed, and renaming them would silently
  // drop those claims. Order here is the pod read left-to-right, top row first.
  desks: [
    { id: "office-1", x: 14, y: 5, sx: 14, sy: 6 },
    { id: "office-2", x: 16, y: 5, sx: 16, sy: 6 },
    { id: "hall-1", x: 18, y: 5, sx: 18, sy: 6 },
    { id: "hall-2", x: 14, y: 8, sx: 14, sy: 9 },
    { id: "hall-3", x: 16, y: 8, sx: 16, sy: 9 },
    { id: "hall-4", x: 18, y: 8, sx: 18, sy: 9 },
  ],

  interactives: [
    { type: "whiteboard", x: 7, y: 1, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
    { type: "screen", x: 16, y: 0, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
    { type: "portal", x: 2, y: 7, label: "เทเลพอร์ตไปโซนขวา", icon: "✨", target: { x: 17, y: 11 } },
    { type: "portal", x: 17, y: 11, label: "เทเลพอร์ตกลับ", icon: "✨", target: { x: 2, y: 7 } },
  ],
};

// ----------------------------------------------------------------- office ---
// The CoolSchool desk art is 96x96px — three tiles square, which beside a
// one-tile avatar reads as a conference table rather than a desk. Halved it
// covers 1.5 tiles and matches the person; 0.5 is the only reduction available
// that keeps every source pixel on the grid. The chair is left at its own size,
// where it already fits the avatar.
// Sized for the team it is for: six desks, one meeting table, a pantry and a
// lounge. The first cut gave every zone the footprint of a floor plate and left
// a ten-person company rattling around in it.
const OFFICE_BUILD = { x0: 2, y0: 1, x1: 23, y1: 17 };
const DESK_SCALE = 0.5;
const DESK_W = 3 * DESK_SCALE;                 // tiles a desk covers: 1.5
const deskCentre = (x: number) => x + DESK_W / 2;
// The chair is halved along with the desk so the two share a pixel scale, and
// tucked four pixels under the desk's front edge instead of parked below it.
const CHAIR_SCALE = 0.5;
const CHAIR_H = 1.5 * CHAIR_SCALE;             // tiles the chair covers: 0.75

// The desk is 1.5 tiles tall, so its body covers two whole rows of the walk grid
// however it is placed, and the seat has to clear both or nobody can reach their
// own desk — the previous 3-tile desks had the same collision over the chair,
// which only showed up once routing existed to disagree with it. A sprite is
// drawn at v*TILE + TILE/2, so the row stood on is floor(v + 0.5), not floor(v).
const seatRow = (y: number) => y + DESK_W + CHAIR_H / 2 - 4 / 32;

/** desk + the chair tucked in front of it, both centred on the same column */
function station(x: number, y: number): Prop[] {
  const cx = deskCentre(x);
  return [
    ["office/cs-desk", cx, y + DESK_W / 2, true, DESK_SCALE],
    ["office/cs-chair-2", cx, seatRow(y), false, CHAIR_SCALE],
  ];
}

// a 3-tile pitch: 1.5 of desk over two grid columns, then one clear column to
// walk down. Rows are four apart, which leaves the desks' two blocked rows, the
// seat row, and an aisle.
const OFFICE_STATIONS: { id: string; x: number; y: number }[] = [
  { id: "open-1", x: 4, y: 3 }, { id: "open-2", x: 7, y: 3 }, { id: "open-3", x: 10, y: 3 },
  { id: "open-4", x: 4, y: 7 }, { id: "open-5", x: 7, y: 7 }, { id: "open-6", x: 10, y: 7 },
];

export const officeTheme: MapTheme = {
  id: "office",
  label: "ออฟฟิศคลาสสิก (โต๊ะใหญ่)",
  cols: 26,
  rows: 20,
  spawn: { x: 12, y: 15 },                                  // just inside the front door
  meetingRoom: { x0: 14, x1: 22, y0: 2, y1: 10 },

  floorAt(x, y) {
    const inBuild = x >= 3 && x <= 22 && y >= 2 && y <= 16;
    if (x >= 11 && x <= 14 && y >= 18) return 8;            // plaza at the door
    if (!inBuild) return 1;                                 // grass
    if (x <= 12 && y <= 10) return 5;                       // open plan (blue)
    if (x >= 14 && y <= 10) return 4;                       // meeting wing (mint)
    if (x <= 9 && y >= 12) return 2;                        // pantry (plank)
    if (x >= 16 && y >= 12) return 6;                       // lounge (dark wood)
    return 0;                                               // hall + corridor
  },

  walls() {
    const w = new Set<string>();
    const add = (x: number, y: number) => w.add(`${x},${y}`);
    rect(add, OFFICE_BUILD.x0, OFFICE_BUILD.y0, OFFICE_BUILD.x1, OFFICE_BUILD.y1);
    for (let y = 2; y <= 10; y++) add(13, y);               // spine between the wings
    for (let x = 3; x <= 22; x++) add(x, 11);               // corridor wall
    // doors: through the spine, three off the corridor, and the front entrance
    for (const d of ["13,6", "13,7", "6,11", "12,11", "19,11", "12,17", "13,17"]) w.delete(d);
    return w;
  },

  furniture: [
    ...OFFICE_STATIONS.flatMap((s) => station(s.x, s.y)),
    ["office/bin-1", 3.5, 2.5, false],
    // meeting wing: one table with a seat on each side, screen on the end wall.
    // The copier lives here because in the open plan every spot that fits it
    // either sat on a desk or reached down over the corridor door.
    ["office/copier", 21.5, 3, true],
    ["office/tv-on", 18, 2.6, true],
    ["office/table-grey", 18, 6.5, true],
    ["furniture/chair-10-south", 17, 4.6, false], ["furniture/chair-10-south", 19, 4.6, false],
    ["furniture/chair-10-north", 17, 8.4, false], ["furniture/chair-10-north", 19, 8.4, false],
    ["office/mailboxes", 21.5, 9.5, true],
    // pantry — the CoolSchool counter is halved like the desks it sits beside
    ["office/cs-counter", 4.6, 13, true, 0.5],
    // clear of row 12 under the pantry door at 6,11 — parked there it sealed
    // the whole west side off
    ["office/coffee-maker", 7.5, 13, true], ["office/water-cooler", 8.5, 13, true],
    ["office/bin-2", 3.5, 15.5, false],
    // lounge. The TV hangs on the corridor wall, so it is not solid — left solid
    // it stacked with the table and blocked every row of the room's middle.
    ["office/tv", 18.5, 12.4, false], ["office/table-dark", 18.5, 15, true],
    ["furniture/armchair", 17, 13.6, false], ["furniture/armchair", 20, 13.6, false],
    ["office/bin-3", 21.5, 12.5, false],
    // No credenza: it is three tiles wide and the hall is six, of which the
    // column under the corridor door has to stay clear. It did not fit.
  ],

  outdoor: [
    ["fountain", 12.5, 18.6, true, 0.5],
    // only the side margins are two tiles wide, so the trees live there; above
    // the building there is a single row, which fits shrubs and nothing taller
    ["tree", 1, 4, true], ["tree-oval", 1, 10, true], ["pine", 1, 15, true],
    ["tree-oval", 25, 4, true], ["tree", 25, 10, true], ["pine", 25, 15, true],
    ["shrub", 5, 0.5, false], ["shrub", 11, 0.5, false],
    ["shrub", 17, 0.5, false], ["shrub", 21, 0.5, false],
    ["bench", 8, 18.8, false], ["bench", 17, 18.8, false],
    ["lamp-post", 5, 18.2, true], ["lamp-post", 20, 18.2, true],
    ["sign-welcome", 10, 18.4, false], ["sign-team", 15, 18.4, false],
  ],

  decals: [
    ["flower-yellow", 1, 1.6], ["clover", 0.6, 7], ["flower-mixed", 1, 12], ["flower-pink", 0.6, 17],
    ["clover", 24.5, 1.6], ["flower-yellow", 25, 7], ["flower-mixed", 24.5, 12], ["flower-pink", 25, 17],
    ["bush-blob", 3, 0.5], ["bush-blob", 22, 0.5], ["rocks", 6, 19.4], ["rocks", 19, 19.4],
  ],

  decor: [
    ["arched-window", 6, 1], ["arched-window", 10, 1], ["arched-window", 17, 1], ["arched-window", 20, 1],
    ["office/portrait-1", 15, 1.4], ["office/portrait-2", 22, 1.4],
    ["wall-clock", 9, 11], ["corkboard", 16, 11],
  ],

  // derived from the same helpers station() uses, so the claim target and the
  // seat can never drift from where the sprites actually are
  desks: OFFICE_STATIONS.map((s) => ({
    id: s.id,
    x: deskCentre(s.x), y: s.y + DESK_W / 2, // where the nameplate sits
    sx: deskCentre(s.x), sy: seatRow(s.y),   // the chair in front of it
  })),

  interactives: [
    { type: "screen", x: 18, y: 3, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
    { type: "whiteboard", x: 12, y: 2, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
  ],
};

export const THEMES: Record<string, MapTheme> = {
  classic: classicTheme,
  office: officeTheme,
};

/**
 * The layout this room loads: a `?theme=` override first (previewing), then the
 * workspace's saved theme from the local cache. The cache exists because the
 * scene picks its map synchronously at import time, long before the API answers;
 * OfficeScene reloads if the server turns out to disagree.
 */
export function pickTheme(): MapTheme {
  return THEMES[themeOverride()] ?? THEMES[cachedTheme()] ?? classicTheme;
}

/** where a prop's PNG lives: "office/cs-desk" -> office, bare key -> furniture */
export function propPath(key: string, fallbackFolder = "furniture"): { folder: string; file: string } {
  const i = key.indexOf("/");
  return i < 0
    ? { folder: fallbackFolder, file: key }
    : { folder: key.slice(0, i), file: key.slice(i + 1) };
}
