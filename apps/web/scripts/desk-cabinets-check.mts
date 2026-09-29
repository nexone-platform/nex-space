/**
 * Every desk has a cabinet, every cabinet has somewhere to stand, and there is
 * still a way to walk between them.
 *
 * The pedestal beside a desk is placed by a rule, not by hand. That is what
 * keeps it right when a desk is added, and also what makes it silent when it is
 * wrong: move a desk against a wall and its cabinet is drawn inside that wall,
 * on a map nobody opens until a customer does.
 *
 * The aisle is here for a sharper reason. Putting a cabinet beside every desk
 * is the obvious placement and it closed the pastel pod: six desks, six
 * pedestals, twelve columns of furniture in a room eight columns wide, and
 * nothing to walk down. Nothing failed — the map loaded, every cabinet opened,
 * and the room was simply unusable. So the gap the layout leaves is measured in
 * tiles and required to stay at least one avatar wide, which is the only part
 * of this that a future desk can quietly undo.
 *
 * Cheap to check and impossible to notice otherwise, so it is checked.
 *
 *   npm run check:desks -w @nexspace/web
 */
/**
 * The map modules reach a browser on the way in — one of them reads the ?w= out
 * of the address bar at import time. Enough of a browser to get past that, and
 * nothing more: this checks geometry, which needs no window at all.
 */
const g = globalThis as Record<string, unknown>;
g.location = { search: "", href: "http://localhost/", pathname: "/" };
g.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {},
};

const { THEMES } = await import("../src/scenes/mapThemes.js");

/**
 * How wide the art is, in tiles, measured off the PNGs themselves: the pastel
 * and department desks are 32px at native size, the CoolSchool desk 96px drawn
 * at half, and the pedestal 20px. Written down rather than derived because a
 * theme carries positions, not pixels — and a number that is wrong here fails
 * this script loudly, which is the whole point of it.
 */
const DESK_W: Record<string, number> = { classic: 1, departments: 1, office: 1.5 };
const CAB_W = 20 / 32;

/** the widest clear run between the leftmost and rightmost thing in a row */
const widestGap = (spans: [number, number][]): number => {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let reach = sorted[0]?.[1] ?? 0, best = 0;
  for (const [from, to] of sorted.slice(1)) {
    best = Math.max(best, from - reach);
    reach = Math.max(reach, to);
  }
  return best;
};

const overlap = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

console.log("\na cabinet at every desk, standing somewhere it can\n");

for (const [id, th] of Object.entries(THEMES)) {
  const desks = th.desks;
  const pedestals = th.interactives.filter((i) => i.type === "cabinet" && i.desk);
  const props = th.furniture.filter((f) => f[0] === "desk-cabinet");

  ok(`${id}: one cabinet per desk`, pedestals.length === desks.length,
    `${pedestals.length} for ${desks.length} desk(s)`);
  ok(`  · and one sprite for each of them`, props.length === pedestals.length,
    `${props.length} sprite(s)`);
  ok(`  · each naming a desk that exists`,
    pedestals.every((p) => desks.some((d) => d.id === p.desk)),
    pedestals.map((p) => p.desk).filter((n) => !desks.some((d) => d.id === n)).join(" ") || "all of them");

  const walls = th.walls();
  const inWall = pedestals.filter((p) => walls.has(`${p.x},${p.y}`));
  ok(`  · none of them inside a wall`, inWall.length === 0,
    inWall.map((p) => `${p.desk}@${p.x},${p.y}`).join(" ") || `${pedestals.length} checked`);

  const taken = new Set(th.furniture.filter((f) => f[0] !== "desk-cabinet")
    .map((f) => `${f[1]},${f[2]}`));
  const onProp = pedestals.filter((p) => taken.has(`${p.x},${p.y}`));
  ok(`  · nor on top of other furniture`, onProp.length === 0,
    onProp.map((p) => `${p.desk}@${p.x},${p.y}`).join(" ") || "clear");

  const off = pedestals.filter((p) => p.x < 0 || p.y < 0 || p.x >= th.cols || p.y >= th.rows);
  ok(`  · nor off the edge of the map`, off.length === 0,
    off.map((p) => `${p.desk}@${p.x},${p.y}`).join(" ") || `${th.cols}x${th.rows}`);

  const spots = new Set(pedestals.map((p) => `${p.x},${p.y}`));
  ok(`  · and no two sharing a tile`, spots.size === pedestals.length,
    `${spots.size} distinct spot(s)`);

  // Solid furniture on the walkway between desks is how a desk becomes
  // unreachable, and the pastel pod has exactly one way in.
  ok(`  · all of them walk-through`, props.every((f) => f[3] === false),
    "a pedestal that blocked its tile could seal a pod");

  /**
   * A cabinet standing in a room is addressed by its tile, and the API refuses
   * an address that is not a whole tile.
   *
   * Two of the three original layouts put one on a half tile — 13,9.5 and
   * 15,12.6 — so both answered 400 to every attempt to open them, for as long
   * as they had existed. Nothing said so: a cabinet that will not open looks
   * exactly like a cabinet nobody has tried. A desk cabinet is exempt, because
   * it is found by its desk and the tile is only a note of where to draw it.
   */
  const roomCabs = th.interactives.filter((i) => i.type === "cabinet" && !i.desk);
  const offGrid = roomCabs.filter((i) => !Number.isInteger(i.x) || !Number.isInteger(i.y));
  ok(`  · room cabinets stand on whole tiles`, offGrid.length === 0,
    offGrid.map((i) => `${i.x},${i.y}`).join(" ") || `${roomCabs.length} of them`);

  // ---- and now the room the layout leaves to walk in --------------------------
  const dw = DESK_W[id] ?? 1;
  const box = (x: number, w: number): [number, number] => [x - w / 2, x + w / 2];
  const cabinetOf = (deskId: string) => pedestals.find((p) => p.desk === deskId);

  const sat = new Map<number, typeof desks>();
  for (const d of desks) sat.set(d.y, [...(sat.get(d.y) ?? []), d]);

  let tightest = Infinity, tightestRow = "";
  let wedged = "";
  for (const [row, inRow] of sat) {
    const deskBoxes = inRow.map((d) => box(d.x, dw));
    const cabBoxes = inRow.flatMap((d) => {
      const c = cabinetOf(d.id);
      return c ? [box(c.x, CAB_W)] : [];
    });
    for (const c of cabBoxes) {
      for (const b of deskBoxes) if (overlap(c, b)) wedged = `row ${row}`;
    }
    const gap = widestGap([...deskBoxes, ...cabBoxes]);
    if (gap < tightest) { tightest = gap; tightestRow = `row ${row}`; }
  }

  // One tile is one avatar. Anything less is a gap you can see and not use.
  ok(`  · an aisle left in every desk row`, tightest >= 0.95,
    `narrowest ${tightest.toFixed(2)} tile(s), ${tightestRow}`);
  ok(`  · and no pedestal wedged into a desk`, wedged === "",
    wedged || `${pedestals.length} checked against ${desks.length} desk(s)`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
