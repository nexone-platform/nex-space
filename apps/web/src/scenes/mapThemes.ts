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
  type: "whiteboard" | "screen" | "portal" | "embed" | "cabinet";
  x: number; y: number; label: string; icon: string;
  /** for a cabinet standing at a desk: which desk, and so whose it is */
  desk?: string;
  url?: string;
  target?: { x: number; y: number };
  /** a portal naming another map in the same space; absent means this one */
  map?: string;
}

/**
 * A desk players can claim: the desk tile, the seat to sit on, and — where the
 * default will not do — where its own filing pedestal stands.
 */
export interface Desk {
  id: string; x: number; y: number; sx: number; sy: number;
  /** the pedestal's centre; defaults to the tile on the desk's right */
  cx?: number; cy?: number;
}

/**
 * The little cabinet at one desk, and the drawer it opens.
 *
 * Beside the desk, which is where a pedestal belongs and what was asked for
 * twice. The catch is that "beside" is only half a placement: a desk every two
 * columns with a cabinet in every gap turns a pod into a solid bank of
 * furniture with nowhere to walk. So the rule here is paired with room made for
 * it in each layout — the pastel pod is three columns wider than it was, the
 * department rows are spaced on a three-tile pitch, and the open plan alternates
 * sides so two pedestals share one gap and leave the next one empty. The check
 * script measures the aisle that comes out; a layout that closes it fails there
 * rather than on a customer's screen.
 *
 * Not solid, deliberately. A pedestal that blocked its tile would narrow the
 * walkway again, and in the pastel office that walkway is the only way into the
 * pod from its door. Furniture that cannot be walked through is worth less than
 * desks that can be reached.
 */
export const cabinetAtDeskX = (d: Desk): number => d.cx ?? d.x + 1;
export const cabinetAtDeskY = (d: Desk): number => d.cy ?? d.y;

export const deskCabinetProp = (d: Desk): Prop =>
  ["desk-cabinet", cabinetAtDeskX(d), cabinetAtDeskY(d), false];

export const deskCabinetSpot = (d: Desk): Interactive => ({
  type: "cabinet", x: cabinetAtDeskX(d), y: cabinetAtDeskY(d), desk: d.id,
  label: "เปิดตู้ส่วนตัว", icon: "",
});

/**
 * A bank of desks, generated rather than typed out.
 *
 * Fifty desks written by hand is a hundred coordinates, each of them a chance
 * to put a chair inside a wall or two pedestals on one tile — and the three
 * layouts that existed were all small enough that hand-placing them was
 * reasonable. At this size it stops being reasonable. One function, checked
 * once, beats fifty lines checked never.
 *
 * The spacing is the arrangement the pastel pod arrived at the hard way: desk,
 * pedestal, aisle across; desk, chair, aisle down. Three tiles per person in
 * each direction, so every desk has somewhere to put its papers and every
 * column and row between them is somewhere to walk. A bank `across` wide and
 * `down` deep therefore occupies 3·across−1 columns and 3·down−1 rows.
 */
interface Bank {
  /** ids run `${id}-1` upward in reading order */
  id: string;
  /** the first desk's tile — the bank grows right and down from here */
  x: number; y: number;
  across: number; down: number;
  /** where the numbering starts, so two banks can share one series */
  from?: number;
}

// Cycled rather than random: a layout has to come out the same in every
// browser, and a desk that is a different colour on somebody else's screen is
// a bug report nobody can reproduce.
const DESK_ART = ["desk", "desk-monitor"];
const CHAIR_ART = [
  "chair-9-north", "chair-11-north", "chair-12-north", "chair-13-north",
  "chair-14-north", "chair-15-north", "chair-16-north",
];

function deskBank(b: Bank): { desks: Desk[]; props: Prop[] } {
  const desks: Desk[] = [];
  const props: Prop[] = [];
  let n = b.from ?? 1;
  for (let row = 0; row < b.down; row++) {
    for (let col = 0; col < b.across; col++) {
      const x = b.x + col * 3;
      const y = b.y + row * 3;
      desks.push({ id: `${b.id}-${n}`, x, y, sx: x, sy: y + 1 });
      props.push([DESK_ART[(row + col) % DESK_ART.length], x, y, true]);
      props.push([CHAIR_ART[n % CHAIR_ART.length], x, y + 1, false]);
      n++;
    }
  }
  return { desks, props };
}

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

// The ids are kept exactly as they were even though every desk moved into the
// pod: they are what people have claimed, and renaming them would silently
// drop those claims. Order here is the pod read left-to-right, top row first.
// Laid out desk, pedestal, aisle — three columns per person, twice over, with
// the third pedestal against the far wall. Eight columns, which is why the pod
// borrowed one from the lounge and one from the meeting room: at six it could
// hold the desks and the cabinets or an aisle, and not both.
//
// Six in the pod and four in the hall below it, because the pod is walled in on
// three sides and eight columns will not hold ten desks however they are
// turned. What makes that read as one office rather than two is that all ten
// stand on the same three columns — 12, 15 and 18, with the hall's fourth
// carrying on at 21 — so the two banks line up through the partition, and the
// aisles at 14 and 17 run from the top wall of the pod to the front door.
//
// The ids never change. They are what people have claimed, and a claim survives
// its desk being moved but not being renamed.
//
// The pod's two rows face each other across the aisle at row 7 rather than both
// facing the same way: the bottom row's desks are against the partition with
// its chairs above them. Three desks in a line all facing north is a classroom.
const CLASSIC_DESKS: Desk[] = [
  { id: "office-1", x: 12, y: 5, sx: 12, sy: 6 },
  { id: "office-2", x: 15, y: 5, sx: 15, sy: 6 },
  { id: "hall-1", x: 18, y: 5, sx: 18, sy: 6 },
  // facing back up the room, so the seat is above the desk
  { id: "hall-2", x: 12, y: 9, sx: 12, sy: 8 },
  { id: "hall-3", x: 15, y: 9, sx: 15, sy: 8 },
  { id: "hall-4", x: 18, y: 9, sx: 18, sy: 8 },
  // and one run along the hall's top wall, on the pod's own columns
  { id: "hall-5", x: 12, y: 11, sx: 12, sy: 12 },
  { id: "hall-6", x: 15, y: 11, sx: 15, sy: 12 },
  { id: "hall-7", x: 18, y: 11, sx: 18, sy: 12 },
  { id: "hall-8", x: 21, y: 11, sx: 21, sy: 12 },
];

export const classicTheme: MapTheme = {
  id: "classic",
  areas: AREAS.classic,
  label: "ออฟฟิศพาสเทล",
  cols: 32,
  rows: 25,
  spawn: { x: 15, y: 18 },              // entrance hall, just inside the front door
  meetingRoom: { x0: 21, x1: 26, y0: 4, y1: 9 },

  floorAt(x, y) {
    const inBuild = x >= 5 && x <= 26 && y >= 4 && y <= 19;
    if (x >= 13 && x <= 18 && y >= 21 && y <= 23) return 8; // stone plaza under the fountain
    if (!inBuild) return 1;                                 // grass
    if (x >= 5 && x <= 10 && y >= 4 && y <= 9) return 3;    // lounge
    if (x >= 12 && x <= 19 && y >= 4 && y <= 9) return 5;   // team pod
    if (x >= 21 && x <= 26 && y >= 4 && y <= 9) return 4;   // meeting
    if (x >= 5 && x <= 10 && y >= 15 && y <= 19) return 2;  // pantry
    if (x >= 21 && x <= 26 && y >= 15 && y <= 19) return 6; // game room
    return 0;                                               // hall
  },

  walls() {
    const w = new Set<string>();
    const add = (x: number, y: number) => w.add(`${x},${y}`);
    rect(add, CLASSIC_BUILD.x0, CLASSIC_BUILD.y0, CLASSIC_BUILD.x1, CLASSIC_BUILD.y1);
    for (let x = 5; x <= 26; x++) add(x, 10);               // hall / rooms partition
    // The two dividers each moved out one column, into rooms that hold nothing
    // but soft furniture, so the pod between them could hold desks, pedestals
    // and a way past both.
    for (let y = 4; y <= 9; y++) { add(11, y); add(20, y); } // between the three top rooms
    // doors. The team pod's is at 14,10 rather than the middle: column 14 is one
    // of its two aisles, so entering in the middle would put you on top of a desk
    for (const d of ["15,20", "16,20", "8,10", "14,10", "23,10"]) w.delete(d);
    return w;
  },

  furniture: [
    // lounge (pink)
    ["sofa-yellow", 6, 5, false], ["sofa-pink", 9, 5, false],
    ["side-table", 7.5, 6, false], ["floor-lamp", 10, 5, false],
    ["plant-large", 5, 8, true], ["rug-round", 8, 7, false],
    // team pod (blue) — two rows of three facing the cross aisle at y=7. Each
    // desk has its pedestal on its right (13, 16, 19) and columns 14 and 17 run
    // clear from the wall to the door at 14,10. The wall props sit above the
    // desks rather than on the aisles, which is the one place in this room
    // where standing still is free.
    ["whiteboard", 15, 4, true], ["plant-small", 12, 4, false], ["plant-small", 18, 4, false],
    ["desk", 12, 5, true], ["chair-12-north", 12, 6, false],
    ["desk-monitor", 15, 5, true], ["chair-13-north", 15, 6, false],
    ["desk", 18, 5, true], ["chair-14-north", 18, 6, false],
    // and the far row turned to face them
    ["chair-15-south", 12, 8, false], ["desk-monitor", 12, 9, true],
    ["chair-9-south", 15, 8, false], ["desk", 15, 9, true],
    ["chair-11-south", 18, 8, false], ["desk-monitor", 18, 9, true],
    // meeting room (mint) — one matched executive set
    ["conference-table", 23, 6, true],
    ["chair-10-south", 22, 5, false], ["chair-10-south", 24, 5, false],
    ["chair-10-north", 22, 8, false], ["chair-10-north", 24, 8, false],
    ["chair-10-east", 21, 6, false], ["chair-10-west", 25, 6, false],
    ["plant-small", 21, 4, false], ["plant-small", 26, 4, false],
    // Hall: one run of four along the top wall, on the pod's own columns, then
    // reception and the way in. Along the wall rather than out in the middle —
    // four desks standing in open floor with nothing behind them read as
    // furniture nobody had found a place for, which is what they were.
    ["desk", 12, 11, true], ["chair-16-north", 12, 12, false],
    ["desk-monitor", 15, 11, true], ["chair-10-north", 15, 12, false],
    ["desk", 18, 11, true], ["chair-11-north", 18, 12, false],
    ["desk-monitor", 21, 11, true], ["chair-12-north", 21, 12, false],
    ["reception-desk", 15, 16, true], ["plant", 17, 16, true],
    // The filing cabinet, in the open where people walk past it. Half size:
    // the art is 64x96, and at full size a three-tile cabinet beside a
    // one-tile person reads as a wardrobe.
    //
    // Not solid — see the note on the desk pedestals. Drawn at half size it is
    // still 48px tall, so it covers three rows of the walk grid, and those were
    // the only three rows joining the west end of the hall to the rest of it:
    // the pantry counter closed the rows below, the partition the row above,
    // and the lounge door at 8,10 was behind it. Moving it would have been the
    // other fix, and a worse one — a cabinet is found by where it stands, so
    // every document already filed in this one would have been left at an
    // address nothing asks for any more.
    ["office/cabinet", 11, 12, false, 0.5],
    ...CLASSIC_DESKS.map(deskCabinetProp),
    // down by the door, where it is a mat somebody walks in onto, rather than
    // at 15,13 where the new desk run puts a chair on top of it
    ["rug", 15, 17, false],
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
    ["wall-clock", 13, 10], ["corkboard", 17, 10], ["neon-sign", 24, 3],
  ],

  // The ids are kept exactly as they were even though every desk moved into the
  // pod: they are what people have claimed, and renaming them would silently
  // drop those claims. Order here is the pod read left-to-right, top row first.
  desks: CLASSIC_DESKS,

  interactives: [
    { type: "whiteboard", x: 7, y: 1, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
    { type: "screen", x: 16, y: 0, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
    { type: "cabinet", x: 11, y: 12, label: "เปิดตู้เก็บเอกสาร", icon: "🗄" },
    ...CLASSIC_DESKS.map(deskCabinetSpot),
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
  // design (mint), a row of three on a three-tile pitch: desk, pedestal, aisle
  { id: "design-1", x: 14, y: 4, desk: "desk", chair: "chair-9-north" },
  { id: "design-2", x: 17, y: 4, desk: "desk-monitor", chair: "chair-11-north" },
  { id: "design-3", x: 20, y: 4, desk: "desk", chair: "chair-16-north" },
  // sales (pink), a row of three downstairs on the same pitch, shifted one off
  // the west wall so the room keeps a margin on the side its plant stands
  { id: "sales-1", x: 4, y: 16, desk: "desk-monitor", chair: "chair-12-north" },
  { id: "sales-2", x: 7, y: 16, desk: "desk", chair: "chair-13-north" },
  { id: "sales-3", x: 10, y: 16, desk: "desk-monitor", chair: "chair-14-north" },
];

const DEPT_DESKS: Desk[] = DEPT_STATIONS.map((s) => ({ id: s.id, x: s.x, y: s.y, sx: s.x, sy: s.y + 1 }));


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
    // Whole numbers, and it matters: a room cabinet is addressed by the tile it
    // stands on, and the API refuses an address that is not a whole tile. At
    // 13,9.5 this one answered 400 to every attempt to open it, for as long as
    // it has existed.
    ["office/cabinet", 13, 9, false, 0.5],
    ...DEPT_DESKS.map(deskCabinetProp),
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
    // sales — the small plant moved off the east wall, where the third desk's
    // pedestal now stands under it
    ["plant", 3, 20, false], ["plant-small", 3, 15, false],
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
  desks: DEPT_DESKS,

  interactives: [
    { type: "whiteboard", x: 11, y: 3, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
    { type: "screen", x: 25.5, y: 3, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
    { type: "cabinet", x: 13, y: 9, label: "เปิดตู้เก็บเอกสาร", icon: "🗄" },
    ...DEPT_DESKS.map(deskCabinetSpot),
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

// How far a pedestal sits from the middle of its desk: half the desk plus half
// the 20px cabinet, and a hair of daylight so the two are beside each other
// rather than touching.
const CAB_OFF = DESK_W / 2 + 10 / 32 + 3 / 32;

// derived from the same helpers station() uses, so the claim target and the
// seat can never drift from where the sprites actually are
const OFFICE_DESKS: Desk[] = OFFICE_STATIONS.map((s, i) => ({
  id: s.id,
  x: deskCentre(s.x), y: s.y + DESK_W / 2, // where the nameplate sits
  sx: deskCentre(s.x), sy: seatRow(s.y),   // the chair in front of it
  /**
   * Sides alternate along the row. This room is already spaced as tightly as
   * five desks and a meeting wing allow, so there is nowhere to widen it into;
   * what there is, is a 1.5-tile gap between every pair of desks. Putting each
   * pedestal on the side facing its neighbour's fills that gap with two of them
   * and leaves the next gap completely empty — one clear aisle per pair rather
   * than five squeezed ones, which is the difference between walking through
   * and edging past.
   */
  cx: deskCentre(s.x) + (i % 5 % 2 === 0 ? CAB_OFF : -CAB_OFF),
}));

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
    /**
     * Everything solid in this hall stands on rows 12 and 13, and nothing
     * stands under a doorway.
     *
     * Those two rules are the whole arrangement, and it had neither. The
     * counter, the credenza, the copier and the mailboxes between them covered
     * rows 12 to 16 from wall to wall, and the three doors off the corridor —
     * 6, 15 and 23 — each had a solid object directly beneath it. The result
     * was an entrance hall you could not leave: ten desks, a meeting room, a
     * pantry and a lounge, none of them reachable on foot from the front door.
     *
     * It went unnoticed for the same reason the pastel lounge did. A click that
     * cannot be routed fades across instead, and the desk button used to
     * teleport, so nothing ever reported a failure.
     *
     * Row 14 is now clear from wall to wall, and columns 6, 15 and 23 are clear
     * on 12 and 13. reachable-check walks it.
     */
    // pantry — the CoolSchool counter is halved like the desks it sits beside
    ["office/cs-counter", 4.1, 12.5, true, 0.5],
    ["office/coffee-maker", 7.5, 12.5, true], ["office/water-cooler", 8.5, 12.5, true],
    ["office/bin-2", 3.5, 15.5, false],
    // lounge. The TV hangs on the corridor wall, so it is not solid — left solid
    // it stacked with the table and blocked every row of the room's middle. The
    // table sits a row lower than it did, off row 14, which is the hall's only
    // way from one end to the other.
    ["office/tv", 23.5, 12.4, false], ["office/table-dark", 23.5, 15.5, true],
    ["furniture/armchair", 22, 13.6, false], ["furniture/armchair", 25, 13.6, false],
    ["office/bin-3", 26.5, 12.5, false],
    // hall: the credenza, the copier and the mailboxes, all up on rows 12-13
    // and all clear of columns 6, 15 and 23
    ["office/credenza", 11.5, 12.5, true],
    ["office/copier", 18.5, 12.5, true], ["office/mailboxes", 21.5, 12.5, true],
    ["office/cabinet", 16, 12, false, 0.5],
    ...OFFICE_DESKS.map(deskCabinetProp),
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
  desks: OFFICE_DESKS,

  interactives: [
    { type: "screen", x: 23, y: 3, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
    { type: "whiteboard", x: 18, y: 2, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
    { type: "cabinet", x: 16, y: 12, label: "เปิดตู้เก็บเอกสาร", icon: "🗄" },
    ...OFFICE_DESKS.map(deskCabinetSpot),
  ],
};

// --------------------------------------------------------------- open plan ---
// Fifty desks, for the 11-50 bracket. One floor plate rather than rooms off a
// corridor: at this size a corridor layout is mostly corridor, and the thing a
// team of forty actually needs is to be able to see each other.
//
// The whole bank is generated. Everything written by hand below it stands at
// row 20 or lower, which is why none of it can land on a desk or a pedestal —
// the bank ends at row 17 and its last aisle is row 18.
const OPEN_BUILD = { x0: 2, y0: 2, x1: 37, y1: 27 };
const OPEN_BANK = deskBank({ id: "openplan", x: 4, y: 4, across: 10, down: 5 });

export const openPlanTheme: MapTheme = {
  id: "openplan",
  areas: AREAS.openplan,
  label: "ออฟฟิศโล่ง (ทีมกลาง)",
  cols: 40,
  rows: 30,
  spawn: { x: 22, y: 25 },
  // The status rectangle can only name one room, so it names the big one. Which
  // rooms count as meetings is answered by the areas — see PrivateArea.meeting.
  meetingRoom: { x0: 3, x1: 11, y0: 20, y1: 26 },

  floorAt(x, y) {
    const inBuild = x >= 3 && x <= 36 && y >= 3 && y <= 26;
    if (x >= 17 && x <= 22 && y >= 28) return 8;   // stone at the front door
    if (!inBuild) return 1;                        // grass
    if (y <= 18) return 5;                         // the open floor
    if (x <= 11) return 4;                         // the boardroom
    if (x <= 18) return 4;                         // and the other two
    if (x >= 33) return 6;                         // the kitchen corner
    if (x >= 27 && x <= 31) return 4;
    return 0;                                      // entrance hall
  },

  walls() {
    const w = new Set<string>();
    const add = (x: number, y: number) => w.add(`${x},${y}`);
    rect(add, OPEN_BUILD.x0, OPEN_BUILD.y0, OPEN_BUILD.x1, OPEN_BUILD.y1);
    for (let x = 3; x <= 36; x++) add(x, 19);              // floor / rooms partition
    // Four walls, five rooms along the bottom: a boardroom, two smaller meeting
    // rooms, the entrance hall and a kitchen corner. Every one of them opens
    // straight onto the desk floor through the partition rather than off a
    // corridor, which is how a floor plate this shape is actually built — and
    // it means no room is reached by walking through another.
    for (let y = 20; y <= 26; y++) { add(12, y); add(19, y); add(26, y); add(32, y); }
    for (const d of [
      "7,19",    // the boardroom
      "15,19",   // the middle meeting room
      "22,19", "23,19", // the hall, two tiles wide: fifty people through one is a queue
      "29,19",   // the small meeting room
      "33,19",   // the kitchen corner
      "22,27", "23,27", // the front door
    ]) w.delete(d);
    return w;
  },

  furniture: [
    ...OPEN_BANK.props,
    ...OPEN_BANK.desks.map(deskCabinetProp),
    // ห้องประชุมใหญ่ — ten round one table
    ["conference-table", 5.5, 22.5, true],
    ["conference-table", 7.5, 22.5, true],
    ["chair-10-south", 5, 21, false], ["chair-10-south", 6, 21, false], ["chair-10-south", 7, 21, false], ["chair-10-south", 8, 21, false],
    ["chair-10-north", 5, 24, false], ["chair-10-north", 6, 24, false], ["chair-10-north", 7, 24, false], ["chair-10-north", 8, 24, false],
    ["chair-10-east", 4, 22, false], ["chair-10-west", 9, 22, false],
    ["plant-small", 3, 26, false], ["plant-small", 11, 26, false],
    // ห้องประชุมกลาง — six
    ["conference-table", 15.5, 22.5, true],
    ["chair-10-south", 15, 21, false], ["chair-10-south", 16, 21, false],
    ["chair-10-north", 15, 24, false], ["chair-10-north", 16, 24, false],
    ["chair-10-east", 14, 22, false], ["chair-10-west", 17, 22, false],
    // ห้องประชุมเล็ก — six
    ["conference-table", 28.5, 22.5, true],
    ["chair-10-south", 28, 21, false], ["chair-10-south", 29, 21, false],
    ["chair-10-north", 28, 24, false], ["chair-10-north", 29, 24, false],
    ["chair-10-east", 27, 22, false], ["chair-10-west", 30, 22, false],
    // The kitchen corner. A 68px unit covers three columns wherever it sits and
    // this room is four wide, so the units go against the east wall and column
    // 33 is the whole of the lane in from the door at 33,19. Nothing solid
    // stands in it — the first arrangement put the counter across the doorway
    // and sealed the room, which is what reachable-check is for.
    ["kitchen-counter", 35.5, 21, true], ["beverage-cooler", 35.5, 24, true],
    ["bean-bag", 34, 26, false], ["plant-large", 36, 26, true],
    // entrance hall
    ["reception-desk", 22, 21, true], ["rug", 22, 25, false],
    ["office/cabinet", 24, 21, false, 0.5],
    ["plant-large", 20, 26, true], ["plant-large", 25, 26, true],
    ["plant", 20, 20, false], ["plant", 25, 20, false],
  ],

  outdoor: [
    ["fountain", 22.5, 28.5, true],
    ["tree", 0.8, 6, true], ["tree-oval", 0.8, 14, true], ["pine", 0.8, 22, true],
    ["tree-oval", 38.5, 6, true], ["tree", 38.5, 14, true], ["pine", 38.5, 22, true],
    ["pine", 6, 0.8, true], ["tree", 14, 0.8, true], ["tree-oval", 25, 0.8, true],
    ["tree", 33, 0.8, true],
    ["shrub", 10, 0.8, false], ["shrub", 29, 0.8, false],
    ["bench", 15, 28.8, false], ["bench", 30, 28.8, false],
    ["lamp-post", 12, 28.2, true], ["lamp-post", 33, 28.2, true],
    ["sign-welcome", 18, 28.4, false], ["sign-team", 27, 28.4, false],
  ],

  decals: [
    ["flower-yellow", 1, 4], ["clover", 1, 11], ["flower-mixed", 1, 18], ["flower-pink", 1, 25],
    ["clover", 38, 4], ["flower-yellow", 38, 11], ["flower-mixed", 38, 18], ["flower-pink", 38, 25],
    ["bush-blob", 3, 0.6], ["bush-blob", 36, 0.6], ["rocks", 8, 29.4], ["rocks", 31, 29.4],
  ],

  decor: [
    ["arched-window", 8, 2], ["arched-window", 16, 2], ["arched-window", 24, 2], ["arched-window", 32, 2],
    ["window", 2, 10], ["window", 37, 10],
    ["art-landscape", 10, 19], ["wall-clock", 21, 19], ["corkboard", 30, 19],
    ["glass-panel", 5, 19], ["glass-panel", 17, 19],
  ],

  desks: OPEN_BANK.desks,

  interactives: [
    { type: "whiteboard", x: 9, y: 19, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
    { type: "screen", x: 4, y: 19, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
    { type: "cabinet", x: 24, y: 21, label: "เปิดตู้เก็บเอกสาร", icon: "🗄" },
    ...OPEN_BANK.desks.map(deskCabinetSpot),
  ],
};

// ------------------------------------------------------------------ campus ---
// Eighty desks, for 51+. Two banks with a wide corridor between them rather
// than one slab: eight rows of desks in an unbroken run is a warehouse, and the
// corridor is where the building's own traffic goes.
// Three rows taller than the floor above needs, and the three are all in the
// room band. A meeting table with chairs on both sides wants four rows before
// anybody sits at the ends of it, and five rows left exactly one table of six
// for eighty people.
const CAMPUS_BUILD = { x0: 2, y0: 2, x1: 37, y1: 38 };
const CAMPUS_NORTH = deskBank({ id: "campus", x: 4, y: 4, across: 10, down: 5 });
const CAMPUS_SOUTH = deskBank({ id: "campus", x: 4, y: 20, across: 10, down: 3, from: 51 });
const CAMPUS_DESKS = [...CAMPUS_NORTH.desks, ...CAMPUS_SOUTH.desks];

export const campusTheme: MapTheme = {
  id: "campus",
  areas: AREAS.campus,
  label: "ออฟฟิศใหญ่ (หลายทีม)",
  cols: 40,
  rows: 41,
  spawn: { x: 23, y: 36 },
  // Names the big one; which rooms count as meetings is on the areas.
  meetingRoom: { x0: 3, x1: 11, y0: 30, y1: 37 },

  floorAt(x, y) {
    const inBuild = x >= 3 && x <= 36 && y >= 3 && y <= 37;
    if (x >= 21 && x <= 26 && y >= 39) return 8;   // stone at the front door
    if (!inBuild) return 1;                        // grass
    // Plank, not the outdoor path tile it started on: a gravel track down the
    // middle of a building reads as a hole in the roof.
    if (y === 18 || y === 19) return 2;            // the corridor between the banks
    if (y <= 28) return 5;                         // both desk floors
    if (x <= 19) return 4;                         // the boardroom and the middle room
    if (x >= 33) return 6;                         // the kitchen corner
    if (x >= 28 && x <= 31) return 4;              // the small room
    return 0;                                      // entrance hall
  },

  walls() {
    const w = new Set<string>();
    const add = (x: number, y: number) => w.add(`${x},${y}`);
    rect(add, CAMPUS_BUILD.x0, CAMPUS_BUILD.y0, CAMPUS_BUILD.x1, CAMPUS_BUILD.y1);
    for (let x = 3; x <= 36; x++) add(x, 29);              // floors / rooms partition
    // Same five rooms as the smaller floor, and for the same reason: each opens
    // straight onto the desk floor, so none is reached through another.
    for (let y = 30; y <= 37; y++) { add(12, y); add(20, y); add(27, y); add(32, y); }
    for (const d of [
      "7,29",    // the boardroom
      "16,29",   // the middle meeting room
      "23,29", "24,29", // the hall
      "30,29",   // the small meeting room
      "33,29",   // the kitchen corner
      "23,38", "24,38", // the front door
    ]) w.delete(d);
    return w;
  },

  furniture: [
    ...CAMPUS_NORTH.props, ...CAMPUS_SOUTH.props,
    ...CAMPUS_DESKS.map(deskCabinetProp),
    // the corridor between the two floors of desks — one-tile plants only, since
    // anything wider here would close an aisle between the banks
    ["plant-large", 3, 18, true], ["plant-large", 36, 18, true],
    // ห้องประชุมใหญ่ — fourteen round one table
    ["conference-table", 4.5, 33.5, true],
    ["conference-table", 6.5, 33.5, true],
    ["conference-table", 8.5, 33.5, true],
    ["chair-10-south", 4, 32, false], ["chair-10-south", 5, 32, false], ["chair-10-south", 6, 32, false], ["chair-10-south", 7, 32, false], ["chair-10-south", 8, 32, false], ["chair-10-south", 9, 32, false],
    ["chair-10-north", 4, 35, false], ["chair-10-north", 5, 35, false], ["chair-10-north", 6, 35, false], ["chair-10-north", 7, 35, false], ["chair-10-north", 8, 35, false], ["chair-10-north", 9, 35, false],
    ["chair-10-east", 3, 33, false], ["chair-10-west", 10, 33, false],
    ["plant-small", 3, 37, false], ["plant-small", 11, 37, false],
    // ห้องประชุมกลาง — ten
    ["conference-table", 14.5, 33.5, true],
    ["conference-table", 16.5, 33.5, true],
    ["chair-10-south", 14, 32, false], ["chair-10-south", 15, 32, false], ["chair-10-south", 16, 32, false], ["chair-10-south", 17, 32, false],
    ["chair-10-north", 14, 35, false], ["chair-10-north", 15, 35, false], ["chair-10-north", 16, 35, false], ["chair-10-north", 17, 35, false],
    ["chair-10-east", 13, 33, false], ["chair-10-west", 18, 33, false],
    // ห้องประชุมเล็ก — six
    ["conference-table", 29.5, 33.5, true],
    ["chair-10-south", 29, 32, false], ["chair-10-south", 30, 32, false],
    ["chair-10-north", 29, 35, false], ["chair-10-north", 30, 35, false],
    ["chair-10-east", 28, 33, false], ["chair-10-west", 31, 33, false],
    // the kitchen corner, its units against the east wall so column 34 is the
    // whole lane in from the door at 34,29
    ["kitchen-counter", 35.5, 31, true], ["beverage-cooler", 35.5, 34, true],
    ["bean-bag", 34, 37, false], ["plant-large", 36, 37, true],
    // entrance hall
    ["reception-desk", 23, 31, true], ["rug", 23, 36, false],
    ["office/cabinet", 25, 31, false, 0.5],
    ["plant-large", 21, 37, true], ["plant-large", 26, 37, true],
    ["plant", 21, 30, false], ["plant", 26, 30, false],
  ],

  outdoor: [
    ["fountain", 23.5, 39.5, true],
    ["tree", 0.8, 6, true], ["tree-oval", 0.8, 18, true], ["pine", 0.8, 30, true],
    ["tree-oval", 38.5, 6, true], ["tree", 38.5, 18, true], ["pine", 38.5, 30, true],
    ["pine", 6, 0.8, true], ["tree", 14, 0.8, true], ["tree-oval", 25, 0.8, true],
    ["tree", 33, 0.8, true],
    ["shrub", 10, 0.8, false], ["shrub", 29, 0.8, false],
    ["bench", 16, 39.8, false], ["bench", 31, 39.8, false],
    ["lamp-post", 13, 39.2, true], ["lamp-post", 34, 39.2, true],
    ["sign-welcome", 19, 39.4, false], ["sign-team", 28, 39.4, false],
  ],

  decals: [
    ["flower-yellow", 1, 5], ["clover", 1, 15], ["flower-mixed", 1, 25], ["flower-pink", 1, 35],
    ["clover", 38, 5], ["flower-yellow", 38, 15], ["flower-mixed", 38, 25], ["flower-pink", 38, 35],
    ["bush-blob", 3, 0.6], ["bush-blob", 36, 0.6], ["rocks", 9, 40.4], ["rocks", 32, 40.4],
  ],

  decor: [
    ["arched-window", 8, 2], ["arched-window", 16, 2], ["arched-window", 24, 2], ["arched-window", 32, 2],
    ["window", 2, 12], ["window", 37, 12], ["window", 2, 24], ["window", 37, 24],
    ["art-landscape", 10, 29], ["wall-clock", 22, 29], ["corkboard", 31, 29],
    ["glass-panel", 5, 29], ["glass-panel", 18, 29],
  ],

  desks: CAMPUS_DESKS,

  interactives: [
    { type: "whiteboard", x: 9, y: 29, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
    { type: "screen", x: 4, y: 29, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
    { type: "cabinet", x: 25, y: 31, label: "เปิดตู้เก็บเอกสาร", icon: "🗄" },
    ...CAMPUS_DESKS.map(deskCabinetSpot),
  ],
};

export const THEMES: Record<string, MapTheme> = {
  classic: classicTheme,
  departments: departmentsTheme,
  office: officeTheme,
  openplan: openPlanTheme,
  campus: campusTheme,
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
