#!/usr/bin/env node
/**
 * The filing cabinet, over HTTP.
 *
 * cabinet.test.mts already proves the rule. This proves the rule is what the
 * routes actually apply — which is a different claim, and the one that has
 * historically been wrong: a tested function nothing calls, a listing that
 * filters correctly beside a fetch-by-id that does not.
 *
 * Most of it is refusal, and the shape of the refusal matters as much as the
 * fact of it. A cabinet somebody may not see answers 404, never 403: "forbidden"
 * on a cabinet named "เงินเดือนผู้บริหาร" confirms it exists, which is most of
 * what anybody poking at it wanted to learn.
 *
 *   npm run dev
 *   node apps/api/scripts/cabinet-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3991;
const API = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, path, { body, token } = {}) => {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const get = (p, token) => call("GET", p, { token });
const post = (p, body, token) => call("POST", p, { body, token });
const put = (p, body, token) => call("PUT", p, { body, token });
const patch = (p, body, token) => call("PATCH", p, { body, token });
const del = (p, token) => call("DELETE", p, { token });

try {
  await fetch(`${API}/health`, { signal: AbortSignal.timeout(700) });
  console.error(`! something is already listening on ${PORT} — stop it first`);
  process.exit(1);
} catch { /* free */ }

const api = spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
api.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[api] ${d}`));
const stop = () => { try { api.kill(); } catch { /* gone */ } };
process.on("exit", stop);

console.log("\nthe filing cabinet\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await settle(500); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast --------------------------------------------------------------------------
const stamp = Date.now();
const person = async (who) => {
  const d = await post("/auth/register", {
    email: `cab-${who}-${stamp}@test.local`, name: who, password: "hunter2pw",
  });
  return { name: who, token: d.token, id: d.user?.id };
};

const owner = await person("owner");
const admin = await person("admin");
const hr = await person("hr");
const staff = await person("staff");
const outsider = await person("outsider");

const ws = (await post("/workspaces", { name: `cab-${stamp}` }, owner.token)).workspace;
for (const p of [admin, hr, staff]) await post("/workspaces/join", { code: ws.inviteCode }, p.token);
await patch(`/workspaces/${ws.slug}/members/${admin.id}`, { role: "admin" }, owner.token);
const W = `/workspaces/${ws.slug}`;
const AT = `${W}/cabinets/at/main/11/9`;

// ---- it comes into being when somebody walks up to it -------------------------------
{
  const first = await get(AT, staff.token);
  ok("the first person to open a cabinet brings it into being", first.status === 200
    && !!first.cabinet?.id, String(first.status));
  ok("  · named, and standing where the map said", first.cabinet?.at?.x === 11
    && first.cabinet?.at?.y === 9 && !!first.cabinet?.label,
    `${first.cabinet?.label} @ ${first.cabinet?.at?.x},${first.cabinet?.at?.y}`);
  ok("  · open to the space, which is the safest thing a new one can be",
    first.cabinet?.openTo === "members", first.cabinet?.openTo);

  const again = await get(AT, admin.token);
  ok("  · and the next person opens the same one, not a second",
    again.cabinet?.id === first.cabinet?.id);
}
const CAB = (await get(AT, owner.token)).cabinet.id;
const C = `${W}/cabinets/${CAB}`;

// ---- who may change it --------------------------------------------------------------
{
  const said = await patch(C, { label: "ตู้เอกสาร HR" }, admin.token);
  ok("an admin may name it", said.status === 200 && said.cabinet?.label === "ตู้เอกสาร HR",
    String(said.status));
  const refused = await patch(C, { label: "ของฉัน" }, staff.token);
  ok("  · a member may not — and is told so rather than quietly ignored",
    refused.status === 403, String(refused.status));
  const blank = await patch(C, { label: "   " }, owner.token);
  ok("  · a name of nothing is refused", blank.status === 400, String(blank.status));
  const nonsense = await patch(C, { openTo: "everyone" }, owner.token);
  ok("  · and so is an openTo nobody defined", nonsense.status === 400,
    "'everyone' would have to mean guests too");
}

// ---- filing ------------------------------------------------------------------------
let DOC = "";
{
  const filed = await post(`${C}/docs`, {
    title: "สัญญาจ้าง 2026", url: "https://drive.google.com/file/d/abc/view", provider: "google",
    fileId: "abc",
  }, admin.token);
  ok("an admin files a document", filed.status === 201 && !!filed.doc?.id, String(filed.status));
  ok("  · and the listing remembers who put it there", filed.doc?.addedBy === "admin",
    String(filed.doc?.addedBy));
  DOC = filed.doc.id;

  const member = await post(`${C}/docs`, { title: "บันทึก", url: "https://example.test/x" }, staff.token);
  ok("a member of an open cabinet may read it but not file in it", member.status === 403,
    String(member.status));

  for (const [what, url] of [
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html;base64,PHNjcmlwdD4="],
    ["nonsense", "not a url at all"],
  ]) {
    const bad = await post(`${C}/docs`, { title: "x", url }, owner.token);
    ok(`  · a ${what} link is refused`, bad.status === 400,
      "every member of the space renders this list");
  }
  const noName = await post(`${C}/docs`, { title: "  ", url: "https://example.test/" }, owner.token);
  ok("  · and a document with no name", noName.status === 400, String(noName.status));
}

// ---- an open cabinet, read by everybody ---------------------------------------------
{
  const seen = await get(AT, staff.token);
  ok("a member sees the document in an open cabinet",
    seen.docs?.some((d) => d.id === DOC), String(seen.docs?.length));
  ok("  · and is told why they can", seen.docs?.[0]?.why === "cabinet-open", seen.docs?.[0]?.why);
  ok("  · with read, not filing", seen.docs?.[0]?.level === "read" && seen.docs?.[0]?.mayManage === false);
  const boss = await get(AT, owner.token);
  ok("  · while the owner is told it is their role that opens it",
    boss.docs?.[0]?.why === "runs-the-space", boss.docs?.[0]?.why);
}

// ---- shutting the cabinet -----------------------------------------------------------
{
  await patch(C, { openTo: "listed" }, owner.token);
  const shut = await get(AT, staff.token);
  ok("a cabinet shut to the space is not there at all for a member",
    shut.status === 404, String(shut.status));
  ok("  · 404 and not 403, so the refusal does not confirm the name",
    shut.error === "not found", String(shut.error));

  const listed = await get(`${W}/cabinets?map=main`, staff.token);
  ok("  · and it is gone from the listing too", !listed.cabinets?.some((c) => c.id === CAB),
    `${listed.cabinets?.length} cabinet(s)`);

  const boss = await get(AT, admin.token);
  ok("an admin still opens it, whatever it says", boss.status === 200, String(boss.status));
}

// ---- names on the cabinet -----------------------------------------------------------
{
  const set = await put(`${C}/grants`, { grants: [{ userId: hr.id, level: "file" }] }, admin.token);
  ok("an admin puts a name on it", set.status === 200 && set.grants === 1, String(set.status));

  const theirs = await get(AT, hr.token);
  ok("  · and that person opens it", theirs.status === 200, String(theirs.status));
  ok("  · told it was the name, not the cabinet", theirs.docs?.[0]?.why === "named-on-cabinet",
    theirs.docs?.[0]?.why);
  ok("  · with filing rights, being more than read", theirs.cabinet?.level === "file");
  const filed = await post(`${C}/docs`, { title: "ใบลา", url: "https://example.test/leave" }, hr.token);
  ok("  · so they can actually file", filed.status === 201, String(filed.status));

  const still = await get(AT, staff.token);
  ok("  · and the person beside them still cannot", still.status === 404, String(still.status));

  const byMember = await put(`${C}/grants`, { grants: [{ userId: staff.id, level: "file" }] }, staff.token);
  ok("a member cannot hand themselves access", byMember.status === 403, String(byMember.status));
  const stranger = await put(`${C}/grants`, { grants: [{ userId: outsider.id, level: "read" }] }, owner.token);
  ok("  · and an account outside the space cannot be named at all", stranger.status === 400,
    "access nobody could account for");
  const junk = await put(`${C}/grants`, { grants: [{ userId: hr.id, level: "write" }] }, owner.token);
  ok("  · nor a level nobody defined", junk.status === 400, String(junk.status));
}

// ---- one document, reaching out of a shut cabinet ------------------------------------
{
  const set = await put(`${C}/docs/${DOC}/grants`, { grants: [{ userId: staff.id, level: "read" }] },
    owner.token);
  ok("a name on one document inside a cabinet somebody cannot open", set.status === 200,
    String(set.status));

  const seen = await get(AT, staff.token);
  ok("  · opens the cabinet enough to show that document", seen.status === 200, String(seen.status));
  ok("  · and only that one", seen.docs?.length === 1 && seen.docs?.[0]?.id === DOC,
    `${seen.docs?.length} document(s)`);
  ok("  · named as the document's doing", seen.docs?.[0]?.why === "named-on-document",
    seen.docs?.[0]?.why);
  ok("  · while the cabinet itself stays shut to them", seen.cabinet?.level === "none",
    seen.cabinet?.level);
  ok("  · so they cannot file into it", (await post(`${C}/docs`,
    { title: "x", url: "https://example.test/x" }, staff.token)).status === 403);

  const listed = await get(`${W}/cabinets?map=main`, staff.token);
  ok("  · and the listing shows the cabinet again, holding one",
    listed.cabinets?.find((c) => c.id === CAB)?.docs === 1,
    JSON.stringify(listed.cabinets?.find((c) => c.id === CAB)?.docs));
}

// ---- one document shut inside an open cabinet ----------------------------------------
{
  await patch(C, { openTo: "members" }, owner.token);
  const shut = await patch(`${C}/docs/${DOC}`, { openTo: "listed" }, owner.token);
  ok("a single document can be shut inside a cabinet everybody uses", shut.status === 200,
    String(shut.status));

  const them = await get(AT, hr.token);
  ok("  · and is gone for somebody the cabinet lets in", !them.docs?.some((d) => d.id === DOC),
    `${them.docs?.length} document(s)`);
  ok("  · while the rest of the cabinet is still theirs", (them.docs?.length ?? 0) > 0);

  const named = await get(AT, staff.token);
  ok("  · except for the one person named on it", named.docs?.some((d) => d.id === DOC));

  const reach = await patch(`${C}/docs/${DOC}`, { title: "เปลี่ยนชื่อ" }, staff.token);
  ok("  · who may read it and not rename it", reach.status === 403, String(reach.status));
  const gone = await del(`${C}/docs/${DOC}`, hr.token);
  ok("  · and somebody who cannot see it is told it is not there, not that it is refused",
    gone.status === 404, String(gone.status));
}

// ---- nothing leaks between spaces ----------------------------------------------------
{
  const theirs = (await post("/workspaces", { name: `cab-other-${stamp}` }, outsider.token)).workspace;
  const borrowed = await get(`/workspaces/${theirs.slug}/cabinets/${CAB}/grants`, outsider.token);
  ok("a cabinet id from another space is not found in this one", borrowed.status === 404,
    String(borrowed.status));
  const peek = await get(AT, outsider.token);
  ok("  · and somebody with no membership is refused outright", peek.status === 403,
    String(peek.status));
}

// ---- taking one out -------------------------------------------------------------------
{
  const gone = await del(`${C}/docs/${DOC}`, admin.token);
  ok("an admin takes a document out", gone.status === 200, String(gone.status));
  const after = await get(AT, admin.token);
  ok("  · and it is gone", !after.docs?.some((d) => d.id === DOC));
  ok("  · with its names gone too, rather than left pointing at nothing",
    (await put(`${C}/docs/${DOC}/grants`, { grants: [] }, owner.token)).status === 404);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
stop();
process.exit(fail ? 1 : 0);
