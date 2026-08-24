// Map layouts, separated from the scene so a workspace can pick one.
//
// `classic` is the original pastel office; `office` is built around the larger
// 48px CoolSchool desks, which cover 3x3 tiles each and so need wider rooms.
//
// Prop keys may carry a folder: "office/cs-desk" loads /assets/office/cs-desk.png,
// a bare key loads from /assets/furniture. Positions are tile coordinates of the
// sprite's CENTRE, matching how the scene places images.

import { cachedTheme, themeOverride } from "../workspace";
import { AREAS, type PrivateArea } from "./areas";

// scale is optional and defaults to 1. Keep it to halves: anything else lands
// source pixels between screen pixels and the art goes soft.
export type Prop = [key: string, x: number, y: number, solid: boolean, scale?: number];
export type Flat = [key: string, x: number, y: number];

export interface Interactive {
  type: "whiteboard" | "screen" | "portal" | "embed";
  x: number; y: number; label: string; icon: string;
  url?: string;
  target?: { x: number; y: number };
  /** a portal naming another map in the same space; absent means this one */
  map?: string;
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
  /**
   * Where "same room" beats "close enough". Carried on the map rather than
   * looked up by its id, because a stored map has an id nothing recognises —
   * and areas the browser cannot see are areas only the server enforces.
   */
  areas: PrivateArea[];
}

const rect = (add: (x: number, y: number) => void, x0: number, y0: number, x1: number, y1: number) => {
  for (let x = x0; x <= x1; x++) { add(x, y0); add(x, y1); }
  for (let y = y0; y <= y1; y++) { add(x0, y); add(x1, y); }
};

// ---------------------------------------------------------------- classic ---
const CLASSIC_BUILD = { x0: 4, y0: 3, x1: 27, y1: 20 };

export const classicTheme: MapTheme = {
  id: "classic",
  areas: AREAS.classic,
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
    // Row 1, not 2: a shrub is 64px, so its sprite reaches half a tile past the
    // tile it sits on. On row 2 that put greenery across the building's top wall
    // (row 3) — and props are drawn at their own depth while the wall layer sits
    // at a fixed one, so the shrub won a wall it should never have touched. The
    // one at x=26 broke the outline exactly at the meeting room's corner, which
    // read as the room being open to the outside.
    ["shrub", 5, 1, false], ["shrub", 9, 1, false], ["shrub", 22, 1, false], ["shrub", 26, 1, false],
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

// ------------------------------------------------------------ departments ---
// Every prop here is 32px art placed at native size — no scaling anywhere, so
// nothing lands between pixels and a desk stays one tile beside a one-tile
// person. Departments get their own rooms off a corridor rather than sharing an
// open floor.
const DEPT_BUILD = { x0: 2, y0: 2, x1: 29, y1: 21 };

/** desk + the chair in front of it, the pastel theme's arrangement */
function seat(deskKey: string, chairKey: string, x: number, y: number): Prop[] {
  return [[deskKey, x, y, true], [chairKey, x, y + 1, false]];
}

const DEPT_STATIONS: { id: string; x: number; y: number; desk: string; chair: string }[] = [
  // engineering (blue), four desks in two pairs
  { id: "eng-1", x: 5, y: 4, desk: "desk", chair: "chair-12-north" },
  { id: "eng-2", x: 8, y: 4, desk: "desk-monitor", chair: "chair-13-north" },
  { id: "eng-3", x: 5, y: 7, desk: "desk-monitor", chair: "chair-14-north" },
  { id: "eng-4", x: 8, y: 7, desk: "desk", chair: "chair-15-north" },
  // design (mint), a row of three
  { id: "design-1", x: 16, y: 4, desk: "desk", chair: "chair-9-north" },
  { id: "design-2", x: 18, y: 4, desk: "desk-monitor", chair: "chair-11-north" },
  { id: "design-3", x: 20, y: 4, desk: "desk", chair: "chair-16-north" },
  // sales (pink), a row of three downstairs
  { id: "sales-1", x: 5, y: 16, desk: "desk-monitor", chair: "chair-12-north" },
  { id: "sales-2", x: 7, y: 16, desk: "desk", chair: "chair-13-north" },
  { id: "sales-3", x: 9, y: 16, desk: "desk-monitor", chair: "chair-14-north" },
];

export const departmentsTheme: MapTheme = {
  id: "departments",
  areas: AREAS.departments,
  label: "ออฟฟิศแบ่งแผนก",
  cols: 32,
  rows: 24,
  spawn: { x: 15, y: 19 },                                 // inside the front door
  meetingRoom: { x0: 23, x1: 28, y0: 3, y1: 10 },

  floorAt(x, y) {
    const inBuild = x >= 3 && x <= 28 && y >= 3 && y <= 20;
    if (x >= 13 && x <= 16 && y >= 22) return 8;           // plaza at the door
    if (!inBuild) return 1;                                // grass
    if (y <= 10) {                                         // upper wing
      if (x <= 12) return 5;                               // engineering (blue)
      if (x >= 14 && x <= 21) return 4;                    // design (mint)
      if (x >= 23) return 6;                               // meeting (dark wood)
    }
    if (y >= 15) {                                         // lower wing
      if (x <= 11) return 3;                               // sales (pink)
      if (x >= 18 && x <= 22) return 2;                    // pantry (plank)
      if (x >= 24) return 8;                               // lounge (brick)
    }
    return 0;                                              // corridors
  },

  walls() {
    const w = new Set<string>();
    const add = (x: number, y: number) => w.add(`${x},${y}`);
    rect(add, DEPT_BUILD.x0, DEPT_BUILD.y0, DEPT_BUILD.x1, DEPT_BUILD.y1);
    for (let x = 3; x <= 28; x++) { add(x, 11); add(x, 14); }   // the corridor's two walls
    for (let y = 3; y <= 10; y++) { add(13, y); add(22, y); }   // upper wing dividers
    for (let y = 15; y <= 20; y++) { add(12, y); add(17, y); add(23, y); } // lower wing dividers
    for (const d of [
      "7,11", "17,11", "25,11",        // engineering / design / meeting off the corridor
      "14,14", "15,14",                // corridor down into the entrance hall
      "12,17", "18,14", "24,14",       // sales off the hall, pantry and lounge off the corridor
      "14,21", "15,21",                // front door
    ]) w.delete(d);
    return w;
  },

  furniture: [
    ...DEPT_STATIONS.flatMap((s) => seat(s.desk, s.chair, s.x, s.y)),
    // engineering
    ["whiteboard", 11, 3, true], ["bookshelf", 11.5, 9.5, true], ["plant", 3, 10, false],
    // design
    ["plant-large", 14, 3, true], ["plant", 21, 10, false],
    ["side-table", 18, 8, false], ["floor-lamp", 20, 8, false],
    // meeting (dark wood)
    ["conference-table", 25.5, 6, true],
    ["chair-10-south", 25, 4.4, false], ["chair-10-south", 26, 4.4, false],
    ["chair-10-north", 25, 7.6, false], ["chair-10-north", 26, 7.6, false],
    ["chair-10-east", 24, 6, false], ["chair-10-west", 27, 6, false],
    ["plant-small", 23, 3, false], ["plant-small", 28, 10, false],
    // corridor: reception facing the front door, plants along the run
    ["reception-desk", 15, 12, true], ["rug", 15, 13, false],
    ["plant-large", 3, 12, true], ["plant-large", 28, 12, true],
    // sales
    ["plant", 3, 20, false], ["plant-small", 11, 15, false],
    // pantry
    // A 68px unit covers three tile rows wherever it sits, so this 5-wide room
    // takes exactly one of them: two put diagonally across each other walled it
    // in half. The counter holds rows 15-17 and everything below stays clear.
    ["kitchen-counter", 20, 16, true], ["coffee-machine", 19, 15, true],
    ["plant", 18, 16, false], ["bean-bag", 19, 19, false],
    // lounge
    ["gaming-tv", 26.5, 15.6, true],
    ["lounge-coffee-table", 26.5, 19, false],
    ["armchair", 25, 19, false], ["armchair", 28, 19, false],
    // entrance hall
    ["plant", 13, 19, false], ["plant", 16, 19, false],
  ],

  outdoor: [
    ["fountain", 15, 22.5, true],
    ["tree", 1, 5, true], ["tree-oval", 1, 12, true], ["pine", 1, 19, true],
    ["tree-oval", 30.5, 5, true], ["tree", 30.5, 12, true], ["pine", 30.5, 19, true],
    ["pine", 6, 1, true], ["tree", 12, 1, true], ["tree-oval", 19, 1, true], ["tree", 25, 1, true],
    ["shrub", 9, 1, false], ["shrub", 22, 1, false],
    ["bench", 10, 22.8, false], ["bench", 20, 22.8, false],
    ["lamp-post", 8, 22.2, true], ["lamp-post", 22, 22.2, true],
    ["sign-welcome", 12, 22.4, false], ["sign-team", 18, 22.4, false],
  ],

  decals: [
    ["flower-yellow", 1, 2], ["clover", 0.6, 9], ["flower-mixed", 1, 16], ["flower-pink", 0.6, 21],
    ["clover", 30.5, 2], ["flower-yellow", 31, 9], ["flower-mixed", 30.5, 16], ["flower-pink", 31, 21],
    ["bush-blob", 3, 0.6], ["bush-blob", 28, 0.6], ["rocks", 6, 23.4], ["rocks", 25, 23.4],
  ],

  decor: [
    ["arched-window", 6, 2], ["arched-window", 10, 2], ["arched-window", 17, 2], ["arched-window", 25, 2],
    ["window", 2, 7], ["window", 29, 7],
    ["art-landscape", 9, 11], ["art-poster", 19, 11], ["wall-clock", 15, 11],
    ["corkboard", 8, 14], ["wall-shelf", 20, 14],
  ],

  // built from DEPT_STATIONS so the claim target and the seat cannot drift from
  // where the sprites are
  desks: DEPT_STATIONS.map((s) => ({ id: s.id, x: s.x, y: s.y, sx: s.x, sy: s.y + 1 })),

  interactives: [
    { type: "whiteboard", x: 11, y: 3, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
    { type: "screen", x: 25.5, y: 3, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
  ],
};

// ----------------------------------------------------------------- office ---
// The CoolSchool desk art is 96x96px — three tiles square, which beside a
// one-tile avatar reads as a conference table rather than a desk. Halved it
// covers 1.5 tiles and matches the person; 0.5 is the only reduction available
// that keeps every source pixel on the grid. The chair is left at its own size,
// where it already fits the avatar.
// Sized for the team it is for: ten desks — the top of the 1-10 bracket the
// space is created with — plus one meeting table, a pantry and a lounge. Each
// zone is only as big as what stands in it.
const OFFICE_BUILD = { x0: 2, y0: 1, x1: 28, y1: 17 };
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
// five across, two rows: ten desks, one per person the 1-10 bracket allows for
const OFFICE_STATIONS: { id: string; x: number; y: number }[] = [
  { id: "open-1", x: 4, y: 3 }, { id: "open-2", x: 7, y: 3 }, { id: "open-3", x: 10, y: 3 },
  { id: "open-4", x: 13, y: 3 }, { id: "open-5", x: 16, y: 3 },
  { id: "open-6", x: 4, y: 7 }, { id: "open-7", x: 7, y: 7 }, { id: "open-8", x: 10, y: 7 },
  { id: "open-9", x: 13, y: 7 }, { id: "open-10", x: 16, y: 7 },
];

export const officeTheme: MapTheme = {
  id: "office",
  areas: AREAS.office,
  label: "ออฟฟิศคลาสสิก (โต๊ะใหญ่)",
  cols: 31,
  rows: 20,
  spawn: { x: 15, y: 15 },                                  // just inside the front door
  meetingRoom: { x0: 20, x1: 27, y0: 2, y1: 10 },

  floorAt(x, y) {
    const inBuild = x >= 3 && x <= 27 && y >= 2 && y <= 16;
    if (x >= 14 && x <= 17 && y >= 18) return 8;            // plaza at the door
    if (!inBuild) return 1;                                 // grass
    if (x <= 18 && y <= 10) return 5;                       // open plan (blue)
    if (x >= 20 && y <= 10) return 4;                       // meeting wing (mint)
    if (x <= 10 && y >= 12) return 2;                       // pantry (plank)
    if (x >= 20 && y >= 12) return 6;                       // lounge (dark wood)
    return 0;                                               // hall + corridor
  },

  walls() {
    const w = new Set<string>();
    const add = (x: number, y: number) => w.add(`${x},${y}`);
    rect(add, OFFICE_BUILD.x0, OFFICE_BUILD.y0, OFFICE_BUILD.x1, OFFICE_BUILD.y1);
    for (let y = 2; y <= 10; y++) add(19, y);               // spine between the wings
    for (let x = 3; x <= 27; x++) add(x, 11);               // corridor wall
    // doors: through the spine, three off the corridor, and the front entrance
    for (const d of ["19,6", "19,7", "6,11", "15,11", "23,11", "15,17", "16,17"]) w.delete(d);
    return w;
  },

  furniture: [
    ...OFFICE_STATIONS.flatMap((s) => station(s.x, s.y)),
    ["office/bin-1", 3.5, 2.5, false],
    // Meeting room: six seats drawn right up against the table. In these
    // coordinates a prop at v is drawn at v*TILE + TILE/2, so the 3x2 table
    // centred on (23.5, 6.5). These are aligned on DRAWN pixels, not sprite
    // boxes: the table carries 12px of empty space above its top edge and 16px
    // below, the chairs 2-5px, and matching boxes leaves a visible gap — the
    // same thing that once made the pastel theme's chairs float off their desks.
    // The screen hangs on the end wall, so it is not solid.
    ["office/tv-on", 23.5, 2.2, false],
    ["office/table-grey", 23.5, 6.5, true],
    ["furniture/chair-10-south", 22.8, 5.41, false], ["furniture/chair-10-south", 24.2, 5.41, false],
    ["furniture/chair-10-north", 22.8, 7.38, false], ["furniture/chair-10-north", 24.2, 7.38, false],
    ["furniture/chair-10-east", 21.78, 6.5, false], ["furniture/chair-10-west", 25.19, 6.5, false],
    ["furniture/plant-small", 26.5, 2.5, false], ["furniture/plant-small", 26.5, 9.5, false],
    // pantry — the CoolSchool counter is halved like the desks it sits beside
    ["office/cs-counter", 4.6, 13, true, 0.5],
    // clear of row 12 under the pantry door at 6,11 — parked there it sealed
    // the whole west side off
    ["office/coffee-maker", 7.5, 13, true], ["office/water-cooler", 8.5, 13, true],
    ["office/bin-2", 3.5, 15.5, false],
    // lounge. The TV hangs on the corridor wall, so it is not solid — left solid
    // it stacked with the table and blocked every row of the room's middle.
    ["office/tv", 23.5, 12.4, false], ["office/table-dark", 23.5, 15, true],
    ["furniture/armchair", 22, 13.6, false], ["furniture/armchair", 25, 13.6, false],
    ["office/bin-3", 26.5, 12.5, false],
    // hall: the wider entrance takes the credenza again, kept off the column
    // under the corridor door so the way in from the front stays clear. The
    // copier and mailboxes moved here out of the meeting room, where they made
    // it read as a store cupboard with a table in it.
    ["office/credenza", 12.5, 12.6, true],
    ["office/copier", 17.5, 12.6, true], ["office/mailboxes", 18.5, 15.5, true],
  ],

  outdoor: [
    ["fountain", 15.5, 18.6, true, 0.5],
    // only the side margins are two tiles wide, so the trees live there; above
    // the building there is a single row, which fits shrubs and nothing taller
    ["tree", 1, 4, true], ["tree-oval", 1, 10, true], ["pine", 1, 15, true],
    ["tree-oval", 30, 4, true], ["tree", 30, 10, true], ["pine", 30, 15, true],
    ["shrub", 6, 0.5, false], ["shrub", 12, 0.5, false],
    ["shrub", 19, 0.5, false], ["shrub", 25, 0.5, false],
    ["bench", 11, 18.8, false], ["bench", 20, 18.8, false],
    ["lamp-post", 8, 18.2, true], ["lamp-post", 23, 18.2, true],
    ["sign-welcome", 13, 18.4, false], ["sign-team", 18, 18.4, false],
  ],

  decals: [
    ["flower-yellow", 1, 1.6], ["clover", 0.6, 7], ["flower-mixed", 1, 12], ["flower-pink", 0.6, 17],
    ["clover", 29.5, 1.6], ["flower-yellow", 30, 7], ["flower-mixed", 29.5, 12], ["flower-pink", 30, 17],
    ["bush-blob", 3, 0.5], ["bush-blob", 27, 0.5], ["rocks", 8, 19.4], ["rocks", 23, 19.4],
  ],

  decor: [
    ["arched-window", 6, 1], ["arched-window", 10, 1], ["arched-window", 14, 1],
    ["arched-window", 17, 1], ["arched-window", 22, 1], ["arched-window", 26, 1],
    ["office/portrait-1", 21, 1.4], ["office/portrait-2", 27, 1.4],
    ["wall-clock", 12, 11], ["corkboard", 22, 11],
  ],

  // derived from the same helpers station() uses, so the claim target and the
  // seat can never drift from where the sprites actually are
  desks: OFFICE_STATIONS.map((s) => ({
    id: s.id,
    x: deskCentre(s.x), y: s.y + DESK_W / 2, // where the nameplate sits
    sx: deskCentre(s.x), sy: seatRow(s.y),   // the chair in front of it
  })),

  interactives: [
    { type: "screen", x: 23, y: 3, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
    { type: "whiteboard", x: 18, y: 2, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
  ],
};

export const THEMES: Record<string, MapTheme> = {
  classic: classicTheme,
  departments: departmentsTheme,
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
