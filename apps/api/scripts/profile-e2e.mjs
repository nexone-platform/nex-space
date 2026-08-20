#!/usr/bin/env node
/**
 * A profile, and who is allowed to read one.
 *
 * The rule worth holding: a card is readable because you share a space with its
 * owner, not because you know their account id. Anything looser turns a
 * workspace into a directory of every account on the server.
 *
 *   npm run dev
 *   node apps/api/scripts/profile-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3981;
const API = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const call = async (method, path, { body, token } = {}) => {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const post = (p, body, token) => call("POST", p, { body, token });
const put = (p, body, token) => call("PUT", p, { body, token });
const get = (p, token) => call("GET", p, { token });

try {
  await fetch(`${API}/health`, { signal: AbortSignal.timeout(700) });
  console.error(`! something is already listening on ${PORT}`);
  process.exit(1);
} catch { /* free */ }

const api = spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
const stop = () => { try { api.kill(); } catch { /* gone */ } };
process.on("exit", stop);

console.log("\nprofiles\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { /* not yet */ }
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

const stamp = Date.now();
const person = async (who) => {
  const d = await post("/auth/register", { email: `pf-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });
  return { name: who, token: d.token, id: d.user?.id };
};

const alice = await person("alice");
const bob = await person("bob");
const stranger = await person("stranger");

const ws = (await post("/workspaces", { name: `pf-${stamp}` }, alice.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, bob.token);
await post("/workspaces", { name: `far-${stamp}` }, stranger.token);

// ---- writing your own -------------------------------------------------------

{
  const r = await put("/me/profile", {
    name: "Alice A", team: "ฝ่ายพัฒนา", timezone: "Asia/Bangkok",
    bio: "ดูแลระบบห้องประชุมและเสียง",
  }, alice.token);
  ok("a profile can be written", r.status === 200, `status ${r.status}`);
  ok("  · and comes back on the account", r.user?.team === "ฝ่ายพัฒนา" && r.user?.timezone === "Asia/Bangkok");
  ok("  · including the display name", r.user?.name === "Alice A", r.user?.name);
}
{
  const long = "x".repeat(400);
  const r = await put("/me/profile", { bio: long, team: long, timezone: long }, alice.token);
  ok("long fields are cut to what a card can hold",
    r.user?.bio.length === 280 && r.user?.team.length === 60 && r.user?.timezone.length === 60,
    `${r.user?.bio.length}/${r.user?.team.length}/${r.user?.timezone.length}`);
}
{
  const r = await put("/me/profile", { bio: "   ", team: "", timezone: "" }, alice.token);
  ok("blank fields clear rather than store whitespace",
    r.user?.bio === null && r.user?.team === null && r.user?.timezone === null,
    JSON.stringify([r.user?.bio, r.user?.team, r.user?.timezone]));
}
{
  const r = await put("/me/profile", { name: "   " }, alice.token);
  ok("a blank name is ignored, not applied", r.user?.name === "Alice A", r.user?.name);
}
{
  const r = await put("/me/profile", { bio: "hello" });
  ok("a stranger cannot write one", r.status === 401, `status ${r.status}`);
}

// put something back for the reading tests
await put("/me/profile", { name: "Alice A", team: "ฝ่ายพัฒนา", timezone: "Asia/Bangkok", bio: "ดูแลระบบเสียง" }, alice.token);

// ---- reading someone else's -------------------------------------------------

{
  const r = await get(`/workspaces/${ws.slug}/members/${alice.id}`, bob.token);
  ok("someone in the same space can read it", r.status === 200, `status ${r.status}`);
  ok("  · with the parts worth showing", r.profile?.team === "ฝ่ายพัฒนา" && r.profile?.bio === "ดูแลระบบเสียง");
  ok("  · and the workspace role, which is not the job title", r.profile?.memberRole === "owner", r.profile?.memberRole);
  ok("  · marked as not being them", r.profile?.isMe === false);
}
{
  const r = await get(`/workspaces/${ws.slug}/members/${alice.id}`, alice.token);
  ok("your own card knows it is yours", r.profile?.isMe === true);
}
{
  const r = await get(`/workspaces/${ws.slug}/members/${alice.id}`, stranger.token);
  ok("an account outside the space reads nothing", r.status === 401, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/members/${stranger.id}`, bob.token);
  ok("and cannot be read about from inside it either", r.status === 404, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/members/${alice.id}`);
  ok("no session, no card", r.status === 401, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/members/nobody-at-all`, bob.token);
  ok("an invented account id is a 404, not a leak", r.status === 404, `status ${r.status}`);
}

// ---- the email address is not part of a card --------------------------------

{
  const r = await get(`/workspaces/${ws.slug}/members/${alice.id}`, bob.token);
  ok("a card carries no email address", !("email" in (r.profile ?? {})),
    Object.keys(r.profile ?? {}).join(", "));
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
