#!/usr/bin/env node
// The private-area table exists twice, and the two copies decide different
// things: the browser decides who you can hear, the game server decides who
// receives what you type. If they disagree, a room is private for speech and
// public for text — and nothing else in the build would notice.
//
// Neither app can import from the other (separate Docker build contexts, see
// each Dockerfile's COPY), so the file is copied and this is the guard.
//
//   node scripts/areas-check.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPIES = ["apps/web/src/scenes/areas.ts", "apps/game-server/src/areas.ts"];

// Line endings differ by checkout on Windows and mean nothing here; a trailing
// blank line means nothing either. Everything else does, including a comment —
// the two files are meant to be a copy, and "same values, different words" is
// how a copy starts to rot.
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n").replace(/\s+$/, "");

const [a, b] = COPIES.map(read);
if (a === b) {
  const areas = [...a.matchAll(/id: "([a-z-]+)"/g)].length;
  console.log(`areas: the two copies match (${areas} areas across ${[...a.matchAll(/^  [a-z]+: \[/gm)].length} themes)`);
  process.exit(0);
}

const [la, lb] = [a.split("\n"), b.split("\n")];
const at = la.findIndex((l, i) => l !== lb[i]);
console.error(`areas: the two copies have drifted apart at line ${at + 1}`);
console.error(`  ${COPIES[0]}\n    ${la[at] ?? "(file ends)"}`);
console.error(`  ${COPIES[1]}\n    ${lb[at] ?? "(file ends)"}`);
console.error(`\n  copy one over the other:  cp ${COPIES[0]} ${COPIES[1]}`);
process.exit(1);
