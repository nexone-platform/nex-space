/**
 * Every team size the wizard asks about has an office that can seat it.
 *
 * This is the bug, stated as a check. The wizard asked whether the company was
 * 1-10, 11-50 or 51+, stored the answer on the account, and then offered three
 * layouts holding six, ten and ten desks. Two of its own three answers had
 * nothing behind them. Nothing was broken in any way a program could notice —
 * the question rendered, the space was created, and the shortfall only appeared
 * weeks later when the eleventh person went looking for somewhere to sit.
 *
 *   npm run check:sizes -w @nexspace/web
 */
const g = globalThis as Record<string, unknown>;
g.location = { search: "", href: "http://localhost/", pathname: "/" };
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };

const { THEMES } = await import("../src/scenes/mapThemes.js");
const { SIZES, seatsFor } = await import("../src/spaceSize.js");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

console.log("\na desk for everybody the wizard asks about\n");

const layouts = Object.entries(THEMES)
  .map(([id, th]) => ({ id, label: th.label, desks: th.desks.length }))
  .sort((a, b) => a.desks - b.desks);

for (const l of layouts) console.log(`        ${l.id.padEnd(12)} ${String(l.desks).padStart(3)} desks   ${l.label}`);
console.log("");

for (const size of SIZES) {
  const seats = seatsFor(size.label);
  ok(`"${size.label}" needs ${seats} desks`, seats > 0,
    "a bracket that asks for nothing would be answered by any layout at all");
  const fit = layouts.filter((l) => l.desks >= seats);
  ok(`  · and something seats them`, fit.length > 0,
    fit.length ? fit.map((l) => `${l.id} (${l.desks})`).join(", ")
      : `the largest is ${layouts[layouts.length - 1].id} with ${layouts[layouts.length - 1].desks}`);
}

/**
 * And no layout at all is too small for the smallest team.
 *
 * Asking only whether SOME office fits each bracket was the weaker half of the
 * question, and it passed while the pastel office — the first card on the
 * screen, and the one every early space is on — seated six against a smallest
 * bracket of ten. A layout nobody can offer to anybody is not a layout.
 */
const smallest = Math.min(...SIZES.map((s) => s.seats));
for (const l of layouts) {
  ok(`${l.id} seats the smallest team on offer`, l.desks >= smallest,
    `${l.desks} desks against a smallest bracket of ${smallest}`);
}

ok("an answer nobody recognises asks for nothing", seatsFor("some other thing") === 0,
  "an old account, or a hand-edited profile — better no filter than the wrong one");
ok("  · and so does no answer at all", seatsFor(undefined) === 0 && seatsFor(null) === 0);

// ---- and the layouts themselves hold together ---------------------------------------
for (const [id, th] of Object.entries(THEMES)) {
  const ids = th.desks.map((d) => d.id);
  ok(`${id}: every desk id is its own`, new Set(ids).size === ids.length,
    `${ids.length} desk(s), ${new Set(ids).size} distinct — a repeat means two people share one seat`);
  ok(`  · and it has desks at all`, ids.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
