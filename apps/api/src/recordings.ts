import { randomBytes } from "crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";

/**
 * Meeting recordings: where the audio lives, and what may be done with it.
 *
 * Every rule with a legal reason behind it is here rather than spread through
 * the routes, because they are the rules somebody will need to read back one
 * day and answer for.
 *
 * The shape of the thing is the first of them. Each participant's browser
 * records that participant's own microphone and uploads that — never a mix of
 * the room. Three things follow:
 *
 *   · "who said this" is answered by which account uploaded the track, so no
 *     voice is ever compared to another to identify a speaker. Voice used for
 *     identification is biometric data under PDPA s.26 and needs explicit
 *     separate consent; there is none of it here, by construction.
 *   · consent means something. Declining removes your voice from the recording
 *     and the meeting carries on, rather than forcing you out of the room.
 *   · a person who declines cannot be recorded by somebody else's device,
 *     because no device records anybody else.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** beside the uploads, inside the data volume */
export const REC_DIR = process.env.RECORDING_DIR || resolve(HERE, "../data/recordings");

/**
 * The ceiling on one person's track.
 *
 * Opus at the bitrate a browser picks for speech is roughly 0.5 MB a minute, so
 * this is about four hours of one person talking — far past any meeting, and
 * far short of a disk filling up unnoticed.
 */
export const TRACK_MAX_BYTES = Number(process.env.RECORDING_MAX_BYTES || 120_000_000);

/**
 * How long the audio is kept.
 *
 * Short on purpose and separate from the summary. The recording is the risky
 * artefact — it is somebody's voice, it is hard to redact, and nobody ever goes
 * back to it. The text is the useful one. Keeping them for the same length of
 * time would mean choosing between losing the notes and holding the voices.
 */
export const AUDIO_KEEP_DAYS = Number(process.env.RECORDING_AUDIO_DAYS || 7);
/** and how long the notes stay after that */
export const TEXT_KEEP_DAYS = Number(process.env.RECORDING_TEXT_DAYS || 180);

/** the longest a single meeting may be recorded for, in minutes */
export const MAX_MINUTES = Number(process.env.RECORDING_MAX_MINUTES || 4 * 60);

/** what a browser is allowed to send, and what it is stored as */
const ALLOWED: Record<string, string> = {
  "audio/webm": "webm",
  "audio/webm;codecs=opus": "webm",
  "audio/ogg": "ogg",
  "audio/ogg;codecs=opus": "ogg",
  "audio/mp4": "m4a",
};
export const acceptsAudio = (mime: string) => !!ALLOWED[mime.replace(/\s/g, "")];
export const audioExt = (mime: string) => ALLOWED[mime.replace(/\s/g, "")] ?? "webm";

export type Consent = "asked" | "yes" | "no";

/**
 * May this track receive audio?
 *
 * Said once, here, because it is the sentence the whole feature rests on: a
 * recording only ever contains the voices of people who said yes, and saying
 * yes late does not retroactively cover a meeting that already happened.
 */
export const mayRecord = (consent: string) => consent === "yes";

/** a name on disk that gives nothing away about who is speaking */
export const trackPath = (recordingId: string, ext: string) =>
  join(recordingId, `${randomBytes(12).toString("hex")}.${ext}`);

export function putTrack(rel: string, bytes: Buffer) {
  const full = join(REC_DIR, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
  return full;
}

export function dropTrack(rel: string | null | undefined) {
  if (!rel) return false;
  const full = join(REC_DIR, rel);
  if (!existsSync(full)) return false;
  rmSync(full, { force: true });
  return true;
}

/** the folder for a whole recording, once every track in it has gone */
export function dropRecordingDir(recordingId: string) {
  const full = join(REC_DIR, recordingId);
  try {
    if (existsSync(full) && statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
  } catch { /* already gone, or in use */ }
}

/**
 * The notice, in the words the people being recorded will read.
 *
 * Kept beside the rules rather than in the interface, because it has to say
 * what the code actually does — the two drifting apart is how a notice becomes
 * untrue, and an untrue notice is worse than none. Anything that changes the
 * behaviour above should change this line too.
 */
export const noticeFacts = () => ({
  what: "เสียงจากไมโครโฟนของคุณเท่านั้น ระบบไม่ได้อัดเสียงคนอื่นจากเครื่องคุณ",
  why: "เพื่อถอดเป็นข้อความและสรุปการประชุม",
  who: "สรุปทั้งฉบับเปิดดูได้เฉพาะเจ้าของพื้นที่และผู้ดูแล · คุณเปิดดูส่วนของคุณเองได้เสมอ",
  audioDays: AUDIO_KEEP_DAYS,
  textDays: TEXT_KEEP_DAYS,
  abroad: false,
  rights: "ถอนความยินยอมและลบเสียงของคุณออกได้ทุกเมื่อ",
});
