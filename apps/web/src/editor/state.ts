// The map being edited, and every way it can change.
//
// One place holds the document so that undo can be a snapshot rather than a
// pile of inverse operations — an editor with fifteen tools has fifteen ways to
// get an inverse wrong, and a JSON copy of a 6 KB map is cheap enough that the
// clever version would only be clever.
//
// Nothing here touches the DOM or the canvas. The page subscribes and redraws.

import type { MapDoc, Prop, Flat } from "../scenes/mapValidate";
import { mapDocProblem } from "../scenes/mapValidate";

export type Tool = "floor" | "wall" | "prop" | "desk" | "area" | "spawn" | "interactive" | "erase";

/** how deep undo goes — far enough to rescue a mistake, not a session */
const HISTORY = 60;

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** which list of the document a folder's props belong in */
export function listFor(dir: string): "furniture" | "decor" | "outdoor" {
  if (dir === "decor") return "decor";
  if (dir === "outdoor") return "outdoor";
  return "furniture"; // furniture/ and office/ both stand on the floor
}

/**
 * Things you walk around rather than through. Guessed from the key so placing a
 * desk does the obvious thing, and overridable in the palette — the guess is a
 * default, not a rule.
 */
export const guessSolid = (key: string) =>
  !/rug|chair|stool|sofa|bean-bag|mat|carpet/.test(key);

/** the 68px office art is drawn at half size everywhere it already appears */
export const guessScale = (key: string) => (key.startsWith("office/") ? 0.5 : 1);

const clone = (d: MapDoc): MapDoc => JSON.parse(JSON.stringify(d));

export class EditorState {
  private past: string[] = [];
  private future: string[] = [];
  private listeners: (() => void)[] = [];
  /** the document as it was when it was last saved, to spot unsaved work */
  private saved: string;

  constructor(public doc: MapDoc) {
    this.saved = JSON.stringify(doc);
  }

  onChange(fn: () => void) { this.listeners.push(fn); }
  private emit() { for (const fn of this.listeners) fn(); }

  get dirty() { return JSON.stringify(this.doc) !== this.saved; }
  markSaved() { this.saved = JSON.stringify(this.doc); this.emit(); }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  /** the reason this map would be refused, or null */
  get problem() { return mapDocProblem(this.doc); }

  /**
   * Run a change as one undoable step.
   *
   * The snapshot is taken before the change and kept only if the change
   * actually altered something — painting the floor tile that is already that
   * colour should not cost an undo, and a drag across twenty tiles that are all
   * already right should not cost twenty.
   */
  edit(fn: (d: MapDoc) => void) {
    const before = JSON.stringify(this.doc);
    fn(this.doc);
    const after = JSON.stringify(this.doc);
    if (before === after) return false;
    this.past.push(before);
    if (this.past.length > HISTORY) this.past.shift();
    this.future.length = 0;
    this.emit();
    return true;
  }

  /**
   * Several edits that undo as one — a pointer drag is a single act to the
   * person doing it, however many tiles it crossed.
   */
  private stroke: string | null = null;
  beginStroke() { if (this.stroke === null) this.stroke = JSON.stringify(this.doc); }
  endStroke() {
    if (this.stroke === null) return;
    const before = this.stroke;
    this.stroke = null;
    if (before === JSON.stringify(this.doc)) return;
    // collapse everything the stroke pushed back into one entry
    while (this.past.length && this.past[this.past.length - 1] !== before) this.past.pop();
    if (!this.past.length || this.past[this.past.length - 1] !== before) this.past.push(before);
    this.emit();
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(prev);
    this.emit();
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(next);
    this.emit();
  }

  replace(doc: MapDoc, { keepHistory = true } = {}) {
    if (keepHistory) this.past.push(JSON.stringify(this.doc));
    else { this.past.length = 0; this.saved = JSON.stringify(doc); }
    this.future.length = 0;
    this.doc = clone(doc);
    this.emit();
  }

  // ---- the tools ---------------------------------------------------------

  inside(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.doc.cols && y < this.doc.rows;
  }

  setFloor(x: number, y: number, index: number) {
    if (!this.inside(x, y)) return;
    this.edit((d) => { d.floors[y][x] = index; });
  }

  setWall(x: number, y: number, on: boolean) {
    if (!this.inside(x, y)) return;
    const key = `${x},${y}`;
    this.edit((d) => {
      const at = d.walls.indexOf(key);
      if (on && at < 0) d.walls.push(key);
      if (!on && at >= 0) d.walls.splice(at, 1);
    });
  }

  isWall(x: number, y: number) { return this.doc.walls.indexOf(`${x},${y}`) >= 0; }

  addProp(key: string, dir: string, x: number, y: number, solid: boolean, scale: number) {
    if (!this.inside(x, y)) return;
    const list = listFor(dir);
    this.edit((d) => {
      if (list === "furniture") {
        const p: Prop = scale === 1 ? [key, x, y, solid] : [key, x, y, solid, scale];
        d.furniture.push(p);
      } else {
        // decor hangs on a wall and decals lie on the grass: neither is solid,
        // and the stored shape for both is the three-part one
        (d[list] as Flat[]).push([key, x, y]);
      }
    });
  }

  setSpawn(x: number, y: number) {
    if (!this.inside(x, y)) return;
    this.edit((d) => { d.spawn = { x, y }; });
  }

  /** a desk plus the tile you sit on, which is the row below it */
  addDesk(key: string, dir: string, x: number, y: number, scale: number) {
    if (!this.inside(x, y)) return;
    let n = 1;
    while (this.doc.desks.some((d) => d.id === `desk-${n}`)) n++;
    this.edit((d) => {
      d.desks.push({ id: `desk-${n}`, x, y, sx: x, sy: Math.min(y + 1, d.rows - 1) });
      const p: Prop = scale === 1 ? [key, x, y, true] : [key, x, y, true, scale];
      d.furniture.push(p);
    });
  }

  addArea(r: Rect, label: string) {
    let n = 1;
    while (this.doc.areas.some((a) => a.id === `area-${n}`)) n++;
    this.edit((d) => {
      d.areas.push({
        id: `area-${n}`, label,
        x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1),
        x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1),
      });
    });
  }

  renameArea(id: string, label: string) {
    this.edit((d) => { const a = d.areas.find((z) => z.id === id); if (a) a.label = label; });
  }

  removeArea(id: string) {
    this.edit((d) => { d.areas = d.areas.filter((a) => a.id !== id); });
  }

  addInteractive(type: "whiteboard" | "screen" | "portal", x: number, y: number, label: string) {
    if (!this.inside(x, y)) return;
    const icon = type === "whiteboard" ? "🖊" : type === "screen" ? "🖥" : "🚪";
    this.edit((d) => { d.interactives.push({ type, x, y, label, icon }); });
  }

  /**
   * What is at this tile, topmost first — the order the eraser works in, and
   * the order that matches what somebody thinks they are pointing at.
   */
  whatIsAt(x: number, y: number): string | null {
    const d = this.doc;
    if (d.interactives.some((i) => Math.floor(i.x) === x && Math.floor(i.y) === y)) return "วัตถุโต้ตอบ";
    if (d.desks.some((k) => Math.floor(k.x) === x && Math.floor(k.y) === y)) return "โต๊ะ";
    for (const list of ["decor", "outdoor", "furniture"] as const) {
      if ((d[list] as any[]).some((p) => Math.floor(p[1]) === x && Math.floor(p[2]) === y)) return "พร็อพ";
    }
    if (this.isWall(x, y)) return "กำแพง";
    const area = d.areas.find((a) => x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1);
    return area ? "โซน" : null;
  }

  /** remove the topmost thing at a tile; areas are left to the list, which names them */
  eraseAt(x: number, y: number) {
    const hit = (p: any) => Math.floor(p[1]) === x && Math.floor(p[2]) === y;
    this.edit((d) => {
      let i = d.interactives.findIndex((v) => Math.floor(v.x) === x && Math.floor(v.y) === y);
      if (i >= 0) { d.interactives.splice(i, 1); return; }

      i = d.desks.findIndex((v) => Math.floor(v.x) === x && Math.floor(v.y) === y);
      if (i >= 0) {
        d.desks.splice(i, 1);
        // the desk's own sprite goes with it, or the tile keeps a desk you
        // cannot claim and cannot see the difference from one you can
        const j = d.furniture.findIndex(hit);
        if (j >= 0) d.furniture.splice(j, 1);
        return;
      }

      for (const list of ["decor", "outdoor", "furniture"] as const) {
        const j = (d[list] as any[]).findIndex(hit);
        if (j >= 0) { (d[list] as any[]).splice(j, 1); return; }
      }

      const w = d.walls.indexOf(`${x},${y}`);
      if (w >= 0) d.walls.splice(w, 1);
    });
  }

  /**
   * Grow or shrink the world.
   *
   * Everything outside the new bounds goes, because the alternative is a map
   * that validates and quietly holds furniture nobody can reach. The spawn is
   * pulled back inside rather than dropped — a map with no spawn is not a map.
   */
  resize(cols: number, rows: number) {
    this.edit((d) => {
      const floors: number[][] = [];
      for (let y = 0; y < rows; y++) {
        const row: number[] = [];
        for (let x = 0; x < cols; x++) row.push(d.floors[y]?.[x] ?? 1);
        floors.push(row);
      }
      d.floors = floors;
      d.cols = cols;
      d.rows = rows;
      d.walls = d.walls.filter((k) => {
        const [x, y] = k.split(",").map(Number);
        return x < cols && y < rows;
      });
      const inBounds = (x: number, y: number) => x < cols && y < rows;
      d.furniture = d.furniture.filter((p) => inBounds(p[1], p[2]));
      d.outdoor = d.outdoor.filter((p) => inBounds(p[1], p[2]));
      d.decals = d.decals.filter((p) => inBounds(p[1], p[2]));
      d.decor = d.decor.filter((p) => inBounds(p[1], p[2]));
      d.desks = d.desks.filter((k) => inBounds(k.x, k.y));
      d.interactives = d.interactives.filter((i) => inBounds(i.x, i.y));
      d.areas = d.areas
        .map((a) => ({ ...a, x1: Math.min(a.x1, cols - 1), y1: Math.min(a.y1, rows - 1) }))
        .filter((a) => a.x0 < cols && a.y0 < rows);
      d.spawn = { x: Math.min(d.spawn.x, cols - 1), y: Math.min(d.spawn.y, rows - 1) };
      d.meetingRoom = {
        x0: Math.min(d.meetingRoom.x0, cols - 1), x1: Math.min(d.meetingRoom.x1, cols - 1),
        y0: Math.min(d.meetingRoom.y0, rows - 1), y1: Math.min(d.meetingRoom.y1, rows - 1),
      };
    });
  }

  setLabel(label: string) { this.edit((d) => { d.label = label; }); }

  /** the meeting room is the area the call view opens for, so it follows one */
  useAreaAsMeetingRoom(id: string) {
    const a = this.doc.areas.find((z) => z.id === id);
    if (!a) return;
    this.edit((d) => { d.meetingRoom = { x0: a.x0, x1: a.x1, y0: a.y0, y1: a.y1 }; });
  }
}
