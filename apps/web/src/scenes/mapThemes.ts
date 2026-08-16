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
const OFFICE_BUILD = { x0: 3, y0: 2, x1: 32, y1: 23 };
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

// a 4-tile pitch: 1.5 of desk and 2.5 of aisle, so two people can pass behind
const OFFICE_STATIONS: { id: string; x: number; y: number }[] = [
  { id: "open-1", x: 6, y: 4 }, { id: "open-2", x: 10, y: 4 }, { id: "open-3", x: 14, y: 4 },
  { id: "open-4", x: 6, y: 9 }, { id: "open-5", x: 10, y: 9 }, { id: "open-6", x: 14, y: 9 },
];

export const officeTheme: MapTheme = {
  id: "office",
  label: "ออฟฟิศคลาสสิก (โต๊ะใหญ่)",
  cols: 36,
  rows: 26,
  spawn: { x: 18, y: 21 },
  meetingRoom: { x0: 20, x1: 31, y0: 3, y1: 13 },

  floorAt(x, y) {
    const inBuild = x >= 4 && x <= 31 && y >= 3 && y <= 22;
    if (x >= 16 && x <= 19 && y >= 24) return 8;            // plaza at the door
    if (!inBuild) return 1;                                 // grass
    if (x >= 4 && x <= 17 && y >= 3 && y <= 13) return 5;   // open plan (blue)
    if (x >= 20 && x <= 31 && y >= 3 && y <= 13) return 4;  // meeting wing (mint)
    if (x >= 4 && x <= 14 && y >= 16 && y <= 22) return 2;  // pantry (plank)
    if (x >= 23 && x <= 31 && y >= 16 && y <= 22) return 6; // lounge (dark wood)
    return 0;                                               // hall
  },

  walls() {
    const w = new Set<string>();
    const add = (x: number, y: number) => w.add(`${x},${y}`);
    rect(add, OFFICE_BUILD.x0, OFFICE_BUILD.y0, OFFICE_BUILD.x1, OFFICE_BUILD.y1);
    for (let y = 3; y <= 14; y++) add(18, y);               // spine between the wings
    for (let x = 4; x <= 31; x++) add(x, 14);               // corridor wall
    for (const d of ["18,23", "19,23", "18,14", "10,14", "27,14", "18,8", "18,9"]) w.delete(d);
    return w;
  },

  furniture: [
    ...OFFICE_STATIONS.flatMap((s) => station(s.x, s.y)),
    // open plan extras
    ["office/copier", 16.5, 12.6, true], ["office/bin-1", 4.8, 13.1, false],
    // meeting wing
    ["office/tv-on", 26.5, 4.6, true],
    ["office/table-grey", 23.5, 8, true], ["office/table-grey", 28.5, 8, true],
    ["furniture/chair-10-south", 23, 6, false], ["furniture/chair-10-south", 28, 6, false],
    ["furniture/chair-10-north", 23, 10, false], ["furniture/chair-10-north", 28, 10, false],
    ["office/mailboxes", 31.5, 10.5, true],
    // pantry
    ["office/cs-counter", 7, 17.5, true],
    ["office/coffee-maker", 10.5, 17.6, true], ["office/water-cooler", 12.5, 17.6, true],
    ["office/bin-2", 13.5, 21.5, false],
    // lounge
    ["office/tv", 26.5, 17.4, true], ["office/table-dark", 26.5, 20, true],
    ["furniture/armchair", 24, 21.5, false], ["furniture/armchair", 29, 21.5, false],
    ["office/bin-3", 31.5, 21.5, false],
    // hall
    ["office/credenza", 20.5, 21.5, true],
  ],

  outdoor: [
    ["fountain", 17.5, 24.5, true],
    ["tree", 1, 5, true], ["tree-oval", 1.6, 13, true], ["pine", 1, 20, true],
    ["tree-oval", 34.4, 5, true], ["tree", 34, 13, true], ["pine", 34.4, 20, true],
    ["pine", 6, 1, true], ["tree", 12, 1, true], ["tree-oval", 24, 1, true], ["tree", 30, 1, true],
    ["shrub", 9, 1, false], ["shrub", 27, 1, false],
    ["bench", 9, 24.8, false], ["bench", 27, 24.8, false],
    ["lamp-post", 6, 24, true], ["lamp-post", 30, 24, true],
    ["sign-welcome", 12, 24.4, false], ["sign-team", 23, 24.4, false],
  ],

  decals: [
    ["flower-yellow", 1, 3], ["clover", 3, 9], ["flower-mixed", 1, 16], ["flower-pink", 3, 22],
    ["clover", 33, 4], ["flower-yellow", 34, 10], ["flower-mixed", 33, 17], ["flower-pink", 34, 22],
    ["bush-blob", 4, 1], ["bush-blob", 32, 1], ["rocks", 6, 25], ["rocks", 30, 25],
  ],

  decor: [
    ["arched-window", 8, 2], ["arched-window", 14, 2], ["arched-window", 24, 2], ["arched-window", 29, 2],
    ["office/portrait-1", 21, 2.4], ["office/portrait-2", 31, 2.4],
    ["wall-clock", 12, 14], ["corkboard", 22, 14],
  ],

  // derived from the same helpers station() uses, so the claim target and the
  // seat can never drift from where the sprites actually are
  desks: OFFICE_STATIONS.map((s) => ({
    id: s.id,
    x: deskCentre(s.x), y: s.y + DESK_W / 2, // where the nameplate sits
    sx: deskCentre(s.x), sy: seatRow(s.y),   // the chair in front of it
  })),

  interactives: [
    { type: "screen", x: 26, y: 3, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
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
