import { t } from "./i18n";
import { record, uploadTrack, canRecord, type Recorder } from "./recorder";

/**
 * The part of recording a meeting that a person sees.
 *
 * Three things, and each of them exists because of an obligation rather than a
 * preference. The notice has to be read, so it is a sheet with the facts laid
 * out rather than a line in a toast. The answer has to be per person, so it is
 * asked of everybody in the room and not of the room. And it has to be obvious
 * that recording is happening for as long as it is happening, so the chip stays
 * up and says how long it has been going.
 *
 * Nothing here decides anything. Whether a recording exists, who agreed, and
 * what may be uploaded are all the API's answers — this asks, shows, and sends.
 */

type Notice = {
  what: string; why: string; who: string;
  audioDays: number; textDays: number; abroad: boolean; rights: string;
};

export type RecordOptions = {
  api: string;
  workspace: string;
  token?: string;
  /** the microphone this call is using, or nothing if it is not open */
  mic: () => MediaStream | undefined;
  /** whether the local microphone is switched on right now */
  micOn: () => boolean;
  /** where this person is standing: null outside any room */
  room: () => { id: string; label: string; mapSlug: string } | null;
  /** tell the room, so everybody in it is asked at the same moment */
  announce: (msg: { on: boolean; id: string; roomId: string; by: string }) => void;
  say: (text: string, bad?: boolean) => void;
  me: () => string;
};

export function mountRecording(o: RecordOptions) {
  const ask = document.getElementById("rec-ask");
  const facts = document.getElementById("rec-facts");
  const sub = document.getElementById("rec-ask-sub");
  const micOff = document.getElementById("rec-mic-off");
  const yes = document.getElementById("rec-yes");
  const no = document.getElementById("rec-no");
  const chip = document.getElementById("rec-chip");
  const chipText = document.getElementById("rec-chip-text");
  const chipTime = document.getElementById("rec-chip-time");
  const stopBtn = document.getElementById("rec-stop");
  if (!ask || !facts || !sub || !micOff || !yes || !no || !chip || !chipText || !chipTime || !stopBtn) {
    console.warn("[recording] the consent sheet has no markup to draw into");
    return null;
  }

  /** the recording this browser is currently part of, if any */
  let live: { id: string; roomId: string; by: string; mine: boolean } | null = null;
  let tape: Recorder | null = null;
  let ticker = 0;

  const api = (p: string, init?: RequestInit) =>
    fetch(`${o.api}/workspaces/${encodeURIComponent(o.workspace)}${p}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });

  // ---- the chip -------------------------------------------------------------
  function showChip(on: boolean) {
    chip!.hidden = !on;
    window.clearInterval(ticker);
    if (!on) return;
    const paint = () => {
      const s = tape?.seconds() ?? 0;
      chipTime!.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    };
    paint();
    ticker = window.setInterval(paint, 1000);
    // Only whoever started it may stop it from here. Everybody else sees the
    // chip because they are being recorded, which is a thing to be told rather
    // than a control to be given.
    stopBtn!.hidden = !live?.mine;
    chipText!.textContent = live?.mine
      ? t("กำลังบันทึกเสียง")
      : t("{name} กำลังบันทึกการประชุมนี้").replace("{name}", live?.by ?? "");
  }

  // ---- the notice -----------------------------------------------------------
  function showAsk(notice: Notice, by: string) {
    sub!.textContent = t("{name} เริ่มบันทึกการประชุมนี้ — คุณเลือกได้ว่าจะให้บันทึกเสียงของคุณหรือไม่")
      .replace("{name}", by);
    facts!.innerHTML = "";
    const row = (k: string, v: string) => {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      facts!.append(dt, dd);
    };
    row(t("บันทึกอะไร"), notice.what);
    row(t("เพื่ออะไร"), notice.why);
    row(t("ใครดูได้"), notice.who);
    row(t("เก็บนานแค่ไหน"), t("เสียง {a} วัน · ข้อความ {b} วัน")
      .replace("{a}", String(notice.audioDays)).replace("{b}", String(notice.textDays)));
    row(t("ส่งออกนอกประเทศ"), notice.abroad ? t("มี") : t("ไม่มี — ประมวลผลบนเซิร์ฟเวอร์ขององค์กร"));
    row(t("สิทธิ์ของคุณ"), notice.rights);
    // Said before they answer, not after: consenting while muted records
    // silence, and somebody should know that before they agree to it.
    micOff!.hidden = o.micOn();
    ask!.hidden = false;
  }

  async function answer(consent: boolean) {
    ask!.hidden = true;
    if (!live) return;
    const r = await api(`/recordings/${encodeURIComponent(live.id)}/consent`, {
      method: "POST", body: JSON.stringify({ consent }),
    });
    if (!r.ok) { o.say(t("บันทึกคำตอบไม่สำเร็จ"), true); return; }
    if (!consent) {
      o.say(t("เสียงของคุณจะไม่ถูกบันทึก"));
      return;
    }
    const mic = o.mic();
    if (!mic) {
      // Agreed, but there is no microphone open to record. Not an error — the
      // track simply starts when they turn it on, and until then there is
      // nothing of theirs in the recording, which the notice already said.
      o.say(t("ยินยอมแล้ว — เปิดไมค์เมื่อไหร่จึงจะเริ่มบันทึกเสียงของคุณ"));
      return;
    }
    tape = record(mic, (msg) => o.say(msg, true));
    if (tape) o.say(t("กำลังบันทึกเสียงของคุณ"));
    showChip(true);
  }

  yes.addEventListener("click", () => void answer(true));
  no.addEventListener("click", () => void answer(false));

  /** stop, then send whatever this browser recorded */
  async function finish() {
    const id = live?.id;
    const held = tape;
    tape = null;
    showChip(false);
    if (!id) return;
    if (held) {
      const { blob, mime, seconds } = await held.stop();
      if (blob.size) {
        const r = await uploadTrack({
          api: o.api, workspace: o.workspace, recordingId: id, token: o.token, blob, mime, seconds,
        });
        o.say(r.ok ? t("ส่งเสียงของคุณแล้ว") : t("ส่งเสียงไม่สำเร็จ: {why}").replace("{why}", r.error ?? ""), !r.ok);
      }
    }
    live = null;
  }

  stopBtn.addEventListener("click", async () => {
    const id = live?.id, roomId = live?.roomId;
    if (!id) return;
    await api(`/recordings/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" });
    // Tell the room before uploading: everybody else should stop at the same
    // moment, not when this browser has finished sending its own audio.
    o.announce({ on: false, id, roomId: roomId ?? "", by: o.me() });
    await finish();
  });

  return {
    canRecord,
    /** is this browser part of a recording right now */
    active: () => !!live,

    /** somebody in this room pressed record, or stopped */
    told(msg: { on: boolean; id: string; roomId: string; by: string }) {
      const here = o.room();
      if (msg.on) {
        // Only the people in that room. Somebody two rooms away is not being
        // recorded and should not be asked to agree to anything.
        if (!here || here.id !== msg.roomId) return;
        if (live?.id === msg.id) return;
        live = { id: msg.id, roomId: msg.roomId, by: msg.by, mine: false };
        showChip(true);
        // The notice comes from the API rather than from this file, so what
        // people are told is what the server actually does — the two drifting
        // apart is how a notice quietly becomes untrue.
        void api("/recordings").then(async (r) => {
          const d = (await r.json().catch(() => ({}))) as { notice?: Notice };
          if (d.notice) showAsk(d.notice, msg.by);
        });
      } else if (live?.id === msg.id) {
        void finish();
      }
    },

    /** press record */
    async start() {
      const here = o.room();
      if (!here) { o.say(t("ยืนอยู่ในห้องประชุมก่อนจึงจะบันทึกได้"), true); return; }
      if (!canRecord()) { o.say(t("เบราว์เซอร์นี้บันทึกเสียงไม่ได้"), true); return; }
      const r = await api("/recordings", {
        method: "POST",
        body: JSON.stringify({ mapSlug: here.mapSlug, roomId: here.id, roomLabel: here.label }),
      });
      const d = (await r.json().catch(() => ({}))) as
        { recording?: { id: string }; notice?: Notice; error?: string; id?: string };
      if (!r.ok || !d.recording) {
        o.say(d.error === "already recording" ? t("ห้องนี้กำลังถูกบันทึกอยู่แล้ว") : t("เริ่มบันทึกไม่สำเร็จ"), true);
        return;
      }
      live = { id: d.recording.id, roomId: here.id, by: o.me(), mine: true };
      o.announce({ on: true, id: d.recording.id, roomId: here.id, by: o.me() });
      showChip(true);
      // Asked of the person who pressed it too. Starting a recording is not the
      // same as agreeing to be in one, and the notice is owed to everybody.
      if (d.notice) showAsk(d.notice, o.me());
    },

    dispose() { window.clearInterval(ticker); tape?.cancel(); },
  };
}
