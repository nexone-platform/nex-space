#!/usr/bin/env node
// The things about nginx.conf that have actually gone wrong here.
//
// nginx is the one piece of this deployment that can take the whole site down
// while every other container is healthy, and it does it at start-up: a config
// it refuses means no web app at all, not a broken page. `nginx -t` is the real
// check and it needs nginx; this is what can be known without it.
//
// Three things, each of them a thing that happened:
//
//   braces      a config nginx refuses does not serve a 500, it fails to start
//   upstreams   a literal proxy_pass to a service that may not exist is
//               resolved when the config is read, and nginx refuses to start if
//               the name is not there. An optional service — one behind a
//               compose profile — must go through a variable and a resolver so
//               the name is looked up per request instead.
//   caching     index.html carries content-hashed asset URLs. Cached, it points
//               at the build before the current one, and a deploy reaches
//               nobody who already had the page — which is exactly how a whole
//               deploy went invisible.
//
//   node scripts/nginx-check.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = readFileSync(join(ROOT, "apps/web/nginx.conf"), "utf8");
const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ---- braces ---------------------------------------------------------------
// Comments can hold anything, so they come out first.
const bare = conf.replace(/#[^\n]*/g, "");
let depth = 0, floor = 0;
for (const ch of bare) {
  if (ch === "{") depth++;
  else if (ch === "}") { depth--; if (depth < floor) floor = depth; }
}
ok("every block is closed", depth === 0, `ends at depth ${depth}`);
ok("  · and none closes before it opens", floor === 0, `reached ${floor}`);

// ---- upstreams that may not exist -----------------------------------------
// A service behind a compose profile is not running unless that profile is on.
// nginx resolves a literal host in proxy_pass when it reads the config, so one
// of those is a config that refuses to start on a deployment that did not opt
// in — which took this site down once, for everybody, over an optional
// feature nobody had enabled.
const optional = [...compose.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)]
  .map((m) => m[1])
  .filter((name) => {
    // From this service's own line to the next one at the same indent. The
    // first attempt looked for the next line starting with two spaces and
    // found the service's own first property, so every body was one line long
    // and nothing was ever optional — a check that passed by never looking.
    const lines = compose.split("\n");
    const at = lines.findIndex((l) => l.trimEnd() === `  ${name}:`);
    if (at < 0) return false;
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
      if (/^ {2}[a-z0-9-]+:\s*$/.test(lines[i])) { end = i; break; }
    }
    return lines.slice(at, end).some((l) => /^\s+profiles:/.test(l));
  });

const literal = [...conf.matchAll(/proxy_pass\s+https?:\/\/([a-z0-9-]+)/g)].map((m) => m[1]);
const risky = literal.filter((h) => optional.includes(h));
ok(`no optional service is a literal upstream (${optional.length} optional: ${optional.join(" ") || "none"})`,
  risky.length === 0,
  risky.length ? `${risky.join(" ")} — use a variable and a resolver` : "");

// ---- what the browser is allowed to keep -----------------------------------
const html = /location\s+~\*?\s+\\\.html\$\s*\{([^}]*)\}/.exec(conf);
ok("the entry pages have a cache rule of their own", !!html,
  html ? "" : "without one the browser invents a heuristic, and a deploy goes invisible");
if (html) {
  ok("  · and it is no-cache", /add_header\s+Cache-Control\s+"no-cache"/.test(html[1]),
    (html[1].match(/Cache-Control[^;]*/) || ["nothing"])[0].trim());
}
const assets = /location\s+\/assets\/\s*\{([^}]*)\}/.exec(conf);
ok("the hashed assets have one too", !!assets);
if (assets) {
  ok("  · keeping them, since the name changes when the contents do",
    /immutable/.test(assets[1]),
    (assets[1].match(/Cache-Control[^;]*/) || ["nothing"])[0].trim());
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
