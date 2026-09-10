/**
 * What the summary queue does with a finished meeting.
 *
 * Neither a transcription service nor a language model is installed anywhere
 * near this, and that is the point: both are ordinary HTTP endpoints, so fetch
 * is replaced and the queue is asked what it sends and what it writes back.
 * The parts that need a model to judge — whether a Thai summary is any good —
 * are not testable here and are not pretended to be.
 *
 * What is worth checking is the part a mistake in would be quiet: that a track
 * belonging to somebody who said no is never sent anywhere, that each person is
 * asked about separately rather than in one structured lump a small model would
 * mangle, and that a failure ends up on the record instead of looping.
 *
 *   npm run test:summary -w @nexspace/api
 */
process.env.ASR_URL = "http://asr.test";
process.env.LLM_URL = "http://llm.test";
process.env.SUMMARY_SETTLE_MS = "0";
// The development database, as every other suite here uses. A fresh file would
// have no tables in it, and pushing a schema from inside a test is a second way
// of creating a database — one that can quietly disagree with the real one.

import { pathToFileURL } from "url";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REC_DIR = mkdtempSync(join(tmpdir(), "nexsum-"));
process.env.RECORDING_DIR = REC_DIR;

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => import(pathToFileURL(resolve(HERE, "../src/" + f)).href);

/** every call the queue made, in order */
const sent: { url: string; body: string }[] = [];
let asrSays = "วันนี้คุยเรื่องแผนสปรินต์";
let llmFails = false;

const realFetch = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (url: string, init: { body?: unknown } = {}) => {
  const u = String(url);
  if (u.includes("asr.test")) {
    sent.push({ url: u, body: "<audio>" });
    return { ok: true, status: 200, text: async () => asrSays };
  }
  if (u.includes("llm.test")) {
    const body = String(init.body ?? "");
    sent.push({ url: u, body });
    if (llmFails) return { ok: false, status: 500, text: async () => "model is not loaded" };
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "สรุป: " + (body.includes("ในการประชุม") ? "รายคน" : "ภาพรวม") } }] }),
    };
  }
  return realFetch(url as string, init as RequestInit);
};

const { prisma } = await load("db.js");
const { runSummaryQueue, perPersonPrompt, overallPrompt, summariesReady } = await load("summarise.js");

/**
 * Put the database back, however this ends.
 *
 * This writes to the database people develop against, so a run that leaves
 * rows behind makes the next one start somewhere the last one did not.
 */
let cleanUp = async () => {};

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

console.log("\nwhat the queue does with a finished meeting\n");
ok("configured by two URLs and nothing else", summariesReady === true);

// ---- a meeting, with one person who declined ----------------------------------
const stamp = Date.now();
const user = async (name: string) =>
  prisma.user.create({ data: { email: `sum-${name}-${stamp}@test.local`, name, passwordHash: "x" } });
const a = await user("ชาลิสา");
const b = await user("สมชาย");
const c = await user("อร");

const ws = await prisma.workspace.create({
  data: {
    name: `sum-${stamp}`, slug: `sum-${stamp}`, inviteCode: `sum${stamp}`.slice(0, 12),
    owner: { connect: { id: a.id } },
  },
});
cleanUp = async () => {
  await prisma.recording.deleteMany({ where: { workspaceId: ws.id } });
  await prisma.workspace.deleteMany({ where: { id: ws.id } });
  await prisma.user.deleteMany({ where: { id: { in: [a.id, b.id, c.id] } } });
};

mkdirSync(join(REC_DIR, "r1"), { recursive: true });
for (const f of ["a.webm", "b.webm", "c.webm"]) writeFileSync(join(REC_DIR, "r1", f), Buffer.alloc(64, 1));

const rec = await prisma.recording.create({
  data: {
    id: "r1", workspaceId: ws.id, roomId: "m1", roomLabel: "ห้องประชุม",
    startedByName: "ชาลิสา", endedAt: new Date(Date.now() - 60_000),
    audioUntil: new Date(Date.now() + 86_400_000),
    tracks: {
      create: [
        { userId: a.id, name: "ชาลิสา", consent: "yes", path: "r1/a.webm", seconds: 60 },
        { userId: b.id, name: "สมชาย", consent: "yes", path: "r1/b.webm", seconds: 40 },
        // said no, and their file is still on disk from before they withdrew
        { userId: c.id, name: "อร", consent: "no", path: "r1/c.webm", seconds: 30 },
      ],
    },
  },
  include: { tracks: true },
});

await runSummaryQueue();

const after = await prisma.recording.findUnique({ where: { id: rec.id }, include: { tracks: true } });
const asrCalls = sent.filter((s) => s.url.includes("asr.test"));
const llmCalls = sent.filter((s) => s.url.includes("llm.test"));

ok("only the people who agreed are transcribed", asrCalls.length === 2, `${asrCalls.length} of 3 tracks`);
const refused = after!.tracks.find((t) => t.name === "อร");
ok("  · and the one who said no has no transcript at all",
  !refused?.transcript && !refused?.digest, JSON.stringify(refused?.transcript));

ok("each person is asked about separately", llmCalls.length === 3, `${llmCalls.length} calls for 2 speakers + 1 meeting`);
ok("  · rather than in one lump a small model would mangle",
  llmCalls.filter((c) => c.body.includes("ในการประชุม")).length === 2);
ok("  · and each prompt names only that person",
  llmCalls.some((c) => c.body.includes("ชาลิสา") && !c.body.includes("สมชาย")),
  "one prompt per speaker");

ok("everybody who spoke gets their own summary",
  after!.tracks.filter((t) => t.digest).length === 2,
  after!.tracks.map((t) => `${t.name}:${t.digest ? "yes" : "no"}`).join(" "));
ok("the meeting gets one of its own", !!after!.summary, String(after!.summary));
ok("  · and it is marked finished", after!.state === "done", after!.state);

// ---- a meeting nobody agreed to be in -----------------------------------------
sent.length = 0;
mkdirSync(join(REC_DIR, "r2"), { recursive: true });
await prisma.recording.create({
  data: {
    id: "r2", workspaceId: ws.id, roomId: "m2", roomLabel: "ห้องเล็ก",
    startedByName: "ชาลิสา", endedAt: new Date(Date.now() - 60_000),
    audioUntil: new Date(Date.now() + 86_400_000),
    tracks: { create: [{ userId: a.id, name: "ชาลิสา", consent: "no" }] },
  },
});
await runSummaryQueue();
const none = await prisma.recording.findUnique({ where: { id: "r2" } });
ok("a meeting nobody agreed to sends nothing anywhere", sent.length === 0, `${sent.length} calls`);
ok("  · and says so rather than sitting in the queue for ever",
  none!.state === "done" && !!none!.summary, `${none!.state}: ${none!.summary}`);

// ---- when the model is not there ----------------------------------------------
sent.length = 0;
llmFails = true;
mkdirSync(join(REC_DIR, "r3"), { recursive: true });
writeFileSync(join(REC_DIR, "r3", "a.webm"), Buffer.alloc(64, 1));
await prisma.recording.create({
  data: {
    id: "r3", workspaceId: ws.id, roomId: "m3", roomLabel: "ห้องกลาง",
    startedByName: "ชาลิสา", endedAt: new Date(Date.now() - 60_000),
    audioUntil: new Date(Date.now() + 86_400_000),
    tracks: { create: [{ userId: a.id, name: "ชาลิสา", consent: "yes", path: "r3/a.webm", seconds: 20 }] },
  },
});
await runSummaryQueue();
const broke = await prisma.recording.findUnique({ where: { id: "r3" } });
ok("a model that will not answer is recorded as a failure", broke!.state === "failed", broke!.state);
ok("  · saying what happened, rather than looping in silence",
  (broke!.failure ?? "").includes("500"), String(broke!.failure));

// ---- the prompts themselves ----------------------------------------------------
llmFails = false;
{
  const p = perPersonPrompt("สมชาย", "ผมจะทำสไลด์ให้เสร็จวันศุกร์");
  ok("a person's prompt asks the two things that were wanted",
    p.includes("พูดถึงอะไรบ้าง") && p.includes("รับงานอะไรไป"));
  ok("  · and gives it somewhere to say there was nothing", p.includes("ไม่มีงานที่รับไป"));
  const o = overallPrompt([{ name: "ก", transcript: "x" }, { name: "ข", transcript: "y" }]);
  ok("the meeting prompt keeps the speakers apart", o.includes("[ก]") && o.includes("[ข]"));
  ok("  · and asks who is doing what", o.includes("ผู้รับผิดชอบ"));
}

await cleanUp();

console.log(`\n${pass} passed, ${fail} failed\n`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
