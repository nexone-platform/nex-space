// 47-tile blob autotiling — MUST match the enumeration order used by
// assets/tilesets/pixel/gen_pixel_walls_teal.py so the tile index lines up
// with walls-teal.png (8-column atlas, index = position).

type Dir = "N" | "E" | "S" | "W";
const ORTH: Dir[] = ["N", "E", "S", "W"];
const CORNERS: [string, [Dir, Dir]][] = [
  ["NE", ["N", "E"]],
  ["SE", ["E", "S"]],
  ["SW", ["S", "W"]],
  ["NW", ["W", "N"]],
];

// combinations of indices in ascending order (matches Python itertools.combinations)
function combinations<T>(arr: T[], r: number): T[][] {
  const res: T[][] = [];
  const idx: number[] = [];
  const rec = (start: number) => {
    if (idx.length === r) { res.push(idx.map((i) => arr[i])); return; }
    for (let i = start; i < arr.length; i++) { idx.push(i); rec(i + 1); idx.pop(); }
  };
  rec(0);
  return res;
}
function subsets<T>(arr: T[]): T[][] {
  const res: T[][] = [];
  for (let r = 0; r <= arr.length; r++) res.push(...combinations(arr, r));
  return res;
}

function key(orth: Set<string>, diag: Set<string>): string {
  const o = ORTH.filter((d) => orth.has(d)).join("");
  const dg = CORNERS.map(([c]) => c).filter((c) => diag.has(c)).join("");
  return o + "|" + dg;
}

// build the 47 configs in the exact same order as the Python generator
const LUT = new Map<string, number>();
{
  let i = 0;
  for (const orthArr of subsets(ORTH)) {
    const orth = new Set(orthArr);
    const elig = CORNERS.filter(([, [a, b]]) => orth.has(a) && orth.has(b)).map(([c]) => c);
    for (const diagArr of subsets(elig)) {
      LUT.set(key(orth, new Set(diagArr)), i);
      i++;
    }
  }
}

/**
 * Given a predicate isWall(x,y), return the blob tile index (0..46) for cell (x,y),
 * or -1 if the cell itself is not a wall.
 */
export function wallTileIndex(isWall: (x: number, y: number) => boolean, x: number, y: number): number {
  if (!isWall(x, y)) return -1;
  const orth = new Set<string>();
  if (isWall(x, y - 1)) orth.add("N");
  if (isWall(x + 1, y)) orth.add("E");
  if (isWall(x, y + 1)) orth.add("S");
  if (isWall(x - 1, y)) orth.add("W");
  const diag = new Set<string>();
  const off: Record<string, [number, number]> = { NE: [1, -1], SE: [1, 1], SW: [-1, 1], NW: [-1, -1] };
  for (const [c, [a, b]] of CORNERS) {
    if (orth.has(a) && orth.has(b)) {
      const [dx, dy] = off[c];
      if (isWall(x + dx, y + dy)) diag.add(c);
    }
  }
  const idx = LUT.get(key(orth, diag));
  return idx === undefined ? 0 : idx;
}
