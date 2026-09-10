#!/usr/bin/env node
/**
 * Recording a meeting, and the rules that make it lawful to.
 *
 * Most of what is checked here is not a preference. Consent that can be
 * withdrawn, audio that goes when it is withdrawn, a person's right to their
 * own words, a retention window that actually expires — those are obligations
 * under the PDPA, and the difference between meeting one and not is whether
 * the code does it, so the code is what gets asked.
 *
 * The design being tested: every browser records its own microphone and
 * nothing else. That is why consent can be per person, why declining does not
 * force anybody out of the meeting, and why no voice is ever compared to
 * another to work out who spoke — which would be biometric data and a
 * different law again.
 *
 *   node apps/api/scripts/recordings-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { existsSync, mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3991;
const API = `http://127.0.0.1:${PORT}`;
const stamp = Date.now();
// Its own directory, so the suite can look at the disk and so it never touches
// anything a developer is actually keeping.
const REC_DIR = mkdtempSync(join(tmpdir(), "nexrec-"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const call = async (method, p, body, token) => {
  const r = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const get = (p, t) => call("GET", p, undefined, t);
const post = (p, b, t) => call("POST", p, b, t);
const del = (p, t) => call("DELETE", p, undefined, t);

/** a track upload, as the browser sends it: raw bytes with an audio type */
const putAudio = async (p, bytes, token, mime = "audio/webm") => {
  const r = await fetch(API + p, {
    method: "POST",
    headers: { "content-type": mime, authorization: `Bearer ${token}` },
    body: bytes,
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const audio = (n = 4096) => Buffer.alloc(n, 7);
const filesOnDisk = () => {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.isDirectory()) walk(join(d, n.name)); else out.push(n.name);
    }
  };
  walk(REC_DIR);
  return out;
};

try {
  await fetch(`${API}/health`, { signal: AbortSignal.timeout(700) });
  console.error(`! something is already listening on ${PORT} — stop it first`);
  process.exit(1);
} catch { /* free */ }

const api = spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR,
  env: {
    ...process.env, PORT: String(PORT),
    RECORDING_DIR: REC_DIR,
    RECORDING_AUDIO_DAYS: "7",
    // No mail from this suite: the people in it are invented.
    SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", RESEND_API_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
api.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[api] ${d}`));
const stop = () => { try { api.kill(); } catch { /* gone */ } };
process.on("exit", stop);

console.log("\nrecording a meeting, and the rules that make it lawful to\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast ---------------------------------------------------------------------

const reg = (who) => post("/auth/register", {
  email: `rec-${who}-${stamp}@test.local`, name: who, password: "hunter2pw",
});
const owner = await reg("owner");
const admin = await reg("admin");
const mate = await reg("mate");     // in the meeting
const other = await reg("other");   // a member, but not in it
const guest = await reg("guest");

const ws = (await post("/workspaces", { name: `rec-${stamp}` }, owner.token)).workspace;
for (const p of [admin, mate, other, guest]) await post("/workspaces/join", { code: ws.inviteCode }, p.token);
await call("PATCH", `/workspaces/${ws.slug}/members/${admin.user.id}`, { role: "admin" }, owner.token);
await call("PATCH", `/workspaces/${ws.slug}/members/${guest.user.id}`, { role: "guest" }, owner.token);

const REC = `/workspaces/${ws.slug}/recordings`;
const room = { mapSlug: "main", roomId: "meeting-1", roomLabel: "ห้องประชุมใหญ่" };

// ---- starting one --------------------------------------------------------------

let rec;
{
  const r = await post(REC, room, owner.token);
  rec = r.recording;
  ok("a member can start recording a room", r.status === 200 && !!rec?.id, `status ${r.status}`);
  ok("  · and is in it themselves, since they are in the room",
    rec?.people?.length === 1 && rec.people[0].name === "owner", JSON.stringify(rec?.people));
  ok("  · but has not been recorded yet — only asked",
    rec?.people?.[0]?.consent === "asked" && rec.people[0].recorded === false,
    String(rec?.people?.[0]?.consent));
  ok("the notice says the audio never leaves the country", r.notice?.abroad === false);
  ok("  · and how long it is kept", Number(r.notice?.audioDays) > 0, String(r.notice?.audioDays));
  ok("  · and that only your own microphone is recorded",
    typeof r.notice?.what === "string" && r.notice.what.includes("ไมโครโฟนของคุณ"));
}
{
  const r = await post(REC, room, guest.token);
  ok("a guest cannot start one", r.status === 403, `status ${r.status}`);
}
{
  const r = await post(REC, room, owner.token);
  ok("one room records once at a time", r.status === 409, `status ${r.status}`);
}

// ---- consent, and what it actually controls ------------------------------------

{
  const r = await putAudio(`${REC}/${rec.id}/track`, audio(), owner.token);
  ok("nobody is recorded before they answer", r.status === 403, `status ${r.status}`);
}
{
  const r = await post(`${REC}/${rec.id}/consent`, { consent: false }, mate.token);
  ok("saying no is an answer, and it is written down", r.status === 200 && r.consent === "no");
  const after = await putAudio(`${REC}/${rec.id}/track`, audio(), mate.token);
  ok("  · and no audio of theirs is accepted afterwards", after.status === 403, `status ${after.status}`);
}
{
  await post(`${REC}/${rec.id}/consent`, { consent: true }, owner.token);
  const r = await putAudio(`${REC}/${rec.id}/track`, audio(9000), owner.token);
  ok("saying yes lets your own microphone through", r.status === 200 && r.bytes === 9000, `status ${r.status}`);
  ok("  · and it is on disk", filesOnDisk().length === 1, filesOnDisk().join(" ") || "nothing");
  const again = await putAudio(`${REC}/${rec.id}/track`, audio(), owner.token);
  ok("  · once, not twice", again.status === 409, `status ${again.status}`);
}
{
  const r = await putAudio(`${REC}/${rec.id}/track`, audio(), admin.token, "text/plain");
  ok("a track has to be audio", r.status === 415 || r.status === 403, `status ${r.status}`);
}

// The one that matters most: withdrawal has to reach the disk.
{
  await post(`${REC}/${rec.id}/consent`, { consent: true }, admin.token);
  await putAudio(`${REC}/${rec.id}/track`, audio(5000), admin.token);
  ok("two people are now recorded", filesOnDisk().length === 2, String(filesOnDisk().length));
  const r = await post(`${REC}/${rec.id}/consent`, { consent: false }, admin.token);
  ok("consent can be withdrawn", r.status === 200 && r.consent === "no");
  ok("  · and the audio is gone from the disk, not just from the answer",
    filesOnDisk().length === 1, filesOnDisk().join(" ") || "nothing");
}

// ---- who may read what ---------------------------------------------------------

await post(`${REC}/${rec.id}/consent`, { consent: true }, mate.token);
await putAudio(`${REC}/${rec.id}/track`, audio(3000), mate.token);
await post(`${REC}/${rec.id}/stop`, {}, owner.token);

{
  const r = await get(`${REC}/${rec.id}`, owner.token);
  ok("an owner may read the meeting", r.status === 200 && r.recording?.canRead === true);
}
{
  const r = await get(`${REC}/${rec.id}`, admin.token);
  ok("  · so may an admin", r.status === 200 && r.recording?.canRead === true);
}
{
  const r = await get(`${REC}/${rec.id}`, mate.token);
  ok("somebody who was in it reads their own row", r.status === 200 && !!r.recording?.mine,
    JSON.stringify(r.recording?.mine));
  ok("  · and not the meeting summary", r.recording?.summary === undefined && r.recording?.canRead === false);
}
{
  const r = await get(`${REC}/${rec.id}`, other.token);
  ok("a member who was not in it reads nothing", r.status === 403, `status ${r.status}`);
}
{
  const staffList = await get(REC, owner.token);
  const mineList = await get(REC, mate.token);
  const strangerList = await get(REC, other.token);
  ok("staff see the space's meetings", (staffList.recordings ?? []).length >= 1);
  ok("  · a participant sees the ones they were in", (mineList.recordings ?? []).length === 1);
  ok("  · and somebody who was in none sees none", (strangerList.recordings ?? []).length === 0);
}
{
  // Each person's summary is for the people whose job it is; each person's
  // transcript stays with the person who said it.
  const staffSees = await get(`${REC}/${rec.id}`, admin.token);
  const mateSees = await get(`${REC}/${rec.id}`, mate.token);
  ok("staff are given each person's summary",
    staffSees.recording.people.every((p) => "digest" in p),
    JSON.stringify(staffSees.recording.people[0]));
  ok("  · but not each person's transcript",
    !staffSees.recording.people.some((p) => "transcript" in p));
  ok("  · and a participant is given neither for anybody else",
    mateSees.recording.people.every((p) => !("digest" in p)),
    JSON.stringify(mateSees.recording.people[0]));
  ok("  · only their own", "transcript" in (mateSees.recording.mine ?? {}));
}
{
  const r = await get(`${REC}/${rec.id}`, owner.token);
  const people = r.recording.people;
  ok("the listing says who declined, rather than quietly leaving them out",
    people.length === 3 && people.some((p) => p.consent === "no"),
    people.map((p) => `${p.name}:${p.consent}`).join(" "));
}

// ---- erasure -------------------------------------------------------------------

{
  const before = filesOnDisk().length;
  const r = await del(`${REC}/${rec.id}?mine=1`, mate.token);
  ok("anybody in it can remove their own voice", r.status === 200 && r.mine === true);
  ok("  · which takes their audio off the disk", filesOnDisk().length === before - 1,
    `${before} → ${filesOnDisk().length}`);
  const still = await get(`${REC}/${rec.id}`, owner.token);
  ok("  · and leaves the meeting standing", still.status === 200 && !!still.recording);
}
{
  const r = await del(`${REC}/${rec.id}`, other.token);
  ok("somebody who was not in it cannot delete anything", r.status === 403, `status ${r.status}`);
}
{
  const r = await del(`${REC}/${rec.id}`, owner.token);
  ok("an owner can delete the whole meeting", r.status === 200);
  ok("  · and nothing of it is left on the disk", filesOnDisk().length === 0,
    filesOnDisk().join(" ") || "nothing");
  const gone = await get(`${REC}/${rec.id}`, owner.token);
  ok("  · nor in the database", gone.status === 404, `status ${gone.status}`);
}

// ---- stopping ------------------------------------------------------------------

{
  const two = (await post(REC, { ...room, roomId: "meeting-2" }, mate.token)).recording;
  const r = await post(`${REC}/${two.id}/stop`, {}, other.token);
  ok("somebody else's recording is not yours to stop", r.status === 403, `status ${r.status}`);
  const byStaff = await post(`${REC}/${two.id}/stop`, {}, admin.token);
  ok("  · but an admin may stop it", byStaff.status === 200);
  const again = await post(`${REC}/${two.id}/stop`, {}, admin.token);
  ok("  · and stopping twice is not an error", again.status === 200 && again.already === true);
  await del(`${REC}/${two.id}`, owner.token);
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
