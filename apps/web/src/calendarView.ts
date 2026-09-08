import { t } from "./i18n";
import type { Booking, Room } from "./calendarPanel";

/**
 * The week, drawn at the size a week needs.
 *
 * The sidebar list answers "what is on today" in a column, which is the right
 * shape for glancing and the wrong one for planning: it cannot show that Tuesday
 * afternoon is free while Wednesday is solid. So this is its own surface — seven
 * days across, hours down, every booking where it actually falls.
 *
 * It owns no data and no form. Bookings come from the panel that already loads
 * them, and the form is the panel's own, moved here while it is being filled in
 * and put back afterwards. A second copy of either would be a second thing to
 * keep in step, and they would not stay in step.
 */

/** the hours drawn. Outside these a booking is still shown, clamped to the edge. */
const FIRST_HOUR = 7;
const LAST_HOUR = 21;
const ROW_PX = 52;

const startOfWeek = (d: Date) => {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - s.getDay()); // weeks start Sunday, as the day strip reads
  return s;
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const hhmm = (d: Date) =>
  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export type WeekOptions = {
  bookings: () => Booking[];
  rooms: () => Room[];
  /** the panel's own form, and the way to open it at a chosen time */
  form: HTMLElement;
  compose: (startAt?: Date, roomId?: string) => void;
  /** the subscribe row, which belongs wherever the calendar is being read */
  foot: HTMLElement;
  canBook: () => boolean;
  canManage?: () => boolean;
  /** the panel's own actions, so this view carries no second copy of them */
  cancel?: (id: string) => Promise<boolean>;
  going?: (id: string, coming: boolean) => Promise<boolean>;
  onOpen?: () => void;
};

export function mountCalendarWeek(o: WeekOptions) {
  const view = document.getElementById("cal-view");
  const daysEl = document.getElementById("cw-days");
  const grid = document.getElementById("cw-grid");
  const scroll = document.getElementById("cw-scroll");
  const monthEl = document.getElementById("cw-month");
  const modal = document.getElementById("cw-modal");
  const sheet = document.getElementById("cw-sheet");
  const footEl = document.getElementById("cw-foot");
  if (!view || !daysEl || !grid || !scroll || !monthEl || !modal || !sheet || !footEl) {
    // The shell lives in index.html. Missing it is a build that shipped half of
    // itself, not a state to paper over — but it must not take the scene down.
    console.warn("[calendar] the week view has no markup to draw into");
    return { open: () => {}, close: () => {}, draw: () => {}, isOpen: () => false, dispose: () => {} };
  }
  // Narrowed once, so the rest reads as the DOM it already checked for.
  const modalEl = modal, sheetEl = sheet, gridEl = grid, daysBar = daysEl, monthBar = monthEl;

  let anchor = startOfWeek(new Date());
  const home = o.form.parentElement;

  // ---- the form, borrowed ---------------------------------------------------
  /**
   * Put it back the moment it closes.
   *
   * The panel hides its own form on save and on cancel and knows nothing about
   * this view, so watching the attribute is what keeps the two honest — no new
   * callback to forget to fire, and nothing to go wrong if the panel later
   * closes the form for a reason this file has not heard of.
   */
  const watcher = new MutationObserver(() => {
    if (o.form.hidden && !modalEl.hidden) release();
  });
  watcher.observe(o.form, { attributes: true, attributeFilter: ["hidden"] });

  function borrow(startAt?: Date) {
    if (!o.canBook()) return;
    sheetEl.appendChild(o.form);
    modalEl.hidden = false;
    o.compose(startAt);
  }
  function release() {
    modalEl.hidden = true;
    home?.appendChild(o.form);
    draw();
  }
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) release(); });


  // ---- what a booking says when you click it --------------------------------
  /**
   * A card beside the booking, not a dialog in the middle.
   *
   * The week is the context — which day, what is next to it — and a modal takes
   * that away to say less. It closes on the next click anywhere else, so it
   * never has to be dismissed on purpose.
   */
  const pop = document.createElement("div");
  pop.className = "cw-pop";
  pop.hidden = true;
  document.body.appendChild(pop);
  const hidePop = () => { pop.hidden = true; };
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node)) hidePop();
  });

  function showPop(b: Booking, near: HTMLElement) {
    const from = new Date(b.startsAt), to = new Date(b.endsAt);
    const over = +to < Date.now();
    pop.innerHTML = "";

    const h = document.createElement("h4");
    h.textContent = b.title;
    const dl = document.createElement("dl");
    const row = (k: string, v: string) => {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    };
    row(t("ห้อง"), b.room);
    row(t("เวลา"), `${from.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${hhmm(from)}–${hhmm(to)}`);
    row(t("ผู้จอง"), b.host);
    row(t("จะไป"), String(b.going));
    pop.append(h, dl);

    const acts = document.createElement("div");
    acts.className = "cw-pop-acts";
    if (!over && o.going) {
      const going = document.createElement("button");
      going.className = b.imGoing ? "on" : "";
      going.textContent = b.imGoing ? t("จะไป ✓") : t("จะไป");
      going.onclick = async () => {
        going.disabled = true;
        await o.going!(b.id, !b.imGoing);
        hidePop();
      };
      acts.appendChild(going);
    }
    if (o.cancel && (b.mine || o.canManage?.())) {
      const drop = document.createElement("button");
      drop.className = "drop";
      drop.textContent = t("ยกเลิก");
      const sure = document.createElement("div");
      sure.className = "cw-pop-sure";
      sure.hidden = true;
      const yes = document.createElement("button");
      yes.className = "drop";
      yes.textContent = t("ยืนยันยกเลิก");
      yes.onclick = async () => {
        yes.disabled = true;
        await o.cancel!(b.id);
        hidePop();
      };
      sure.append(document.createTextNode(t("ยกเลิกการประชุมนี้? คนที่จะไปจะได้รับอีเมลแจ้ง") + " "), yes);
      drop.onclick = () => { sure.hidden = !sure.hidden; };
      acts.appendChild(drop);
      pop.append(acts, sure);
    } else {
      pop.append(acts);
    }

    // Beside the booking, and never off the edge of the window.
    pop.hidden = false;
    const at = near.getBoundingClientRect();
    const box = pop.getBoundingClientRect();
    const left = Math.min(Math.max(8, at.right + 8), window.innerWidth - box.width - 8);
    const top = Math.min(Math.max(8, at.top), window.innerHeight - box.height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  // ---- drawing --------------------------------------------------------------
  function draw() {
    const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
    const today = new Date();
    const cols = `56px repeat(7, minmax(0, 1fr))`;

    monthBar.textContent = anchor.toLocaleDateString([], { month: "long", year: "numeric" });

    daysBar.style.gridTemplateColumns = cols;
    daysBar.innerHTML = "";
    daysBar.appendChild(document.createElement("div")); // the gutter has no heading
    for (const d of days) {
      const cell = document.createElement("div");
      cell.className = "cw-day" + (sameDay(d, today) ? " today" : "");
      const name = document.createElement("span");
      name.textContent = d.toLocaleDateString([], { weekday: "short" });
      const num = document.createElement("b");
      num.textContent = String(d.getDate());
      cell.append(name, num);
      daysBar.appendChild(cell);
    }

    gridEl.style.gridTemplateColumns = cols;
    gridEl.style.gridTemplateRows = `repeat(${LAST_HOUR - FIRST_HOUR + 1}, ${ROW_PX}px)`;
    hidePop();                      // it points at an element about to be replaced
    gridEl.innerHTML = "";
    for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
      const label = document.createElement("div");
      label.className = "cw-gutter";
      label.textContent = h === FIRST_HOUR ? "" : `${String(h).padStart(2, "0")}:00`;
      gridEl.appendChild(label);
      for (let i = 0; i < 7; i++) {
        const cell = document.createElement("div");
        cell.className = "cw-hour cw-col" + (o.canBook() ? " free" : "");
        if (o.canBook()) {
          const at = new Date(days[i]);
          at.setHours(h, 0, 0, 0);
          cell.title = t("จองห้องเวลานี้");
          cell.onclick = () => borrow(at);
        }
        gridEl.appendChild(cell);
      }
    }

    /**
     * Events sit on top of the cells rather than in them.
     *
     * A meeting is not an hour: one that runs 10:30 to 11:15 belongs across two
     * of them, so it is placed by minute. Each gets its own full-height column
     * to be absolute inside — that column is what keeps it on the right day,
     * and it lets clicks through so the empty hours underneath stay clickable.
     */
    const over = layer();
    const top = (d: Date) => ((d.getHours() - FIRST_HOUR) * 60 + d.getMinutes()) * (ROW_PX / 60);
    const floor = (LAST_HOUR - FIRST_HOUR + 1) * ROW_PX;
    for (const b of o.bookings()) {
      const from = new Date(b.startsAt);
      const to = new Date(b.endsAt);
      const col = days.findIndex((d) => sameDay(d, from));
      if (col < 0) continue;
      const y1 = Math.max(0, top(from));
      const y2 = Math.min(floor, top(to));
      if (y2 <= 0 || y1 >= floor) continue;   // entirely outside the hours drawn

      const el = document.createElement("button");
      el.className = "cw-ev" + (b.mine ? " mine" : "") + (+to < Date.now() ? " over" : "");
      el.style.top = `${y1}px`;
      el.style.height = `${Math.max(18, y2 - y1 - 2)}px`;
      el.style.pointerEvents = "auto";
      const title = document.createElement("b");
      title.textContent = b.title;
      const detail = document.createElement("small");
      detail.textContent = `${hhmm(from)}–${hhmm(to)} · ${b.room}`;
      el.append(title, detail);
      el.title = `${b.title}\n${hhmm(from)}–${hhmm(to)} · ${b.room}\n${b.host}`;
      el.onclick = (e) => { e.stopPropagation(); showPop(b, el); };
      column(over, col, el);
    }

    drawNow(over, days, today);
  }

  /**
   * A full-height, click-through track in one day's column.
   *
   * These live on a layer of their own rather than among the hour cells. As
   * grid items they claimed every row of their column, and the cells — which
   * are placed automatically — flowed around them: the hour labels ended up
   * scattered across the middle of the week instead of down the gutter.
   *
   * The layer carries the same column template as the grid it covers, so the
   * two cannot fall out of alignment however the week is resized.
   */
  function layer() {
    const el = document.createElement("div");
    el.className = "cw-layer";
    el.style.gridTemplateColumns = gridEl.style.gridTemplateColumns;
    gridEl.appendChild(el);
    return el;
  }
  function column(on: HTMLElement, day: number, ...kids: HTMLElement[]) {
    const holder = document.createElement("div");
    // Row 1 explicitly, or the grid puts them in rows of their own. Auto
    // placement fills left to right and never goes back, so a Monday holder
    // added after a Tuesday one lands on a second implicit row — which is a
    // booking drawn a few hundred pixels below the hour it belongs to, in a
    // grid that otherwise looks perfectly normal.
    holder.style.cssText = `grid-column:${day + 2};grid-row:1;position:relative`;
    holder.append(...kids);
    on.appendChild(holder);
  }

  function drawNow(on: HTMLElement, days: Date[], today: Date) {
    const col = days.findIndex((d) => sameDay(d, today));
    if (col < 0) return;
    const mins = (today.getHours() - FIRST_HOUR) * 60 + today.getMinutes();
    if (mins < 0 || mins > (LAST_HOUR - FIRST_HOUR + 1) * 60) return;

    const y = mins * (ROW_PX / 60);
    const line = document.createElement("div");
    line.className = "cw-now";
    line.style.cssText += `top:${y}px;left:0;right:0`;
    // The chip hangs off the left edge into yesterday, which is where there is
    // room for it — inside the column it would sit on top of a booking.
    const chip = document.createElement("span");
    chip.className = "cw-now-chip";
    chip.textContent = hhmm(today);
    chip.style.top = `${y}px`;
    chip.style.left = "0";
    column(on, col, line, chip);
  }

  // ---- opening and closing --------------------------------------------------
  const open = () => {
    anchor = startOfWeek(new Date());
    view.hidden = false;
    footEl.appendChild(o.foot);
    draw();
    // Land on the working day rather than at midnight.
    scroll.scrollTop = Math.max(0, (new Date().getHours() - FIRST_HOUR - 1) * ROW_PX);
    o.onOpen?.();
  };
  const close = () => {
    if (!modalEl.hidden) release();
    hidePop();
    view.hidden = true;
  };

  document.getElementById("cw-prev")!.onclick = () => { anchor = addDays(anchor, -7); draw(); };
  document.getElementById("cw-next")!.onclick = () => { anchor = addDays(anchor, 7); draw(); };
  document.getElementById("cw-today")!.onclick = () => { anchor = startOfWeek(new Date()); draw(); };
  document.getElementById("cw-new")!.onclick = () => borrow();
  document.getElementById("cw-close")!.onclick = close;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || view.hidden) return;
    if (!modalEl.hidden) release(); else close();
  });

  // The line moves whether or not anybody is looking, and a stale one is worse
  // than none: it says the afternoon has not started when it is nearly over.
  const tick = window.setInterval(() => { if (!view.hidden) draw(); }, 60_000);

  return {
    open, close, draw,
    isOpen: () => !view.hidden,
    dispose: () => { window.clearInterval(tick); watcher.disconnect(); },
  };
}
