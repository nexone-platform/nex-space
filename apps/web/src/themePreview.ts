// Thumbnail of a map layout, drawn from the theme's own data with the real art.
//
// Built rather than shipped as a screenshot on purpose: a PNG would quietly stop
// matching the map the first time a desk moves, and this cannot. It mirrors the
// placement rules in OfficeScene.create — tile centres, the same per-prop scales
// and the same draw order — so what the picker shows is what the room looks like.
import { wallTileIndex } from "./wallAutotile";
import { propPath, type MapTheme } from "./scenes/mapThemes";

const TILE = 32;
const FLOOR_ATLAS = "/assets/tilesets/floors-atlas.png"; // 9 x 1 tiles
const WALL_ATLAS = "/assets/tilesets/walls-teal.png";    // 8 x 6 tiles

/** a prop that fails to load must leave a gap, not reject the whole preview */
const load = (src: string) =>
  new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

const cache = new Map<string, Promise<HTMLImageElement | null>>();
const image = (src: string) => {
  if (!cache.has(src)) cache.set(src, load(src));
  return cache.get(src)!;
};

const propUrl = (key: string, fallbackFolder: string) => {
  const { folder, file } = propPath(key, fallbackFolder);
  return `/assets/${folder}/${file}.png`;
};

/** the two atlases and every prop sprite a draw needs, already decoded */
export interface MapArt {
  floors: HTMLImageElement | null;
  walls: HTMLImageElement | null;
  sprite: Map<string, HTMLImageElement | null>;
}

/**
 * Fetch the art for a set of prop keys. Decoded images are cached across calls,
 * so asking again for one already held costs nothing — which is what lets the
 * editor call this after every change without thinking about it.
 */
export async function loadMapArt(keys: Iterable<readonly [string, string]>): Promise<MapArt> {
  const urls = new Map<string, string>();
  for (const [k, folder] of keys) urls.set(k, propUrl(k, folder));
  const [floors, walls, ...loaded] = await Promise.all([
    image(FLOOR_ATLAS), image(WALL_ATLAS),
    ...[...urls.values()].map((u) => image(u)),
  ]);
  const sprite = new Map<string, HTMLImageElement | null>();
  [...urls.keys()].forEach((k, i) => sprite.set(k, loaded[i]));
  return { floors, walls, sprite };
}

/** every prop a layout refers to, paired with the folder its bare keys come from */
export function artKeysOf(theme: MapTheme): (readonly [string, string])[] {
  return [
    ...theme.furniture.map(([k]) => [k, "furniture"] as const),
    ...theme.decals.map(([k]) => [k, "outdoor"] as const),
    ...theme.outdoor.map(([k]) => [k, "outdoor"] as const),
    ...theme.decor.map(([k]) => [k, "decor"] as const),
  ];
}

/**
 * Draw a layout at native size into a context, synchronously.
 *
 * Split out of the preview so the editor can call it on every change and show
 * the room rather than an approximation of it. Anything missing from `art` is
 * skipped, so a prop still loading leaves a gap for one frame instead of
 * throwing away the whole picture.
 */
export function drawMap(ctx: CanvasRenderingContext2D, theme: MapTheme, art: MapArt) {
  const { floors, walls, sprite } = art;

  if (floors) {
    for (let y = 0; y < theme.rows; y++) {
      for (let x = 0; x < theme.cols; x++) {
        const i = theme.floorAt(x, y);
        ctx.drawImage(floors, i * TILE, 0, TILE, TILE, x * TILE, y * TILE, TILE, TILE);
      }
    }
  }

  const put = (key: string, tx: number, ty: number, scale = 1) => {
    const img = sprite.get(key);
    if (!img) return;
    const dw = img.width * scale, dh = img.height * scale;
    // props are positioned by their centre, same as the scene
    ctx.drawImage(img, tx * TILE + TILE / 2 - dw / 2, ty * TILE + TILE / 2 - dh / 2, dw, dh);
  };

  // below the walls: rugs, then grass decals
  for (const [k, tx, ty] of theme.furniture) if (k.startsWith("rug")) put(k, tx, ty);
  for (const [k, tx, ty] of theme.decals) put(k, tx, ty);

  if (walls) {
    const set = theme.walls();
    const isWall = (x: number, y: number) => set.has(`${x},${y}`);
    const cols = Math.max(1, Math.floor(walls.width / TILE));
    for (let y = 0; y < theme.rows; y++) {
      for (let x = 0; x < theme.cols; x++) {
        const i = wallTileIndex(isWall, x, y);
        if (i < 0) continue; // -1 means "no wall here"
        ctx.drawImage(walls, (i % cols) * TILE, Math.floor(i / cols) * TILE, TILE, TILE,
                      x * TILE, y * TILE, TILE, TILE);
      }
    }
  }

  // props, back to front so nearer things overlap
  const scaleOf = (k: string) => (/planter/.test(k) ? 0.6 : 1);
  const layered = [
    ...theme.furniture.filter(([k]) => !k.startsWith("rug")).map(([k, x, y, , s]) => ({ k, x, y, s: s ?? 1 })),
    ...theme.outdoor.map(([k, x, y, , s]) => ({ k, x, y, s: s ?? scaleOf(k) })),
  ].sort((a, b) => a.y - b.y);
  for (const p of layered) put(p.k, p.x, p.y, p.s);

  // wall decor sits on top, shrunk as the scene shrinks it
  for (const [k, tx, ty] of theme.decor) put(k, tx, ty, 0.6);
}

/**
 * @param outWidth width of the returned canvas in CSS pixels; the map is drawn
 *   at full size first and downscaled in one step, which reads far better than
 *   sampling every sprite straight into a small canvas
 */
export async function renderThemePreview(theme: MapTheme, outWidth: number): Promise<HTMLCanvasElement> {
  const w = theme.cols * TILE;
  const h = theme.rows * TILE;

  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  const ctx = full.getContext("2d")!;
  ctx.imageSmoothingEnabled = false; // crisp while at native size

  drawMap(ctx, theme, await loadMapArt(artKeysOf(theme)));

  // ---- one clean downscale ----
  const out = document.createElement("canvas");
  const ratio = outWidth / w;
  out.width = Math.round(outWidth);
  out.height = Math.round(h * ratio);
  const octx = out.getContext("2d")!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(full, 0, 0, out.width, out.height);
  return out;
}
