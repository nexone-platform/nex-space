import { t } from "./i18n";

/**
 * Recording your own microphone, and nothing else.
 *
 * The whole feature rests on this file being narrow. It is handed one stream —
 * the microphone this call is already using — and it records that. It never
 * asks for a device of its own, never touches anybody else's audio, and has no
 * way to. A recording that could reach further would make consent a promise
 * rather than a fact.
 *
 * Recording the call's own track rather than a fresh capture also settles what
 * happens while somebody is muted: a disabled track produces silence, so being
 * muted means being silent in the recording too. A second capture would keep
 * listening through the mute, which is a microphone that is off recording
 * somebody who believes it is off.
 */

/** what the browser will actually give us, best first */
const TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export const canRecord = () =>
  typeof MediaRecorder !== "undefined" && TYPES.some((m) => MediaRecorder.isTypeSupported(m));

const pickType = () => TYPES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";

export type Recorder = {
  stop: () => Promise<{ blob: Blob; mime: string; seconds: number }>;
  cancel: () => void;
  seconds: () => number;
  live: () => boolean;
};

/**
 * Start recording a stream. Returns null when the browser cannot.
 *
 * Chunked every few seconds rather than held whole: a tab that is closed or
 * crashes mid-meeting then leaves behind what it had, instead of an hour of
 * audio that existed only in memory. Nothing is uploaded until stop, so a
 * cancelled recording never leaves the machine.
 */
export function record(stream: MediaStream, onError?: (msg: string) => void): Recorder | null {
  if (!canRecord()) {
    onError?.(t("เบราว์เซอร์นี้บันทึกเสียงไม่ได้"));
    return null;
  }
  const mime = pickType();
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
  } catch (e) {
    console.warn("[recording] could not start", e);
    onError?.(t("เริ่มบันทึกเสียงไม่สำเร็จ"));
    return null;
  }

  const parts: Blob[] = [];
  const startedAt = Date.now();
  let stopped = false;
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  rec.start(5000);

  const seconds = () => Math.round((Date.now() - startedAt) / 1000);

  return {
    seconds,
    live: () => !stopped && rec.state !== "inactive",
    cancel: () => {
      stopped = true;
      parts.length = 0;                       // nothing kept, nothing to upload
      try { rec.stop(); } catch { /* already inactive */ }
    },
    stop: () =>
      new Promise((resolve) => {
        if (stopped || rec.state === "inactive") {
          return resolve({ blob: new Blob(parts, { type: mime }), mime, seconds: seconds() });
        }
        stopped = true;
        const secs = seconds();
        rec.onstop = () => resolve({ blob: new Blob(parts, { type: mime }), mime, seconds: secs });
        try { rec.stop(); } catch {
          resolve({ blob: new Blob(parts, { type: mime }), mime, seconds: secs });
        }
      }),
  };
}

/**
 * Send one person's track to the API.
 *
 * The raw bytes with an audio content type, which is what the route reads. A
 * refusal is returned rather than thrown: the meeting is over either way, and
 * the thing worth doing about a track that would not upload is telling the
 * person, not failing something.
 */
export async function uploadTrack(opts: {
  api: string;
  workspace: string;
  recordingId: string;
  token?: string;
  blob: Blob;
  mime: string;
  seconds: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { api, workspace, recordingId, token, blob, mime, seconds } = opts;
  if (!blob.size) return { ok: false, error: t("ไม่มีเสียงให้บันทึก") };
  try {
    const r = await fetch(
      `${api}/workspaces/${encodeURIComponent(workspace)}/recordings/${encodeURIComponent(recordingId)}/track?seconds=${seconds}`,
      {
        method: "POST",
        headers: { "content-type": mime, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: blob,
      },
    );
    if (r.ok) return { ok: true };
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: d.error || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
