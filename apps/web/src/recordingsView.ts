import { t } from "./i18n";

/**
 * Reading what a meeting came to.
 *
 * Two readers, and the difference between them is the access rule made visible.
 * Somebody who runs the space gets the meeting and everybody's part of it. Any
 * other person who was in it gets their own row — what they said, what they were
 * asked to do — and nothing of anybody else's. The API decides which of those
 * two documents to hand over; this draws whichever arrived.
 *
 * It never asks for the audio. The voices exist for the week it takes to
 * transcribe them and are swept; what is worth reading afterwards is the text,
 * and a player button here would invite somebody to go back to a recording for
 * reasons nobody consented to.
 */

type Person = { name: string; consent: string; seconds: number; recorded: boolean };
type Recording = {
  id: string;
  room: string;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  state: string;
  audioUntil: string;
  people: Person[];
  summary?: string;
  mine?: { consent: string; transcript: string | null; digest: string | null };
  canRead: boolean;
};

export type RecordingsOptions = {
  api: string;
  workspace: string;
  token?: string;
  say: (text: string, bad?: boolean) => void;
};

const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

export function mountRecordingsView(o: RecordingsOptions) {
  const view = document.getElementById("rec-view");
  const list = document.getElementById("rv-list");
  const pane = document.getElementById("rv-pane");
  const close = document.getElementById("rv-close");
  if (!view || !list || !pane || !close) {
    console.warn("[recording] the summary view has no markup to draw into");
    return null;
  }
  const listEl = list, paneEl = pane;

  let rows: Recording[] = [];
  let openId: string | null = null;

  const api = (p: string, init?: RequestInit) =>
    fetch(`${o.api}/workspaces/${encodeURIComponent(o.workspace)}${p}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });

  const stateWord = (s: string) =>
    s === "done" ? t("สรุปแล้ว")
    : s === "transcribing" ? t("กำลังถอดเสียง")
    : s === "failed" ? t("สรุปไม่สำเร็จ")
    : t("รอสรุป");

  function drawList() {
    listEl.innerHTML = "";
    if (!rows.length) {
      const none = document.createElement("div");
      none.className = "rv-empty";
      none.textContent = t("ยังไม่มีการประชุมที่บันทึกไว้");
      listEl.appendChild(none);
      return;
    }
    for (const r of rows) {
      const b = document.createElement("button");
      b.className = "rv-item" + (r.id === openId ? " on" : "");
      const title = document.createElement("b");
      title.textContent = r.room;
      const sub = document.createElement("small");
      const heard = r.people.filter((p) => p.recorded).length;
      sub.textContent = `${when(r.startedAt)} · ${t("{n} คน").replace("{n}", String(heard))}`;
      const st = document.createElement("span");
      st.className = `rv-state ${r.state}`;
      st.textContent = stateWord(r.state);
      b.append(title, sub, st);
      b.onclick = () => void open(r.id);
      listEl.appendChild(b);
    }
  }

  function block(title: string, body: string) {
    const h = document.createElement("div");
    h.className = "rv-sect";
    h.textContent = title;
    const p = document.createElement("div");
    p.className = "rv-text";
    p.textContent = body;
    return [h, p];
  }

  function drawOne(r: Recording) {
    paneEl.innerHTML = "";
    const h = document.createElement("h3");
    h.textContent = r.room;
    const sub = document.createElement("p");
    sub.className = "rv-when";
    sub.textContent = `${when(r.startedAt)} · ${t("เริ่มโดย {name}").replace("{name}", r.startedBy)}`;
    paneEl.append(h, sub);

    // Whoever reads this is the person who needs to know the summary is partial.
    const declined = r.people.filter((p) => !p.recorded);
    if (declined.length) {
      const note = document.createElement("p");
      note.className = "rv-missing";
      note.textContent = t("ไม่มีเสียงของ {names} ในบันทึกนี้ — สรุปจึงไม่ครบทุกคนที่อยู่ในห้อง")
        .replace("{names}", declined.map((p) => p.name).join(", "));
      paneEl.appendChild(note);
    }

    if (r.state !== "done") {
      const wait = document.createElement("p");
      wait.className = "rv-text";
      wait.textContent = r.state === "failed"
        ? t("สรุปไม่สำเร็จ — ผู้ดูแลระบบตรวจสอบได้จากบันทึกของเซิร์ฟเวอร์")
        : t("ยังถอดเสียงไม่เสร็จ กลับมาดูใหม่อีกครั้ง");
      paneEl.appendChild(wait);
    }

    if (r.canRead && r.summary) paneEl.append(...block(t("สรุปการประชุม"), r.summary));

    // Everybody's part, for staff. Your own part, for everybody else. Both come
    // from the same field — the server sent whichever this reader may have.
    if (r.canRead) {
      const spoke = r.people.filter((p) => p.recorded);
      if (spoke.length) {
        const head = document.createElement("div");
        head.className = "rv-sect";
        head.textContent = t("แยกตามคน");
        paneEl.appendChild(head);
      }
      for (const p of r.people) {
        const card = document.createElement("div");
        card.className = "rv-who";
        const name = document.createElement("h4");
        name.textContent = p.name;
        const tag = document.createElement("span");
        tag.className = "rv-tag" + (p.recorded ? "" : " no");
        tag.textContent = p.recorded ? t("บันทึกไว้") : t("ไม่ได้บันทึก");
        name.appendChild(tag);
        const body = document.createElement("div");
        body.className = "rv-text";
        body.textContent = p.recorded ? (perPerson.get(p.name) ?? t("ยังไม่มีสรุปของคนนี้")) : "";
        card.append(name, ...(p.recorded ? [body] : []));
        paneEl.appendChild(card);
      }
    } else if (r.mine) {
      paneEl.append(...block(t("ส่วนของคุณ"),
        r.mine.digest || t("ยังไม่มีสรุปส่วนของคุณ")));
      if (r.mine.transcript) paneEl.append(...block(t("ถ้อยคำของคุณ"), r.mine.transcript));
    }

    const acts = document.createElement("div");
    acts.className = "rv-acts";
    if (r.mine) {
      const mineOut = document.createElement("button");
      mineOut.className = "drop";
      mineOut.textContent = t("ลบเสียงและถ้อยคำของฉันออก");
      mineOut.onclick = () => void remove(r.id, true);
      acts.appendChild(mineOut);
    }
    if (r.canRead) {
      const all = document.createElement("button");
      all.className = "drop";
      all.textContent = t("ลบการประชุมนี้ทั้งหมด");
      all.onclick = () => void remove(r.id, false);
      acts.appendChild(all);
    }
    paneEl.appendChild(acts);
  }

  /**
   * The per-person text, which the listing does not carry.
   *
   * `people` says who was in it and who agreed; the words themselves come with
   * the single meeting. Kept beside the drawing rather than folded into the row
   * so that a listing of forty meetings does not carry forty transcripts.
   */
  const perPerson = new Map<string, string>();

  async function open(id: string) {
    openId = id;
    drawList();
    const r = await api(`/recordings/${encodeURIComponent(id)}`);
    const d = (await r.json().catch(() => ({}))) as { recording?: Recording & { people: (Person & { digest?: string })[] } };
    if (!d.recording) { o.say(t("เปิดสรุปไม่สำเร็จ"), true); return; }
    perPerson.clear();
    for (const p of (d.recording.people ?? []) as (Person & { digest?: string })[]) {
      if (p.digest) perPerson.set(p.name, p.digest);
    }
    drawOne(d.recording);
  }

  async function remove(id: string, mineOnly: boolean) {
    const asked = mineOnly
      ? t("ลบเสียงและถ้อยคำของคุณออกจากการประชุมนี้? ส่วนของคนอื่นจะยังอยู่")
      : t("ลบการประชุมนี้ทั้งหมด รวมทุกเสียงและทุกสรุป?");
    if (!confirm(asked)) return;
    const r = await api(`/recordings/${encodeURIComponent(id)}${mineOnly ? "?mine=1" : ""}`, { method: "DELETE" });
    if (!r.ok) { o.say(t("ลบไม่สำเร็จ"), true); return; }
    o.say(t("ลบแล้ว"));
    openId = null;
    paneEl.innerHTML = "";
    await load();
  }

  async function load() {
    const r = await api("/recordings");
    const d = (await r.json().catch(() => ({}))) as { recordings?: Recording[] };
    rows = d.recordings ?? [];
    drawList();
    if (!rows.length) {
      paneEl.innerHTML = "";
      const none = document.createElement("div");
      none.className = "rv-empty";
      none.textContent = t("การประชุมที่บันทึกไว้จะมาอยู่ที่นี่");
      paneEl.appendChild(none);
    }
  }

  close.addEventListener("click", () => { view.hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !view.hidden) view.hidden = true;
  });

  return {
    async open() {
      view.hidden = false;
      openId = null;
      paneEl.innerHTML = "";
      await load();
    },
    isOpen: () => !view.hidden,
  };
}
