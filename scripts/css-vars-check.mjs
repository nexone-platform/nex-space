#!/usr/bin/env node
/**
 * Does every colour this stylesheet asks for actually exist?
 *
 * `var(--nope)` with no fallback is not an error anywhere: the declaration is
 * simply dropped. A background becomes transparent, and the page underneath
 * shows through — which is what happened to the week view, where the office map
 * came up through a calendar that had drawn perfectly.
 *
 * It survived review because the probe that drew the view defined its own
 * :root, so the missing name existed there and nowhere else. This asks the
 * question of the file that ships.
 *
 *   node scripts/css-vars-check.mjs
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const WEB = fileURLToPath(new URL("../apps/web", import.meta.url));
const css = readFileSync(join(WEB, "index.html"), "utf8");

const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));

/**
 * Some are set from script and belong to no stylesheet.
 *
 * The meeting grid works out its own tile size and writes it on the element, so
 * `--tile` is real and nowhere in the CSS. Reading the sources for setProperty
 * is what tells the difference between that and a name nobody ever defined —
 * without it this check reports a working layout as broken, which is worse than
 * not checking.
 */
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "dist") walk(p); }
    else if (/\.ts$/.test(n)) {
      for (const m of readFileSync(p, "utf8").matchAll(/setProperty\(\s*["'`](--[a-z0-9-]+)/gi)) {
        declared.add(m[1]);
      }
    }
  }
};
walk(join(WEB, "src"));
// A fallback makes the name optional — var(--x, #fff) is fine whether or not
// --x exists, and several of those are deliberate.
const used = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)].map((m) => m[1]);

const missing = [...new Set(used.filter((n) => !declared.has(n)))].sort();
if (missing.length) {
  console.error(`! ${missing.length} colour(s) used and never defined:`);
  for (const n of missing) {
    const line = css.slice(0, css.indexOf(`var(${n})`)).split("\n").length;
    console.error(`    ${n}  first used at index.html:${line}`);
  }
  process.exit(1);
}
console.log(`all ${new Set(used).size} referenced custom properties are defined (${declared.size} declared, script included)`);
