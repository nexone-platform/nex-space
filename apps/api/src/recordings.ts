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

export type Consent = "asked" | "yes" | "no" | "auto";

/**
 * Whether each person is asked, or told.
 *
 * `ask` is the careful setting and the default: a sheet, a yes or a no, and
 * only a yes is recorded. `notice` is for a workspace that has settled the
 * question off the system — the room is told loudly that recording has started
 * and every microphone in it records, with no sheet in the way.
 *
 * Which one is in force is a deployment's decision and not a browser's: the
 * consent route reads this rather than trusting what the client says happened,
 * so a client asking to be marked `auto` on a deployment set to `ask` does not
 * get it.
 *
 * `notice` is not "no rules". Nobody's device records anybody but its owner,
 * the chip stays up for as long as it runs, and the person whose voice it is
 * can still delete it afterwards — those are structural and are not settings.
 */
export const CONSENT_MODE: "ask" | "notice" =
  (process.env.RECORDING_CONSENT || "ask").trim().toLowerCase() === "notice" ? "notice" : "ask";

/**
 * May this track receive audio?
 *
 * Said once, here, because it is the sentence the whole feature rests on.
 * `yes` is a person who answered; `auto` is a person recorded under a
 * workspace that tells rather than asks. `asked` and `no` never record —
 * neither an unanswered sheet nor a refusal, and saying yes late does not
 * retroactively cover a meeting that already happened.
 */
export const mayRecord = (consent: string) => consent === "yes" || consent === "auto";

/** what a new track starts as, before anybody has answered anything */
export const startingConsent = (): Consent => (CONSENT_MODE === "notice" ? "auto" : "asked");

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
  mode: CONSENT_MODE,
  what: "เสียงจากไมโครโฟนของคุณเท่านั้น ระบบไม่ได้อัดเสียงคนอื่นจากเครื่องคุณ",
  why: "เพื่อถอดเป็นข้อความและสรุปการประชุม",
  who: "สรุปทั้งฉบับเปิดดูได้เฉพาะเจ้าของพื้นที่และผู้ดูแล · คุณเปิดดูส่วนของคุณเองได้เสมอ",
  audioDays: AUDIO_KEEP_DAYS,
  textDays: TEXT_KEEP_DAYS,
  abroad: false,
  // Different in the two modes, because the first sentence is untrue in the
  // second: nobody was asked for consent, so there is none to withdraw. What
  // remains true either way is that the voice can be taken out.
  rights: CONSENT_MODE === "notice"
    ? "ลบเสียงและถ้อยคำของคุณออกจากบันทึกได้ทุกเมื่อ"
    : "ถอนความยินยอมและลบเสียงของคุณออกได้ทุกเมื่อ",
});
