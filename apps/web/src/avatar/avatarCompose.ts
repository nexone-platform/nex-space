// LPC paper-doll compositor with real-time palette recolor (ramp remap) + male/
// female bases. Loads /lpc/catalog.json, resolves the chosen layers per body type,
// recolors each by its material palette, stacks by z-order into a canvas. Same
// code path feeds the editor preview and the in-game texture.

export type BodyType = "male" | "female";
export interface RawLayer { z: number; male?: string; female?: string }
export interface Item { id: string; name: string; material: string | null; bodyTypes: BodyType[]; layers: RawLayer[] }
export interface Category { key: string; label: string; material: string | null; items: Item[] }
export interface Palette { base: string; colors: Record<string, string[]> }
export interface Catalog {
  grid: number; walkCols: number; anim: string;
  rowByDir: Record<string, number>;
  spriteBase: string;
  materials: Record<string, Palette>;
  base: Record<BodyType, { z: number; sheet: string; material: string }[]>;
  categories: Category[];
}

// avatar config: body type, skin color, eye color, chosen item id + color per category
export interface LpcConfig {
  bodyType: BodyType;
  skin?: string;                    // body-palette color name
  eyes?: string;                    // eye-palette color name
  parts: Record<string, string>;    // category -> item id
  colors: Record<string, string>;   // category -> palette color name
}

export function defaultConfig(): LpcConfig {
  return { bodyType: "male", parts: {}, colors: {} };
}

// a lightly-dressed default so the "create your own" thumbnail looks like a person
export async function defaultDressedConfig(): Promise<LpcConfig> {
  const cat = await getCatalog();
  const pick = (k: string) =>
    cat.categories.find((c) => c.key === k)?.items.find((i) => i.bodyTypes.includes("male"))?.id;
  const cfg = defaultConfig();
  for (const k of ["hair", "top", "bottom", "shoes"]) {
    const id = pick(k);
    if (id) cfg.parts[k] = id;
  }
  cfg.colors = { top: "blue", bottom: "navy" };
  return cfg;
}

const CATALOG_URL = "/lpc/catalog.json";
let catalogPromise: Promise<Catalog> | null = null;
export function getCatalog(): Promise<Catalog> {
  if (!catalogPromise) catalogPromise = fetch(CATALOG_URL).then((r) => r.json());
  return catalogPromise;
}

// ---- raw sheet image cache ----
const imgCache = new Map<string, Promise<HTMLImageElement>>();
function loadSheet(cat: Catalog, sheet: string, anim: string): Promise<HTMLImageElement> {
  const cacheKey = `${sheet}@${anim}`;
  let p = imgCache.get(cacheKey);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("load fail " + sheet));
      img.src = `${cat.spriteBase}/${sheet}/${anim}.png`;
    });
    imgCache.set(cacheKey, p);
  }
  return p;
}

// ---- recolor: map a sheet's base ramp -> a target color ramp (per material) ----
const hx = (c: string): [number, number, number] => {
  const s = c.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const recolorCache = new Map<string, Promise<CanvasImageSource>>();
const TOL2 = 12 * 12;

// a recolor pass: remap this material's base ramp -> the named target color
interface Op { material: string; color: string }

// apply one or more recolor passes to a sheet (e.g. face = skin pass + eye pass)
async function resolveImage(cat: Catalog, sheet: string, ops: Op[], anim: string): Promise<CanvasImageSource> {
  const active = ops.filter((o) => {
    const pal = cat.materials[o.material];
    return pal && o.color && o.color !== pal.base && pal.colors[o.color];
  });
  if (!active.length) return loadSheet(cat, sheet, anim);
  const cacheKey = sheet + "@" + anim + "|" + active.map((o) => o.material + ":" + o.color).join("|");
  let p = recolorCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const img = await loadSheet(cat, sheet, anim);
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, cv.width, cv.height);
      const d = data.data;
      for (const o of active) {
        const pal = cat.materials[o.material];
        const base = pal.colors[pal.base].map(hx);
        const tgt = pal.colors[o.color].map(hx);
        const n = Math.min(base.length, tgt.length);
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 8) continue;
          let best = -1, bd = TOL2;
          for (let k = 0; k < n; k++) {
            const dr = d[i] - base[k][0], dg = d[i + 1] - base[k][1], db = d[i + 2] - base[k][2];
            const dist = dr * dr + dg * dg + db * db;
            if (dist < bd) { bd = dist; best = k; }
          }
          if (best >= 0) { d[i] = tgt[best][0]; d[i + 1] = tgt[best][1]; d[i + 2] = tgt[best][2]; }
        }
      }
      ctx.putImageData(data, 0, 0);
      return cv;
    })();
    recolorCache.set(cacheKey, p);
  }
  return p;
}

// resolve base + selected parts into z-sorted layers, each with its recolor passes
interface ResolvedLayer { z: number; sheet: string; ops: Op[] }
export function layersFor(cat: Catalog, cfg: LpcConfig): ResolvedLayer[] {
  const bt: BodyType = cfg.bodyType || "male";
  const out: ResolvedLayer[] = [];
  for (const l of cat.base[bt]) {
    const ops: Op[] = [{ material: l.material, color: cfg.skin ?? "" }];
    if (l.sheet.includes("/faces/") && cfg.eyes) ops.push({ material: "eye", color: cfg.eyes }); // eye color on the face
    out.push({ z: l.z, sheet: l.sheet, ops });
  }
  for (const c of cat.categories) {
    const id = cfg.parts?.[c.key];
    if (!id) continue;
    const item = c.items.find((i) => i.id === id);
    if (!item) continue;
    const color = cfg.colors?.[c.key] ?? "";
    for (const L of item.layers) {
      const sheet = L[bt] || L.male || L.female;
      if (sheet) out.push({ z: L.z, sheet, ops: item.material ? [{ material: item.material, color }] : [] });
    }
  }
  return out.sort((a, b) => a.z - b.z);
}

async function drawLayers(
  cat: Catalog, layers: ResolvedLayer[], ctx: CanvasRenderingContext2D,
  src: [number, number, number, number] | null, dst: [number, number, number, number] | null,
  anim = "walk",
) {
  const imgs = await Promise.all(layers.map((l) => resolveImage(cat, l.sheet, l.ops, anim).catch(() => null)));
  for (const img of imgs) {
    if (!img) continue;
    if (src && dst) ctx.drawImage(img, src[0], src[1], src[2], src[3], dst[0], dst[1], dst[2], dst[3]);
    else ctx.drawImage(img, 0, 0);
  }
}

// full walk spritesheet (all frames/directions) — the in-game texture source
export async function buildWalkCanvas(cfg: LpcConfig): Promise<HTMLCanvasElement> {
  const cat = await getCatalog();
  const g = cat.grid, w = cat.walkCols * g, h = 4 * g;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  await drawLayers(cat, layersFor(cat, cfg), canvas.getContext("2d")!, null, null);
  return canvas;
}

// sit spritesheet (3 cols x 4 dir rows) — the seated pose is column 2 of each row
export const SIT_COLS = 3;
export const SIT_SEATED_COL = 2;
export async function buildSitCanvas(cfg: LpcConfig): Promise<HTMLCanvasElement> {
  const cat = await getCatalog();
  const g = cat.grid, w = SIT_COLS * g, h = 4 * g;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  await drawLayers(cat, layersFor(cat, cfg), canvas.getContext("2d")!, null, null, "sit");
  return canvas;
}

// single idle frame in one direction — thumbnails + live preview
export async function buildFrameCanvas(cfg: LpcConfig, dir = "south", scale = 1): Promise<HTMLCanvasElement> {
  const cat = await getCatalog();
  const g = cat.grid, row = cat.rowByDir[dir] ?? cat.rowByDir.south ?? 2;
  const canvas = document.createElement("canvas");
  canvas.width = g * scale; canvas.height = g * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  await drawLayers(cat, layersFor(cat, cfg), ctx, [0, row * g, g, g], [0, 0, g * scale, g * scale]);
  return canvas;
}

// dataURL thumbnail of a base + a single item (as worn), for the editor grid
export async function itemThumb(cfgBase: LpcConfig, categoryKey: string, item: Item | null, color: string | undefined, scale = 3): Promise<string> {
  const cfg: LpcConfig = {
    bodyType: cfgBase.bodyType, skin: cfgBase.skin, parts: {}, colors: {},
  };
  if (item) { cfg.parts[categoryKey] = item.id; if (color) cfg.colors[categoryKey] = color; }
  const c = await buildFrameCanvas(cfg, "south", scale);
  return c.toDataURL();
}

// ---- encode config into the string the room/peers pass around ----
const PREFIX = "lpc:";
export function isLpc(avatar: string | undefined | null): avatar is string {
  return !!avatar && avatar.startsWith(PREFIX);
}
export function encodeAvatar(cfg: LpcConfig): string { return PREFIX + JSON.stringify(cfg); }
export function decodeAvatar(avatar: string): LpcConfig | null {
  if (!isLpc(avatar)) return null;
  try {
    const cfg = JSON.parse(avatar.slice(PREFIX.length));
    if (cfg && typeof cfg === "object" && cfg.parts) {
      return { bodyType: cfg.bodyType === "female" ? "female" : "male", skin: cfg.skin, eyes: cfg.eyes, parts: cfg.parts, colors: cfg.colors ?? {} };
    }
  } catch { /* ignore */ }
  return null;
}

// stable texture key for a config (dedupes identical avatars)
export function avatarKey(avatar: string): string {
  let h = 5381;
  for (let i = 0; i < avatar.length; i++) h = ((h << 5) + h + avatar.charCodeAt(i)) | 0;
  return "lpc-" + (h >>> 0).toString(36);
}

// direction name -> LPC row (4 rows: N/W/S/E; diagonals fold to the side view)
export const LPC_ROW: Record<string, number> = {
  down: 2, up: 0, left: 1, right: 3,
  "down-right": 3, "up-right": 3, "down-left": 1, "up-left": 1,
};
