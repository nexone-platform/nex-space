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

// ---- drawers -------------------------------------------------------------------------
let FOLDER = "";
{
  await patch(C, { openTo: "members" }, owner.token);
  const made = await post(`${C}/folders`, { name: "สัญญา" }, admin.token);
  ok("an admin makes a drawer", made.status === 201 && !!made.folder?.id, String(made.status));
  FOLDER = made.folder.id;
  ok("  · which follows the cabinet until somebody says otherwise",
    made.folder.openTo === null, JSON.stringify(made.folder.openTo));

  const byMember = await post(`${C}/folders`, { name: "ของฉัน" }, staff.token);
  ok("  · a member who may only read the cabinet may not make one",
    byMember.status === 403, String(byMember.status));
  const noName = await post(`${C}/folders`, { name: "   " }, owner.token);
  ok("  · and a drawer with no name is refused", noName.status === 400, String(noName.status));
}

// ---- filing into one ------------------------------------------------------------------
let INSIDE = "";
{
  const filed = await post(`${C}/docs`, {
    title: "สัญญา A", url: "https://drive.google.com/file/d/aaa/view", folderId: FOLDER,
  }, admin.token);
  ok("a document can be filed into a drawer", filed.status === 201, String(filed.status));
  ok("  · and says which drawer it is in", filed.doc?.folderId === FOLDER, String(filed.doc?.folderId));
  INSIDE = filed.doc.id;

  const nowhere = await post(`${C}/docs`, {
    title: "x", url: "https://example.test/x", folderId: "fld_does_not_exist",
  }, owner.token);
  ok("  · a drawer that does not exist is not a place to file", nowhere.status === 404,
    String(nowhere.status));

  const seen = await get(AT, admin.token);
  ok("the cabinet lists its drawers", seen.folders?.length === 1, String(seen.folders?.length));
  ok("  · with a count of what is in them", seen.folders?.[0]?.docs === 1,
    String(seen.folders?.[0]?.docs));
}

// ---- a drawer shut inside an open cabinet ----------------------------------------------
{
  await patch(`${C}/folders/${FOLDER}`, { openTo: "listed" }, owner.token);
  const them = await get(AT, hr.token);
  ok("a drawer shut to somebody hides what is in it",
    !them.docs?.some((d) => d.id === INSIDE), `${them.docs?.length} document(s)`);
  ok("  · and the drawer with it", !them.folders?.some((f) => f.id === FOLDER),
    `${them.folders?.length} folder(s)`);
  ok("  · while the cabinet around it is still open to them",
    them.status === 200 && them.cabinet?.level !== "none", String(them.cabinet?.level));

  const boss = await get(AT, owner.token);
  ok("  · and whoever runs the space still sees both",
    boss.folders?.some((f) => f.id === FOLDER) && boss.docs?.some((d) => d.id === INSIDE));

  const sneak = await post(`${C}/docs`, {
    title: "แอบใส่", url: "https://example.test/s", folderId: FOLDER,
  }, hr.token);
  ok("  · and nobody files into a drawer they cannot open, even by naming it",
    sneak.status === 403, String(sneak.status));
}

// ---- one document reaching out of a shut drawer ----------------------------------------
{
  await put(`${C}/docs/${INSIDE}/grants`, { grants: [{ userId: hr.id, level: "read" }] }, owner.token);
  const them = await get(AT, hr.token);
  ok("a name on one document reaches into a drawer that is shut",
    them.docs?.some((d) => d.id === INSIDE), `${them.docs?.length} document(s)`);
  ok("  · and the drawer appears, because the document has to be somewhere",
    them.folders?.some((f) => f.id === FOLDER));
  ok("  · marked as one they cannot open themselves",
    them.folders?.find((f) => f.id === FOLDER)?.level === "none",
    String(them.folders?.find((f) => f.id === FOLDER)?.level));
  ok("  · with the reason naming the document, not the drawer",
    them.docs?.find((d) => d.id === INSIDE)?.why === "named-on-document",
    them.docs?.find((d) => d.id === INSIDE)?.why);
}

// ---- a name on the drawer itself -------------------------------------------------------
{
  const set = await put(`${C}/folders/${FOLDER}/grants`, { grants: [{ userId: staff.id, level: "file" }] },
    admin.token);
  ok("an admin names somebody on a drawer", set.status === 200 && set.grants === 1, String(set.status));
  const them = await get(AT, staff.token);
  ok("  · who then opens it", them.folders?.find((f) => f.id === FOLDER)?.level === "file",
    String(them.folders?.find((f) => f.id === FOLDER)?.level));
  ok("  · and sees what is inside, named as the drawer doing it",
    them.docs?.find((d) => d.id === INSIDE)?.why === "named-on-folder",
    them.docs?.find((d) => d.id === INSIDE)?.why);
  const mine = await post(`${C}/docs`, { title: "ใบเสนอราคา", url: "https://example.test/q", folderId: FOLDER },
    staff.token);
  ok("  · and may file into it", mine.status === 201, String(mine.status));

  const byThem = await put(`${C}/folders/${FOLDER}/grants`, { grants: [] }, staff.token);
  ok("  · but does not get to hand out access to it", byThem.status === 403, String(byThem.status));
  const rename = await patch(`${C}/folders/${FOLDER}`, { name: "ของฉัน" }, staff.token);
  ok("  · nor to rename it", rename.status === 403, String(rename.status));
}

// ---- moving a document between drawers --------------------------------------------------
{
  const out = await patch(`${C}/docs/${INSIDE}`, { folderId: null }, owner.token);
  ok("a document can be taken out of a drawer", out.status === 200 && out.doc?.folderId === null,
    String(out.doc?.folderId));
  const back = await patch(`${C}/docs/${INSIDE}`, { folderId: FOLDER }, owner.token);
  ok("  · and put back into one", back.doc?.folderId === FOLDER, String(back.doc?.folderId));
  const elsewhere = await patch(`${C}/docs/${INSIDE}`, { folderId: "fld_nope" }, owner.token);
  ok("  · but not into one that does not exist", elsewhere.status === 404, String(elsewhere.status));
}

// ---- a Drive folder is an entry too ------------------------------------------------------
{
  const f = await post(`${C}/docs`, {
    title: "โฟลเดอร์การเงิน", url: "https://drive.google.com/drive/folders/xyz",
    provider: "google", kind: "folder", fileId: "xyz",
  }, owner.token);
  ok("a Drive folder can be filed as an entry", f.status === 201 && f.doc?.kind === "folder",
    String(f.doc?.kind));
  const plain = await post(`${C}/docs`, { title: "ธรรมดา", url: "https://example.test/p" }, owner.token);
  ok("  · and anything else is a file unless it says otherwise", plain.doc?.kind === "file",
    String(plain.doc?.kind));
}

// ---- taking a drawer away ---------------------------------------------------------------
{
  const before = (await get(AT, owner.token)).docs.length;
  const gone = await del(`${C}/folders/${FOLDER}`, owner.token);
  ok("an admin takes a drawer away", gone.status === 200, String(gone.status));
  ok("  · and says how many documents came back out of it", gone.loosened >= 1,
    String(gone.loosened));
  const after = await get(AT, owner.token);
  ok("  · none of which were destroyed with it", after.docs.length === before,
    `${before} before, ${after.docs.length} after`);
  ok("  · they are lying loose in the cabinet now",
    after.docs.every((d) => d.folderId === null));
  ok("  · and the drawer is gone", !after.folders?.length, String(after.folders?.length));
}


// ---- a drawer that keeps its files in a Drive folder ------------------------------------
{
  const made = await post(`${C}/folders`, {
    name: "การเงิน", driveFolderId: "drv_1",
    driveUrl: "https://drive.google.com/drive/folders/drv_1",
  }, admin.token);
  ok("a drawer can be made with a Drive folder behind it", made.status === 201,
    String(made.status));
  ok("  · and says where that is", made.folder?.drive?.id === "drv_1"
    && String(made.folder?.drive?.url).includes("drv_1"), JSON.stringify(made.folder?.drive));
  const FOLD = made.folder.id;

  const seen = await get(AT, staff.token);
  ok("  · which everybody filing into it can see, not only whoever made it",
    seen.folders?.find((f) => f.id === FOLD)?.drive?.id === "drv_1",
    JSON.stringify(seen.folders?.find((f) => f.id === FOLD)?.drive));

  const bad = await post(`${C}/folders`, {
    name: "x", driveFolderId: "drv_2", driveUrl: "javascript:alert(1)",
  }, owner.token);
  ok("  · and a link that is not a link is refused", bad.status === 400, String(bad.status));

  const plain = await post(`${C}/folders`, { name: "ไม่ผูก" }, owner.token);
  ok("a drawer without one says so rather than pretending", plain.folder?.drive === null,
    JSON.stringify(plain.folder?.drive));

  const moved = await patch(`${C}/folders/${FOLD}`, {
    driveFolderId: "drv_9", driveUrl: "https://drive.google.com/drive/folders/drv_9",
  }, owner.token);
  ok("the space's own can point a drawer at a different Drive folder",
    moved.folder?.drive?.id === "drv_9", JSON.stringify(moved.folder?.drive));
  const byMember = await patch(`${C}/folders/${FOLD}`, { driveFolderId: "drv_x" }, staff.token);
  ok("  · and nobody else can", byMember.status === 403, String(byMember.status));

  const unlinked = await patch(`${C}/folders/${FOLD}`, { driveFolderId: null }, owner.token);
  ok("  · or unlink it, taking the address with it",
    unlinked.folder?.drive === null, JSON.stringify(unlinked.folder?.drive));
}


console.log(`\n${pass} passed, ${fail} failed\n`);
stop();
process.exit(fail ? 1 : 0);
