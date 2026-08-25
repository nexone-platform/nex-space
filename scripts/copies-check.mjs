#!/usr/bin/env node
// Files that exist twice on purpose, and must not drift.
//
// The web app and the game server and the API build from three separate Docker
// contexts — each Dockerfile copies only its own app directory — so none of
// them can import from another. A handful of rules have to be enforced in more
// than one place, and the honest way to do that is a copy plus a guard.
//
// Each pair below decides the same thing on both sides. If they disagree,
// nothing else in the build notices:
//
//   areas       the browser decides who you can hear, the server decides who
//               receives what you type
//   mapValidate the API refuses a bad map at the door, the browser refuses one
//               it is handed
//
//   node scripts/copies-check.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAIRS = [
  { what: "private areas", a: "apps/web/src/scenes/areas.ts", b: "apps/game-server/src/areas.ts" },
  { what: "map validation", a: "apps/web/src/scenes/mapValidate.ts", b: "apps/api/src/mapValidate.ts" },
];

// Line endings differ by checkout on Windows and mean nothing here; a trailing
// blank line means nothing either. Everything else does, including a comment —
// these are meant to be copies, and "same values, different words" is how a
// copy starts to rot.
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n").replace(/\s+$/, "");

let bad = 0;
for (const { what, a, b } of PAIRS) {
  const [x, y] = [read(a), read(b)];
  if (x === y) {
    console.log(`  ${what}: identical (${x.split("\n").length} lines)`);
    continue;
  }
  bad++;
  const [la, lb] = [x.split("\n"), y.split("\n")];
  const at = la.findIndex((l, i) => l !== lb[i]);
  console.error(`! ${what}: the copies have drifted apart at line ${at + 1}`);
  console.error(`    ${a}\n      ${la[at] ?? "(file ends)"}`);
  console.error(`    ${b}\n      ${lb[at] ?? "(file ends)"}`);
  console.error(`    copy one over the other:  cp ${a} ${b}`);
}

// ---- lists that have to agree, in files that are not copies ------------------
//
// The browser offers these and the game server refuses anything not on its own
// list. An entry on one side only is a button that does nothing when pressed.

const LISTS = [
  {
    what: "stickers",
    a: { file: "apps/web/src/scenes/OfficeScene.ts", re: /const STICKER_SET = \[([^\]]+)\]/ },
    b: { file: "apps/game-server/src/rooms/OfficeRoom.ts", re: /const STICKERS = \[([^\]]+)\]/ },
  },
  {
    what: "gestures",
    a: { file: "apps/web/src/scenes/OfficeScene.ts", re: /EMOTES: Record<[^>]+> = \{([\s\S]*?)\};/, keys: true },
    b: { file: "apps/game-server/src/rooms/OfficeRoom.ts", re: /const EMOTES = \[([^\]]+)\]/ },
  },
];

const values = ({ file, re, keys }) => {
  const src = readFileSync(join(ROOT, file), "utf8");
  const m = re.exec(src);
  if (!m) throw new Error(`${file}: could not find the list`);
  if (keys) return [...m[1].matchAll(/^\s{4}(\w+):/gm)].map((k) => k[1]).sort();
  // the source is a JS array literal of strings, so JSON can read it once the
  // whitespace is gone — and any escape in it has already been resolved by tsc
  return JSON.parse(`[${m[1].replace(/\s+/g, "")}]`).sort();
};

for (const { what, a, b } of LISTS) {
  let x, y;
  try { x = values(a); y = values(b); } catch (e) {
    bad++;
    console.error(`! ${what}: ${e.message}`);
    continue;
  }
  if (JSON.stringify(x) === JSON.stringify(y)) {
    console.log(`  ${what}: both sides offer the same ${x.length}`);
    continue;
  }
  bad++;
  const only = (p, q) => p.filter((v) => !q.includes(v));
  console.error(`! ${what}: the two lists disagree`);
  if (only(x, y).length) console.error(`    only in ${a.file}: ${only(x, y).join(" ")}`);
  if (only(y, x).length) console.error(`    only in ${b.file}: ${only(y, x).join(" ")}`);
}

if (!bad) console.log(`copies: ${PAIRS.length} duplicated files and ${LISTS.length} shared lists all agree`);
process.exit(bad ? 1 : 0);
