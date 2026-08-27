/**
 * What the rooms are doing today.
 *
 * A list, not a grid. A week grid is what a calendar looks like, but this one
 * answers a narrower question — "can I have that room, and when is it free" —
 * and for that a day at a time in a narrow sidebar beats a grid nobody can read
 * at 320px.
 *
 * Times are shown in the reader's own zone and sent as UTC. Nothing here
 * formats a date by hand: a meeting at the wrong hour is worse than no meeting.
 */
import { t } from "./i18n";

export type Booking = {
  id: string;
  mapSlug: string;
  roomId: string;
  room: string;
  title: string;
  host: string;
  hostId: string | null;
  startsAt: string;
  endsAt: string;
  going: number;
  imGoing: boolean;
  mine: boolean;
  /** a signed link to this one meeting as a .ics file */
  ics: string;
};

export type Room = { id: string; label: string };

export type CalendarOptions = {
  host: HTMLElement;
  api: string;
  workspace: string;
  mapSlug: string;
  token?: string;
  guest?: string;
  /** the rooms on the map being looked at, in the order they are drawn */
  rooms: () => Room[];
  /** told whenever the list changes, so the map plates and reminders keep up */
  onChange?: (all: Booking[]) => void;
  /** whether this person may cancel somebody else's booking (owner or admin) */
  canManage?: () => boolean;
  /** false for a guest, who may read the calendar but not write to it */
  canBook?: () => boolean;
};

const DAY = 24 * 60 * 60 * 1000;

/** 09:30 — in the reader's zone, in their locale, never assembled by hand */
export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "วันนี้" / "พรุ่งนี้" / a date, because a bare date makes people count days */
export function dayName(d: Date, today = new Date()): string {
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((midnight(d) - midnight(today)) / DAY);
  if (diff === 0) return t("วันนี้");
  if (diff === 1) return t("พรุ่งนี้");
  if (diff === -1) return t("เมื่อวาน");
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/** a local <input type="datetime-local"> value for a moment */
const localValue = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** the next half hour, which is when a meeting booked now almost always starts */
const nextSlot = (from = new Date()) => {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + (30 - (d.getMinutes() % 30)));
  return d;
};

export function mountCalendarPanel(o: CalendarOptions) {
  const { host } = o;
  host.classList.add("cal");
  host.innerHTML = "";

  let all: Booking[] = [];
  let day = new Date();
  let composing = false;

  // ---- the day being looked at ----
  const bar = document.createElement("div");
  bar.className = "cal-bar";
  const prev = document.createElement("button"); prev.className = "cal-nav"; prev.textContent = "‹";
  prev.title = t("วันก่อนหน้า");
  const label = document.createElement("b"); label.className = "cal-day";
  const next = document.createElement("button"); next.className = "cal-nav"; next.textContent = "›";
  next.title = t("วันถัดไป");
  const add = document.createElement("button");
  add.className = "cal-add";
  add.textContent = t("＋ จองห้อง");
  bar.append(prev, label, next, add);

  const msg = document.createElement("div"); msg.className = "cal-msg";
  const form = document.createElement("form"); form.className = "cal-form"; form.hidden = true;
  const list = document.createElement("div"); list.className = "cal-list";
  const foot = document.createElement("div"); foot.className = "cal-foot";
  host.append(bar, msg, form, list, foot);

  const say = (text: string, bad = false) => {
    msg.textContent = text;
    msg.classList.toggle("err", bad);
    if (text) window.setTimeout(() => { if (msg.textContent === text) msg.textContent = ""; }, 5000);
  };

  // ---- the form ----
  const titleIn = document.createElement("input");
  titleIn.type = "text"; titleIn.maxLength = 120; titleIn.placeholder = t("ประชุมเรื่องอะไร");
  const roomIn = document.createElement("select");
  const startIn = document.createElement("input"); startIn.type = "datetime-local";
  const endIn = document.createElement("input"); endIn.type = "datetime-local";
  const save = document.createElement("button"); save.type = "submit"; save.className = "cal-save"; save.textContent = t("จอง");
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "cal-cancel"; cancel.textContent = t("ยกเลิก");

  const row = (labelText: string, ...kids: HTMLElement[]) => {
    const r = document.createElement("label");
    r.className = "cal-row";
    const s = document.createElement("span"); s.textContent = labelText;
    r.append(s, ...kids);
    return r;
  };
  form.append(
    row(t("หัวข้อ"), titleIn),
    row(t("ห้อง"), roomIn),
    row(t("เริ่ม"), startIn),
    row(t("ถึง"), endIn),
    (() => { const r = document.createElement("div"); r.className = "cal-actions"; r.append(cancel, save); return r; })(),
  );

  const openForm = (startAt?: Date, roomId?: string) => {
    const rooms = o.rooms();
    if (!rooms.length) { say(t("แผนที่นี้ยังไม่มีห้องให้จอง"), true); return; }
    roomIn.innerHTML = "";
    for (const r of rooms) {
      const opt = document.createElement("option");
      opt.value = r.id; opt.textContent = r.label;
      roomIn.appendChild(opt);
    }
    if (roomId) roomIn.value = roomId;
    const from = startAt ?? nextSlot(sameDay(day) ? new Date() : new Date(day.setHours(9, 0, 0, 0)));
    startIn.value = localValue(from);
    endIn.value = localValue(new Date(+from + 60 * 60 * 1000));
    titleIn.value = "";
    form.hidden = false;
    composing = true;
    add.textContent = t("ปิดฟอร์ม");
    titleIn.focus();
  };
  const closeForm = () => {
    form.hidden = true;
    composing = false;
    add.textContent = t("＋ จองห้อง");
  };

  add.onclick = () => (composing ? closeForm() : openForm());
  cancel.onclick = () => closeForm();

  // keep the end after the start without arguing with somebody mid-edit
  startIn.addEventListener("change", () => {
    if (!startIn.value) return;
    const s = new Date(startIn.value);
    if (!endIn.value || new Date(endIn.value) <= s) endIn.value = localValue(new Date(+s + 60 * 60 * 1000));
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rooms = o.rooms();
    const room = rooms.find((r) => r.id === roomIn.value);
    if (!titleIn.value.trim()) { say(t("ตั้งชื่อการประชุมก่อน"), true); titleIn.focus(); return; }
    if (!room) { say(t("เลือกห้องก่อน"), true); return; }
    save.disabled = true;
    try {
      const r = await send("POST", "", {
        title: titleIn.value.trim(),
        roomId: room.id, roomLabel: room.label, mapSlug: o.mapSlug,
        startsAt: new Date(startIn.value).toISOString(),
        endsAt: new Date(endIn.value).toISOString(),
      });
      if (r.status === 409) {
        const c = r.clash as { title?: string; startsAt?: string; endsAt?: string } | undefined;
        say(c
          ? t("ห้องไม่ว่าง — {title} {from}–{to}")
            .replace("{title}", c.title ?? "")
            .replace("{from}", clock(c.startsAt ?? ""))
            .replace("{to}", clock(c.endsAt ?? ""))
          : t("ห้องไม่ว่างช่วงนั้น"), true);
        return;
      }
      if (!r.ok) { say(String(r.error || t("จองไม่สำเร็จ")), true); return; }
      closeForm();
      // jump to the day it lands on, or the booking would vanish into a day
      // nobody is looking at
      day = new Date(startIn.value);
      say(t("จองแล้ว"));
      await refresh();
    } finally {
      save.disabled = false;
    }
  });

  // ---- talking to the API ----
  const qs = o.guest ? `?guest=${encodeURIComponent(o.guest)}` : "";
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${o.api}/workspaces/${encodeURIComponent(o.workspace)}/bookings${path}${qs}`, {
      method,
      headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...d } as Record<string, unknown> & { ok: boolean; status: number };
  };

  const sameDay = (d: Date, other = new Date()) =>
    d.getFullYear() === other.getFullYear() && d.getMonth() === other.getMonth() && d.getDate() === other.getDate();

  async function refresh() {
    // a window either side, so "yesterday" and next week are one fetch apart
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - 1);
    const to = new Date(+from + 30 * DAY);
    const r = await send("GET", `?from=${from.toISOString()}&to=${to.toISOString()}`);
    all = ((r.bookings as Booking[]) ?? []).slice();
    o.onChange?.(all);
    render();
  }

  function render() {
    label.textContent = dayName(day);
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const end = new Date(+start + DAY);
    const today = all
      .filter((b) => +new Date(b.startsAt) < +end && +new Date(b.endsAt) > +start)
      .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt));

    list.innerHTML = "";
    if (!today.length) {
      const empty = document.createElement("div");
      empty.className = "cal-empty";
      empty.textContent = t("ยังไม่มีใครจองห้องวันนี้");
      list.appendChild(empty);
      return;
    }
    const now = Date.now();
    for (const b of today) list.appendChild(card(b, now));
  }

  function card(b: Booking, now: number) {
    const el = document.createElement("div");
    const live = +new Date(b.startsAt) <= now && now < +new Date(b.endsAt);
    const over = +new Date(b.endsAt) <= now;
    el.className = "cal-card" + (live ? " live" : over ? " over" : "");

    const when = document.createElement("span");
    when.className = "cal-when";
    when.textContent = `${clock(b.startsAt)}–${clock(b.endsAt)}`;

    const body = document.createElement("div");
    body.className = "cal-body";
    const name = document.createElement("b"); name.textContent = b.title;
    const where = document.createElement("small");
    where.textContent = b.room + " · " + b.host + (b.going > 1 ? ` · ${t("มา {n} คน").replace("{n}", String(b.going))}` : "");
    body.append(name, where);

    const acts = document.createElement("div");
    acts.className = "cal-acts";
    if (!over && b.ics) {
      // One meeting, for somebody who does not want the whole feed — which is
      // most people, most of the time.
      const one = document.createElement("a");
      one.className = "cal-ics";
      one.href = o.api + b.ics;
      one.download = "meeting.ics";
      one.title = t("เพิ่มลงปฏิทินของคุณ");
      one.textContent = "📅";
      acts.appendChild(one);
    }
    if (!over) {
      const going = document.createElement("button");
      going.className = "cal-going" + (b.imGoing ? " on" : "");
      going.textContent = b.imGoing ? t("จะไป ✓") : t("จะไป");
      going.title = b.imGoing ? t("กดเพื่อบอกว่าไม่ไปแล้ว") : t("บอกว่าจะไป — จะได้รับการเตือนก่อนเริ่ม");
      going.onclick = async () => {
        going.disabled = true;
        const r = await send("POST", `/${encodeURIComponent(b.id)}/going`, { going: !b.imGoing });
        going.disabled = false;
        if (r.ok) await refresh(); else say(t("บันทึกไม่สำเร็จ"), true);
      };
      acts.appendChild(going);
    }
    if (b.mine || o.canManage?.()) {
      const drop = document.createElement("button");
      drop.className = "cal-drop";
      drop.textContent = "✕";
      drop.title = t("ยกเลิกการจอง");
      drop.onclick = async () => {
        if (!confirm(t("ยกเลิก {title}?").replace("{title}", b.title))) return;
        const r = await send("DELETE", `/${encodeURIComponent(b.id)}`);
        if (r.ok) { say(t("ยกเลิกแล้ว")); await refresh(); } else say(t("ยกเลิกไม่สำเร็จ"), true);
      };
      acts.appendChild(drop);
    }

    el.append(when, body, acts);
    return el;
  }

  prev.onclick = () => { day = new Date(+day - DAY); render(); };
  next.onclick = () => { day = new Date(+day + DAY); render(); };

  // the clock moves whether or not anything is fetched: a meeting becomes "now"
  // on its own
  const tick = window.setInterval(render, 30_000);
  const poll = window.setInterval(() => void refresh(), 2 * 60_000);

  /**
   * The address a real calendar subscribes to.
   *
   * This is the whole of "connecting to Google Calendar", and it is more
   * durable than an OAuth integration would be: the same URL is read by
   * Outlook and Apple Calendar, it needs nothing configured, and it cannot
   * break because a token expired. Fetched lazily — a space that never opens
   * this row never gets a key minted.
   */
  if (o.canBook?.() !== false) {
    const link = document.createElement("button");
    link.className = "cal-sub";
    link.textContent = t("ซิงก์เข้าปฏิทินของคุณ");
    link.onclick = async () => {
      link.disabled = true;
      try {
        const r = await fetch(
          `${o.api}/workspaces/${encodeURIComponent(o.workspace)}/calendar-url`,
          { headers: o.token ? { authorization: `Bearer ${o.token}` } : {} },
        );
        const d = (await r.json().catch(() => ({}))) as { url?: string };
        if (!d.url) { say(t("ขอที่อยู่ปฏิทินไม่สำเร็จ"), true); return; }
        foot.innerHTML = "";
        const note = document.createElement("small");
        note.textContent = t("วางที่อยู่นี้ใน Google Calendar › เพิ่มปฏิทิน › จาก URL");
        const box = document.createElement("input");
        box.type = "text"; box.readOnly = true; box.value = d.url;
        box.onclick = () => box.select();
        const copy = document.createElement("button");
        copy.className = "cal-copy";
        copy.textContent = t("คัดลอก");
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(d.url!); copy.textContent = t("คัดลอกแล้ว ✓"); }
          catch { box.select(); }
        };
        // Said plainly, because a URL that opens a calendar without a login is
        // a credential, and it does not look like one.
        const warn = document.createElement("small");
        warn.className = "cal-warn";
        warn.textContent = t("ใครมีที่อยู่นี้ก็อ่านปฏิทินได้ — เปลี่ยนใหม่ได้ในหน้าตั้งค่า");
        foot.append(note, box, copy, warn);
      } finally {
        link.disabled = false;
      }
    };
    foot.appendChild(link);
  }

  void refresh();

  return {
    refresh,
    bookings: () => all,
    /** open the form already pointed at a room, from the map */
    bookRoom: (roomId: string) => { if (form.hidden) openForm(undefined, roomId); },
    /** the subscribe row, filled in once the address is known */
    foot,
    dispose: () => { window.clearInterval(tick); window.clearInterval(poll); },
  };
}
