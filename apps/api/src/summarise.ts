import { readFileSync } from "fs";
import { join } from "path";
import { prisma } from "./db.js";
import { REC_DIR } from "./recordings.js";

/**
 * Turning a recorded meeting into words, and then into a summary.
 *
 * Both halves are HTTP calls to something else, and both speak the shapes
 * everybody already implements: `/v1/audio/transcriptions` and
 * `/v1/chat/completions`. That is not a preference for a vendor — it is the
 * one decision that keeps this file from being about a vendor at all. Ollama
 * serves the second, faster-whisper-server and whisper.cpp both serve the
 * first, and where those run is a line in .env rather than anything here.
 *
 * Which matters more than usual on this deployment: the machine the app runs on
 * also carries the company's authentication and attendance servers, and is
 * already swapping. The model belongs somewhere else, and "somewhere else" has
 * to be a setting rather than a rewrite.
 *
 * Nothing here decides who may be transcribed. A track reaches this file only
 * if its owner said yes and the audio survived to now; consent is enforced
 * where it is recorded and where it is deleted, not here.
 */

const ASR_URL = (process.env.ASR_URL || "").replace(/\/+$/, "");
const ASR_MODEL = process.env.ASR_MODEL || "typhoon-asr-realtime";
const LLM_URL = (process.env.LLM_URL || "").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "scb10x/llama3.2-typhoon2-1b-instruct";
const LLM_KEY = process.env.LLM_API_KEY || "";
const LANG = process.env.ASR_LANG || "th";

export const asrReady = !!ASR_URL;
export const llmReady = !!LLM_URL;
export const summariesReady = asrReady && llmReady;

/**
 * Long, and deliberately so.
 *
 * An hour of speech on a CPU is minutes of work, not milliseconds, and a
 * timeout that fits an API call would fail every real meeting while passing
 * every test.
 */
const ASR_TIMEOUT_MS = Number(process.env.ASR_TIMEOUT_MS || 30 * 60_000);
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 10 * 60_000);

/** how long to wait after a meeting ends for the last browser to send its audio */
const SETTLE_MS = Number(process.env.SUMMARY_SETTLE_MS || 2 * 60_000);

// ---- the two calls -------------------------------------------------------------

/** one track of one person, as text */
export async function transcribe(rel: string): Promise<string> {
  const bytes = readFileSync(join(REC_DIR, rel));
  const form = new FormData();
  form.append("file", new Blob([bytes]), rel.split(/[\\/]/).pop() || "track.webm");
  form.append("model", ASR_MODEL);
  form.append("language", LANG);
  // Plain text back: the segments are not used, and asking for them is asking a
  // small model to spend its time on structure nobody reads.
  form.append("response_format", "text");

  const r = await fetch(`${ASR_URL}/v1/audio/transcriptions`, {
    method: "POST", body: form, signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`asr answered ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const said = (await r.text()).trim();
  // Some servers honour response_format and some return JSON regardless.
  if (said.startsWith("{")) {
    try { return String(JSON.parse(said).text ?? "").trim(); } catch { /* it was not JSON after all */ }
  }
  return said;
}

/** one question to the model, one answer back */
async function ask(system: string, user: string, maxTokens = 700): Promise<string> {
  const r = await fetch(`${LLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(LLM_KEY ? { authorization: `Bearer ${LLM_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`llm answered ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const d = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return (d.choices?.[0]?.message?.content ?? "").trim();
}

/** is any of this configured, and does it answer? — for a health check */
export async function summaryCheck(): Promise<{ ok: boolean; detail: string }> {
  if (!asrReady && !llmReady) return { ok: false, detail: "no transcription or summary service is configured" };
  const parts: string[] = [];
  let ok = true;
  for (const [name, url] of [["asr", ASR_URL], ["llm", LLM_URL]] as const) {
    if (!url) { parts.push(`${name}: not configured`); ok = false; continue; }
    try {
      const r = await fetch(`${url}/v1/models`, {
        headers: LLM_KEY && name === "llm" ? { authorization: `Bearer ${LLM_KEY}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      parts.push(`${name}: HTTP ${r.status}`);
      if (!r.ok) ok = false;
    } catch (e) {
      parts.push(`${name}: cannot reach ${url} (${(e as Error).message})`);
      ok = false;
    }
  }
  return { ok, detail: parts.join(" · ") };
}

// ---- what to ask for -----------------------------------------------------------

const PER_PERSON_SYSTEM =
  "คุณคือผู้ช่วยสรุปการประชุมภาษาไทย ตอบสั้น ตรงประเด็น ใช้เฉพาะสิ่งที่ปรากฏในบทถอดเสียงเท่านั้น " +
  "ห้ามเดาหรือเติมสิ่งที่ไม่ได้พูด ถ้าไม่มีข้อมูลให้บอกว่าไม่มี";

const OVERALL_SYSTEM =
  "คุณคือผู้ช่วยสรุปการประชุมภาษาไทย สรุปภาพรวมของทั้งที่ประชุมอย่างกระชับ " +
  "ใช้เฉพาะสิ่งที่ปรากฏในบทถอดเสียงเท่านั้น ห้ามเดา";

/**
 * One call per person, then one for the meeting.
 *
 * Not one call that returns everybody in a structured block. A 1B model asked
 * for JSON describing five speakers will produce something that parses about as
 * often as not, and the failure is silent — a summary that quietly loses a
 * person. Short prompts with one job each are what a small model is good at,
 * and this deployment is going to be running a small one.
 */
export function perPersonPrompt(name: string, transcript: string) {
  return `นี่คือบทถอดเสียงของ ${name} ในการประชุม (เฉพาะสิ่งที่ ${name} พูด)

"""
${transcript}
"""

สรุปสองหัวข้อสั้น ๆ:
1) ${name} พูดถึงอะไรบ้าง
2) ${name} รับงานอะไรไป หรือต้องทำอะไรต่อ (ถ้าไม่มี ให้เขียนว่า "ไม่มีงานที่รับไป")`;
}

export function overallPrompt(parts: { name: string; transcript: string }[]) {
  const body = parts
    .map((p) => `[${p.name}]\n${p.transcript}`)
    .join("\n\n");
  return `นี่คือบทถอดเสียงของการประชุม แยกตามผู้พูด

"""
${body}
"""

สรุปสามหัวข้อ:
1) ประชุมเรื่องอะไร
2) ข้อสรุปหรือการตัดสินใจที่ได้
3) สิ่งที่ต้องทำต่อ พร้อมชื่อผู้รับผิดชอบ`;
}

// ---- the queue -----------------------------------------------------------------

/**
 * One at a time, and never while anybody might still be uploading.
 *
 * A meeting is picked up only once every track that was consented to has
 * arrived, or once enough time has passed that one is not coming. Starting
 * earlier would summarise a meeting with a person missing from it and call
 * that finished.
 */
let busy = false;

export async function runSummaryQueue(): Promise<void> {
  if (busy || !summariesReady) return;
  busy = true;
  try {
    const settled = new Date(Date.now() - SETTLE_MS);
    const rec = await prisma.recording.findFirst({
      where: { state: "waiting", endedAt: { not: null, lt: settled } },
      include: { tracks: true },
      orderBy: { endedAt: "asc" },
    });
    if (!rec) return;

    const speakers = rec.tracks.filter((t) => t.consent === "yes" && t.path);
    if (!speakers.length) {
      await prisma.recording.update({
        where: { id: rec.id },
        data: { state: "done", summary: "ไม่มีเสียงที่ได้รับความยินยอมให้บันทึกในการประชุมนี้" },
      });
      console.log(`[summary] ${rec.id}: nobody consented, nothing to transcribe`);
      return;
    }

    await prisma.recording.update({ where: { id: rec.id }, data: { state: "transcribing" } });
    console.log(`[summary] ${rec.id}: ${speakers.length} track(s) to work through`);

    const said: { name: string; transcript: string }[] = [];
    for (const t of speakers) {
      const text = (await transcribe(t.path!)).trim();
      await prisma.recordingTrack.update({ where: { id: t.id }, data: { transcript: text } });
      if (text) said.push({ name: t.name, transcript: text });
    }

    if (!said.length) {
      await prisma.recording.update({
        where: { id: rec.id },
        data: { state: "done", summary: "ไม่มีคำพูดที่ถอดออกมาได้จากการประชุมนี้" },
      });
      return;
    }

    for (const t of speakers) {
      const mine = said.find((s) => s.name === t.name);
      if (!mine) continue;
      const digest = await ask(PER_PERSON_SYSTEM, perPersonPrompt(t.name, mine.transcript), 400);
      await prisma.recordingTrack.update({ where: { id: t.id }, data: { digest } });
    }

    const summary = await ask(OVERALL_SYSTEM, overallPrompt(said), 900);
    await prisma.recording.update({
      where: { id: rec.id }, data: { state: "done", summary, failure: null },
    });
    console.log(`[summary] ${rec.id}: done`);
  } catch (e) {
    // Said on the record rather than retried forever. A meeting that cannot be
    // summarised should say so to the person waiting for it, and a queue that
    // silently loops is a queue nobody can tell is broken.
    const msg = (e as Error).message.slice(0, 300);
    console.error("[summary] failed:", msg);
    await prisma.recording.updateMany({
      where: { state: "transcribing" },
      data: { state: "failed", failure: msg },
    });
  } finally {
    busy = false;
  }
}
