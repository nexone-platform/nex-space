// Does every Thai string the user can see have an English translation?
//
// The Thai text is the key (see src/i18n.ts), which makes a missing entry
// invisible at runtime: the phrase simply stays Thai. This script is what
// notices instead.
//
//   npm run -w @nexspace/web i18n
//
// Two checks:
//   missing English — a key routed through t() or sitting in index.html with no
//                     entry in the dictionary
//   unwrapped       — a Thai literal in the source that never reaches t()
//
// A handful of "unwrapped" hits are expected: data tables (STATE_LABEL, TABS,
// TITLES, the theme labels) deliberately hold Thai and are translated where they
// are displayed, and this script cannot see that from one line of source.
import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (!["node_modules", "dist", "public", "scripts"].includes(n)) walk(p); }
    // i18n.ts is the dictionary; artCredits.ts, mapThemes.ts and areas.ts are
    // data whose display sites call t()
    else if (/\.(ts|html)$/.test(n) && !/(i18n|artCredits|mapThemes|areas)\.ts$/.test(n)) files.push(p);
  }
};
walk(join(ROOT, "src"));
/** the pages with Thai sitting directly in the markup */
const PAGES = ["index.html", "editor.html", "admin.html"];

const THAI = /[฀-๿]/;
const dict = new Set();
// A key written twice is not an error the language ever shows: the second entry
// silently replaces the first, so a phrase quietly changes its translation the
// moment somebody adds an entry that already exists. TypeScript catches it in
// this file, but only because the dictionary happens to be a literal — so it is
// worth naming here, where the message says which key.
const duplicates = [];
for (const m of readFileSync(join(ROOT, "src/i18n.ts"), "utf8").matchAll(/^\s*"((?:[^"\\]|\\.)+)":/gm)) {
  const key = m[1].replace(/\\"/g, '"');
  if (dict.has(key)) duplicates.push(key);
  dict.add(key);
}
for (const d of duplicates) console.log(`duplicate ${d.slice(0, 70)}`);

let missing = 0, unwrapped = 0;

for (const f of files.filter((f) => f.endsWith(".ts"))) {
  const code = readFileSync(f, "utf8");
  const rel = f.replace(ROOT, "web");
  for (const m of code.matchAll(/\bt(?:r)?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const k = m[1].replace(/\\"/g, '"');
    if (THAI.test(k) && !dict.has(k)) { missing++; console.log(`no EN     ${rel}: ${k.slice(0, 70)}`); }
  }
  code.split("\n").forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) return;
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
      const body = m[1] ?? m[2] ?? m[3] ?? "";
      if (!THAI.test(body)) continue;
      const before = line.slice(0, m.index);
      if (/\bt(?:r)?\(\s*$/.test(before)) continue;
      if (/\blabel:\s*$/.test(before)) continue;           // a data table's label
      unwrapped++;
      console.log(`unwrapped ${rel}:${i + 1}  ${body.slice(0, 70)}`);
    }
  });
}

const norm = (s) => s.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
for (const page of PAGES) {
  const html = readFileSync(join(ROOT, page), "utf8")
    // <title> is chrome the translator never walks, and the two <style> and
    // <script> blocks are not text anybody reads
    .replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<title[\s\S]*?<\/title>/g, "");
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const s = norm(m[1]);
    if (s && THAI.test(s) && !dict.has(s)) { missing++; console.log(`no EN     ${page} text: ${s.slice(0, 70)}`); }
  }
  for (const m of html.matchAll(/(?:placeholder|title|alt|aria-label)="([^"]+)"/g)) {
    const s = norm(m[1]);
    if (THAI.test(s) && !dict.has(s)) { missing++; console.log(`no EN     ${page} attr: ${s.slice(0, 70)}`); }
  }
}

console.log(`\ndictionary entries: ${dict.size}`);
console.log(`duplicate keys:     ${duplicates.length}`);
console.log(`missing English:    ${missing}`);
console.log(`unwrapped literals: ${unwrapped}  (data tables are expected here)`);
process.exit(missing || duplicates.length ? 1 : 0);
