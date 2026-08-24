// Drawing the map being edited.
//
// The world itself goes through drawMap — the same function the layout picker
// uses, which mirrors the scene's own placement rules. That is deliberate: an
// editor that draws its own approximation of the room is an editor that lies,
// and it lies about exactly the things you came to it to arrange.
//
// Everything above the world is editor furniture: the grid, the spawn marker,
// area outlines, desk and interactive pins. None of it is stored.

import { drawMap, loadMapArt, type MapArt } from "../themePreview";
import { themeFromDoc } from "../scenes/mapFormat";
import type { MapDoc } from "../scenes/mapValidate";
import { listFor } from "./state";

const TILE = 32;

/** the folder each prop key in a document came from, for loading its art */
export function artKeysOf(doc: MapDoc): (readonly [string, string])[] {
  return [
    ...doc.furniture.map(([k]) => [k, "furniture"] as const),
    ...doc.decals.map(([k]) => [k, "outdoor"] as const),
    ...doc.outdoor.map(([k]) => [k, "outdoor"] as const),
    ...doc.decor.map(([k]) => [k, "decor"] as const),
  ];
}

/** the folder a palette key belongs to, so the same key loads the same picture */
export const folderOfKey = (key: string, dir: string) =>
  key.includes("/") ? key.slice(0, key.indexOf("/")) : (listFor(dir) === "furniture" ? "furniture" : listFor(dir));

export interface Overlays {
  grid: boolean;
  areas: boolean;
  markers: boolean;
  /** the rectangle being dragged out right now, in tiles */
  dragRect?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** the tile under the pointer */
  hover?: { x: number; y: number } | null;
}

export async function artFor(doc: MapDoc, extra: (readonly [string, string])[] = []): Promise<MapArt> {
  return loadMapArt([...artKeysOf(doc), ...extra]);
}

export function render(canvas: HTMLCanvasElement, doc: MapDoc, art: MapArt, o: Overlays) {
  const w = doc.cols * TILE, h = doc.rows * TILE;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);

  drawMap(ctx, themeFromDoc(doc), art);

  if (o.grid) {
    ctx.save();
    ctx.strokeStyle = "#00000018";
    ctx.lineWidth = 1;
    ctx.beginPath();
    // half-pixel offsets, or a 1px line straddles two pixels and reads as 2px grey
    for (let x = 0; x <= doc.cols; x++) { ctx.moveTo(x * TILE + 0.5, 0); ctx.lineTo(x * TILE + 0.5, h); }
    for (let y = 0; y <= doc.rows; y++) { ctx.moveTo(0, y * TILE + 0.5); ctx.lineTo(w, y * TILE + 0.5); }
    ctx.stroke();
    // every tenth line darker, so a tile can be counted to rather than guessed at
    ctx.strokeStyle = "#00000030";
    ctx.beginPath();
    for (let x = 0; x <= doc.cols; x += 10) { ctx.moveTo(x * TILE + 0.5, 0); ctx.lineTo(x * TILE + 0.5, h); }
    for (let y = 0; y <= doc.rows; y += 10) { ctx.moveTo(0, y * TILE + 0.5); ctx.lineTo(w, y * TILE + 0.5); }
    ctx.stroke();
    ctx.restore();
  }

  if (o.areas) {
    ctx.save();
    for (const a of doc.areas) {
      const x = a.x0 * TILE, y = a.y0 * TILE;
      const aw = (a.x1 - a.x0 + 1) * TILE, ah = (a.y1 - a.y0 + 1) * TILE;
      ctx.fillStyle = "#2bb3a316";
      ctx.fillRect(x, y, aw, ah);
      ctx.strokeStyle = "#2bb3a3";
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 1, y + 1, aw - 2, ah - 2);
      ctx.setLineDash([]);
      label(ctx, `🔒 ${a.label}`, x + 4, y + 4, "#0d6d63", "#ffffffdd");
    }
    ctx.restore();
  }

  if (o.markers) {
    ctx.save();
    for (const d of doc.desks) pin(ctx, d.x, d.y, "#8a5905", "โต๊ะ");
    for (const i of doc.interactives) pin(ctx, i.x, i.y, "#5b5fa8", i.icon || "?");
    // the spawn last, because it is the one you look for
    const s = doc.spawn;
    ctx.fillStyle = "#d3564f";
    ctx.beginPath();
    ctx.arc(s.x * TILE + TILE / 2, s.y * TILE + TILE / 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    label(ctx, "จุดเกิด", s.x * TILE + 12, s.y * TILE - 2, "#a83c36", "#ffffffdd");
    ctx.restore();
  }

  if (o.dragRect) {
    const r = o.dragRect;
    const x0 = Math.min(r.x0, r.x1), y0 = Math.min(r.y0, r.y1);
    const x1 = Math.max(r.x0, r.x1), y1 = Math.max(r.y0, r.y1);
    ctx.save();
    ctx.fillStyle = "#2bb3a333";
    ctx.fillRect(x0 * TILE, y0 * TILE, (x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE);
    ctx.strokeStyle = "#10786e";
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 * TILE + 1, y0 * TILE + 1, (x1 - x0 + 1) * TILE - 2, (y1 - y0 + 1) * TILE - 2);
    ctx.restore();
  }

  if (o.hover) {
    ctx.save();
    ctx.strokeStyle = "#ffffffcc";
    ctx.lineWidth = 2;
    ctx.strokeRect(o.hover.x * TILE + 1, o.hover.y * TILE + 1, TILE - 2, TILE - 2);
    ctx.strokeStyle = "#00000088";
    ctx.lineWidth = 1;
    ctx.strokeRect(o.hover.x * TILE + 0.5, o.hover.y * TILE + 0.5, TILE - 1, TILE - 1);
    ctx.restore();
  }
}

/** a small pill of text with a backing plate, so it reads over any floor */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fg: string, bg: string) {
  ctx.save();
  ctx.font = '600 10px "Segoe UI", sans-serif';
  ctx.textBaseline = "top";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = bg;
  ctx.fillRect(x - 2, y - 1, w + 5, 13);
  ctx.fillStyle = fg;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function pin(ctx: CanvasRenderingContext2D, tx: number, ty: number, color: string, text: string) {
  const x = Math.floor(tx) * TILE, y = Math.floor(ty) * TILE;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
  ctx.restore();
  label(ctx, text, x + 3, y + TILE - 13, color, "#ffffffdd");
}
