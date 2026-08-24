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

if (!bad) console.log(`copies: ${PAIRS.length} duplicated files match their twin`);
process.exit(bad ? 1 : 0);
