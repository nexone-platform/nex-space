/**
 * Every desk can be walked to from the front door.
 *
 * The three original layouts were small enough to see wrong. Fifty desks and
 * eighty are not: a bookshelf half a tile too far left seals an aisle, and the
 * only symptom is one person, on one day, finding that the desk they booked is
 * the one desk the router will not take them to. Nothing throws. Nothing logs.
 *
 * So the floor is walked here instead — the same grid the game builds, flooded
 * from the spawn point, and every seat has to be in it. Prop footprints come
 * from the PNGs themselves, because a prop blocks the tiles its picture covers
 * and not the one tile its coordinate names; that is exactly the difference
 * that closes an aisle.
 *
 *   npm run check:reach -w @nexspace/web
 */
import { readFileSync } from "fs";
import { join } from "path";

const g = globalThis as Record<string, unknown>;
g.location = { search: "", href: "http://localhost/", pathname: "/" };
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };

const { THEMES, propPath } = await import("../src/scenes/mapThemes.js");

const TILE = 32;
const ASSETS = join(process.cwd(), "public", "assets");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

/** a PNG's size, straight out of its IHDR — no decoding, no dependency */
const sizeOf = (() => {
  const seen = new Map<string, { w: number; h: number } | null>();
  return (key: string) => {
    if (seen.has(key)) return seen.get(key)!;
    const { folder, file } = propPath(key);
    let box: { w: number; h: number } | null = null;
    try {
      const b = readFileSync(join(ASSETS, folder, `${file}.png`));
      box = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    } catch { box = null; }
    seen.set(key, box);
    return box;
  };
})();

console.log("\nevery desk has a way to it\n");

for (const [id, th] of Object.entries(THEMES)) {
  const walls = th.walls();
  const walk: boolean[][] = [];
  for (let y = 0; y < th.rows; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < th.cols; x++) row.push(!walls.has(`${x},${y}`));
    walk.push(row);
  }

  // Solid props, blocked over the tiles their picture actually covers. This
  // mirrors buildWalkable in the scene, which reads the physics body Phaser
  // gives an image: its drawn size, centred on its coordinate.
  let unknown = 0;
  for (const [key, px, py, solid, scale] of th.furniture) {
    if (!solid) continue;
    const box = sizeOf(key);
    if (!box) { unknown++; continue; }
    const w = box.w * (scale ?? 1), h = box.h * (scale ?? 1);
    const cx = (px as number) * TILE + TILE / 2, cy = (py as number) * TILE + TILE / 2;
    for (let y = Math.floor((cy - h / 2) / TILE); y <= Math.floor((cy + h / 2 - 1) / TILE); y++)
      for (let x = Math.floor((cx - w / 2) / TILE); x <= Math.floor((cx + w / 2 - 1) / TILE); x++)
        if (walk[y]?.[x] !== undefined) walk[y][x] = false;
  }
  ok(`${id}: every solid prop's art was found`, unknown === 0, `${unknown} missing from disk`);

  // Flood from the spawn, four directions — the router allows diagonals only
  // when both neighbours are clear, so four never over-reports what it can do.
  const seen = new Set<string>();
  const start = `${th.spawn.x},${th.spawn.y}`;
  ok(`  · and the spawn point is somewhere you can stand`, !!walk[th.spawn.y]?.[th.spawn.x],
    `${th.spawn.x},${th.spawn.y}`);
  const queue = [th.spawn];
  seen.add(start);
  while (queue.length) {
    const { x, y } = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || !walk[ny]?.[nx]) continue;
      seen.add(k);
      queue.push({ x: nx, y: ny });
    }
  }

  // The seat, not the desk: the desk itself is solid and nobody stands on it.
  const seatless = th.desks.filter((d) => !seen.has(`${Math.round(d.sx)},${Math.round(d.sy)}`));
  ok(`  · all ${th.desks.length} seats reachable from it`, seatless.length === 0,
    seatless.length ? seatless.slice(0, 6).map((d) => `${d.id}@${Math.round(d.sx)},${Math.round(d.sy)}`).join(" ")
      : `${seen.size} tiles of floor`);

  // A cabinet you cannot walk up to is a drawer nobody can open. It is not
  // solid, so the tile it stands on is reachable or the aisle beside it is.
  const shut = th.interactives
    .filter((i) => i.type === "cabinet")
    .filter((i) => {
      const x = Math.round(i.x), y = Math.round(i.y);
      return ![[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seen.has(`${x + dx},${y + dy}`));
    });
  ok(`  · and every cabinet can be stood next to`, shut.length === 0,
    shut.length ? shut.slice(0, 6).map((i) => `${i.desk ?? "room"}@${i.x},${i.y}`).join(" ") : "all of them");

  // Rooms that cannot be entered are the other half of the same mistake — and
  // "has a way in" is not enough to ask. A counter across the middle of a
  // pantry leaves the near half reachable and the far half not, which passes a
  // check that only wants one tile and fails the person standing in it. Every
  // tile of a room somebody could stand on has to be one they can get to.
  const shutRooms = th.areas.map((a) => {
    const stuck: string[] = [];
    for (let y = a.y0; y <= a.y1; y++) {
      for (let x = a.x0; x <= a.x1; x++) {
        if (walk[y]?.[x] && !seen.has(`${x},${y}`)) stuck.push(`${x},${y}`);
      }
    }
    return { id: a.id, stuck };
  }).filter((r) => r.stuck.length);
  ok(`  · and no corner of a room walled off from the rest`, shutRooms.length === 0,
    shutRooms.map((r) => `${r.id}: ${r.stuck.slice(0, 4).join(" ")}`).join("  ")
      || `${th.areas.length} room(s)`);

  /**
   * And nowhere indoors is stranded at all.
   *
   * The floor tint says what is inside the building — anything that is not
   * grass. A pocket of floor nobody can reach is either furniture in the wrong
   * place or a door that was never cut, and both of those are the bug this
   * whole script exists for. Outside, behind a tree, nobody cares.
   */
  const stranded: string[] = [];
  for (let y = 0; y < th.rows; y++) {
    for (let x = 0; x < th.cols; x++) {
      if (!walk[y][x] || seen.has(`${x},${y}`)) continue;
      if (th.floorAt(x, y) === 1) continue;   // grass
      stranded.push(`${x},${y}`);
    }
  }
  ok(`  · and no floor indoors that nobody can get to`, stranded.length === 0,
    stranded.length ? `${stranded.length} tile(s): ${stranded.slice(0, 8).join(" ")}` : "none");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
