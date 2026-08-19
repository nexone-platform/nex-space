#!/usr/bin/env node
/**
 * Read docker-compose.yml the way docker would, on a machine without docker.
 *
 * Two failures have reached the server from this file, and neither needed a
 * container to catch:
 *
 *   · a required-variable guard (${VAR:?...}), which compose applies to the
 *     WHOLE file before running anything — so it refused every compose command
 *     on a machine that had not configured the relay, deploying included;
 *   · a top-level `volumes:` block deleted by an edit, which makes every service
 *     that mounts a named volume "refer to an undefined volume".
 *
 * Both are structural, so this checks the structure: variables resolve with an
 * empty environment, every named volume a service mounts is declared, and the
 * relay's command still carries the rules that keep it from being used as a way
 * into this machine.
 *
 *   node scripts/compose-check.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const FILE = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));
const RELAY = fileURLToPath(new URL("../deploy/turn/docker-compose.yml", import.meta.url));
const raw = readFileSync(FILE, "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ---- a small YAML reader, enough for this file ------------------------------
// The repo has no YAML dependency and this must run before anything is
// installed, so the shapes this file actually uses are parsed by hand:
// two levels of mapping, list items, and folded scalars.

function parse(text) {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const root = {};
  const stack = [{ indent: -1, node: root }];
  let folding = null;

  for (const line of lines) {
    if (folding) {
      const m = line.match(/^(\s*)(\S.*)$/);
      if (m && m[1].length > folding.indent) { folding.parts.push(m[2]); continue; }
      folding.set(folding.parts.join(" "));
      folding = null;
    }
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const indent = line.match(/^\s*/)[0].length;
    const body = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (body.startsWith("- ")) {
      const arr = Array.isArray(parent) ? parent : null;
      if (arr) arr.push(body.slice(2).trim());
      continue;
    }
    const m = body.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2];

    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts = [];
      folding = { indent, parts, set: (v) => { parent[key] = v; } };
      continue;
    }
    if (value === "") {
      // a mapping or a list — decided by whatever comes next
      const node = {};
      parent[key] = node;
      stack.push({ indent, node });
      continue;
    }
    parent[key] = value;
  }
  if (folding) folding.set(folding.parts.join(" "));
  return root;
}

/**
 * The list under one service key, found by indentation rather than by name
 * order. Matching the first "volumes:" after a service name reads the wrong
 * service the moment two of them have one.
 */
function serviceList(text, service, key) {
  const lines = text.split("\n");
  const out = [];
  let inService = false, serviceIndent = -1, inKey = false, keyIndent = -1;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = line.match(/^\s*/)[0].length;

    if (!inService) {
      if (t === service + ":") { inService = true; serviceIndent = at; }
      continue;
    }
    if (at <= serviceIndent) break;                 // the next service began
    if (inKey) {
      if (t.startsWith("- ") && at > keyIndent) { out.push(t.slice(2).trim()); continue; }
      if (at <= keyIndent) inKey = false;           // the list ended
    }
    if (t === key + ":") { inKey = true; keyIndent = at; }
  }
  return out;
}

const doc = parse(raw);

console.log("\ndocker-compose.yml\n");

// ---- 1. it resolves with nothing in the environment -------------------------

const vars = [...raw.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
const guards = vars.filter((v) => v.includes(":?"));
ok("no required-variable guard", guards.length === 0,
  guards.length ? `${guards.join(", ")} — this blocks EVERY compose command, not one service` : `${vars.length} variables, all with defaults`);

// ---- 2. every named volume is declared --------------------------------------

const declared = Object.keys(doc.volumes ?? {});
const mounts = [];
for (const [name] of Object.entries(doc.services ?? {})) {
  for (const v of serviceList(raw, name, "volumes")) {
    const src = String(v).split(":")[0];
    if (src && !src.startsWith("/") && !src.startsWith(".")) mounts.push([name, src]);
  }
}
const undeclared = mounts.filter(([, src]) => !declared.includes(src));
ok("every named volume is declared", undeclared.length === 0,
  undeclared.length ? undeclared.map(([s, v]) => `${s} → ${v}`).join(", ") : `${declared.join(", ") || "none"}`);

// ---- 3. the file still has all of its parts ---------------------------------

const services = Object.keys(doc.services ?? {});
ok("the four services are present", services.length === 4, services.join(" "));
ok("the data volume is still there", declared.includes("nexspace-api-data"));

// ---- 4. the relay is still fenced in ----------------------------------------

const turn = doc.services?.["nexspace-turn"];
const cmd = String(turn?.command ?? "");
const deny = (cmd.match(/--denied-peer-ip=/g) || []).length;
ok("the relay refuses the private network", deny >= 9, `${deny} deny rules`);
ok("  · including this machine itself", cmd.includes("--denied-peer-ip=127.0.0.0-127.255.255.255"));
ok("  · and the docker bridge range", cmd.includes("--denied-peer-ip=172.16.0.0-172.31.255.255"));
ok("the relay has no admin console", cmd.includes("--no-cli"));
ok("the relay is off unless asked for", String(turn?.profiles ?? "").includes("turn"));

// ---- 5. optional arguments disappear when unset -----------------------------

const interp = (env) => cmd.replace(/\$\{([A-Z_]+)(:[-+])([^}]*)\}/g, (_, name, op, word) => {
  const set = env[name] !== undefined && env[name] !== "";
  return op === ":-" ? (set ? env[name] : word) : (set ? word : "");
});
const bare = interp({}).trim().split(/\s+/).filter(Boolean);
const full = interp({ TURN_SECRET: "s", TURN_EXTERNAL_IP: "203.0.113.10" }).trim().split(/\s+/).filter(Boolean);
ok("an unset external address leaves no empty argument",
  !bare.some((a) => a === "" || a === "--external-ip="), bare.length + " arguments");
ok("  · and a set one is passed through", full.includes("--external-ip=203.0.113.10"));

// ---- 6. the relay's own file, for a machine of its own ----------------------
// Same fences, different rule about guards: that file holds one service, and it
// is the service the secret belongs to, so refusing to start without it is
// right. The rule is not "never guard" — it is "never make one service's
// missing setting everyone else's problem".

console.log("\ndeploy/turn/docker-compose.yml\n");

const relayRaw = readFileSync(RELAY, "utf8");
const relayDoc = parse(relayRaw);
const relayServices = Object.keys(relayDoc.services ?? {});
const relayCmd = String(relayDoc.services?.coturn?.command ?? "");
const relayVars = [...relayRaw.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
const relayGuards = relayVars.filter((v) => v.includes(":?"));

ok("it stands alone", relayServices.length === 1 && relayServices[0] === "coturn", relayServices.join(" ") || "no services");
ok("requiring the secret is allowed here", relayGuards.length === 1 && relayGuards[0].startsWith("TURN_SECRET"),
  relayGuards.join(", ") || "none — a relay with no secret should not start");
ok("nothing else is required",
  relayVars.filter((v) => v.includes(":?") && !v.startsWith("TURN_SECRET")).length === 0);

const relayDeny = (relayCmd.match(/--denied-peer-ip=/g) || []).length;
ok("the same fences are up", relayDeny >= 9, `${relayDeny} deny rules`);
ok("  · and no admin console", relayCmd.includes("--no-cli"));

const relayArgs = (env) => relayCmd
  .replace(/\$\{([A-Z_]+):\?[^}]*\}/g, (_, n) => env[n] ?? "")
  .replace(/\$\{([A-Z_]+)(:[-+])([^}]*)\}/g, (_, n, op, w) => {
    const set = env[n] !== undefined && env[n] !== "";
    return op === ":-" ? (set ? env[n] : w) : (set ? w : "");
  })
  .trim().split(/\s+/).filter(Boolean);

const plain = relayArgs({ TURN_SECRET: "s" });
ok("with only a secret set, nothing optional is left dangling",
  !plain.some((a) => a.endsWith("=") || a === ""), `${plain.length} arguments`);

const tls = relayArgs({ TURN_SECRET: "s", TURN_TLS_PORT: "443", TURN_CERT: "/certs/a.pem", TURN_KEY: "/certs/b.pem" });
ok("TLS turns on as one piece", ["--tls-listening-port=443", "--cert=/certs/a.pem", "--pkey=/certs/b.pem"].every((a) => tls.includes(a)));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
