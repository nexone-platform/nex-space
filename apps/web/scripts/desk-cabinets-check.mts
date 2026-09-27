/**
 * Every desk has a cabinet, and every cabinet has somewhere to stand.
 *
 * The pedestal beside a desk is placed by a rule — one tile to the left — not
 * by hand. That is what keeps it right when a desk is added, and also what
 * makes it silent when it is wrong: move a desk against a wall and its cabinet
 * is drawn inside that wall, on a map nobody opens until a customer does.
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
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
