// The admin dashboard: who used the space, when, and which rooms.
//
// Every chart here plots one series, so every chart is one hue, more-is-darker,
// and none of them carries a legend — the heading already says what is drawn.
// Nothing is coloured by category, because nothing here has categories: it is
// all magnitude, which is the form that stays readable for everybody.
//
// The numbers are computed by the API rather than here, so two admins looking
// at the same week see the same week.

import { API, authToken } from "../api";
import { WORKSPACE } from "../workspace";
import { t, applyLang, locale } from "../i18n";
import { applyColorMode, watchSystemColorMode } from "../appearance";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = "http://www.w3.org/2000/svg";

interface Stats {
  days: number; from: string; to: string;
  totals: { visits: number; open: number; people: number; seconds: number };
  daily: { day: string; visits: number; seconds: number; people: number }[];
  hourly: number[];
  people: { name: string; userId: string | null; guest: boolean; visits: number; seconds: number; last: string }[];
  rooms: { key: string; label: string; open: boolean; seconds: number }[];
}

let days = 30;

// ---- formatting ---------------------------------------------------------------

/** hours and minutes, because a dashboard in seconds is a dashboard nobody reads */
function hhmm(seconds: number) {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  if (!h) return t("{n} นาที").replace("{n}", String(m));
  if (!m) return t("{n} ชม.").replace("{n}", String(h));
  return t("{h} ชม. {m} นาที").replace("{h}", String(h)).replace("{m}", String(m));
}
const hours = (seconds: number) => Math.round(seconds / 360) / 10;
const dayLabel = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString(locale(), { day: "numeric", month: "short" });
const when = (iso: string) =>
  new Date(iso).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// ---- the tooltip every mark shares ---------------------------------------------

const tip = () => $("tip");
function showTip(e: MouseEvent, text: string) {
  const el = tip();
  el.textContent = text;
  el.style.opacity = "1";
  // kept inside the window: a tooltip that runs off the right edge is a tooltip
  // for the marks on the left only
  const w = el.offsetWidth, pad = 12;
  el.style.left = `${Math.min(e.clientX + 14, window.innerWidth - w - pad)}px`;
  el.style.top = `${Math.max(pad, e.clientY - 34)}px`;
}
const hideTip = () => { tip().style.opacity = "0"; };

// ---- one chart shape, used three times -----------------------------------------

interface Bar { label: string; value: number; tip: string }

/**
 * Columns growing from a single baseline.
 *
 * @param every label every Nth column, so thirty days do not become thirty
 *   overlapping dates. The rest are still named in the tooltip and the table.
 * @param recentEnd scroll to the right on first paint. True for a series that
 *   ends at today; false for a fixed axis like the 24 hours of a day, where
 *   starting at midnight is the whole point.
 */
function columns(host: HTMLElement, bars: Bar[], fmt: (v: number) => string, every = 1, recentEnd = false) {
  host.innerHTML = "";
  if (!bars.length || bars.every((b) => !b.value)) {
    host.innerHTML = `<div class="empty">${t("ยังไม่มีข้อมูลในช่วงนี้")}</div>`;
    return;
  }

  const H = 190, PAD_T = 22, PAD_B = 26, PAD_L = 46;
  const slot = Math.max(14, Math.min(38, Math.floor(760 / bars.length)));
  const W = PAD_L + slot * bars.length + 8;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(...bars.map((b) => b.value));
  // clean round ticks, so the axis carries the values that are not labelled
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step || step;

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("role", "img");

  const grid = document.createElementNS(SVG, "g");
  grid.setAttribute("class", "grid");
  for (let v = 0; v <= top + 0.001; v += step) {
    const y = PAD_T + plotH - (v / top) * plotH;
    const line = document.createElementNS(SVG, "line");
    line.setAttribute("x1", String(PAD_L - 6)); line.setAttribute("x2", String(W));
    line.setAttribute("y1", String(y)); line.setAttribute("y2", String(y));
    grid.appendChild(line);
    const tk = document.createElementNS(SVG, "text");
    tk.setAttribute("class", "tick");
    tk.setAttribute("x", String(PAD_L - 10)); tk.setAttribute("y", String(y + 3.5));
    tk.setAttribute("text-anchor", "end");
    tk.textContent = fmt(v);
    grid.appendChild(tk);
  }
  svg.appendChild(grid);

  // ≤24px thick, and never the whole slot: the leftover is the 2px surface gap
  // that separates neighbours, plus air
  const thick = Math.min(24, slot - 6);
  const peak = bars.reduce((best, b, i) => (b.value > bars[best].value ? i : best), 0);

  bars.forEach((b, i) => {
    const x = PAD_L + i * slot + (slot - thick) / 2;
    const h = b.value ? Math.max(2, (b.value / top) * plotH) : 0;
    const y = PAD_T + plotH - h;

    // a hit target the full height of the slot, so a one-pixel bar is hoverable
    const hit = document.createElementNS(SVG, "rect");
    hit.setAttribute("class", "hit");
    hit.setAttribute("x", String(PAD_L + i * slot)); hit.setAttribute("y", String(PAD_T));
    hit.setAttribute("width", String(slot)); hit.setAttribute("height", String(plotH));
    hit.addEventListener("mousemove", (e) => showTip(e, b.tip));
    hit.addEventListener("mouseleave", hideTip);
    svg.appendChild(hit);

    if (h) {
      const r = document.createElementNS(SVG, "rect");
      r.setAttribute("class", "bar");
      r.setAttribute("x", String(x)); r.setAttribute("y", String(y));
      r.setAttribute("width", String(thick)); r.setAttribute("height", String(h));
      // rounded at the data end, square on the baseline
      r.setAttribute("rx", "4");
      if (h > 8) {
        const foot = document.createElementNS(SVG, "rect");
        foot.setAttribute("class", "bar");
        foot.setAttribute("x", String(x)); foot.setAttribute("y", String(PAD_T + plotH - 5));
        foot.setAttribute("width", String(thick)); foot.setAttribute("height", "5");
        svg.appendChild(foot);
      }
      svg.appendChild(r);
    }

    if (i % every === 0) {
      const tx = document.createElementNS(SVG, "text");
      tx.setAttribute("class", "tick");
      tx.setAttribute("x", String(PAD_L + i * slot + slot / 2));
      tx.setAttribute("y", String(H - 8));
      tx.setAttribute("text-anchor", "middle");
      tx.textContent = b.label;
      svg.appendChild(tx);
    }
  });

  // one direct label, on the tallest column: the rest are carried by the axis
  if (bars[peak].value) {
    const x = PAD_L + peak * slot + slot / 2;
    const y = PAD_T + plotH - (bars[peak].value / top) * plotH;
    const lb = document.createElementNS(SVG, "text");
    lb.setAttribute("class", "lab");
    lb.setAttribute("x", String(x)); lb.setAttribute("y", String(Math.max(11, y - 7)));
    lb.setAttribute("text-anchor", peak === 0 ? "start" : peak === bars.length - 1 ? "end" : "middle");
    lb.textContent = fmt(bars[peak].value);
    svg.appendChild(lb);
  }

  host.appendChild(svg);
  // A month view that starts on three empty weeks looks like a dashboard with
  // no data in it, so a series that ends at today opens on today.
  if (recentEnd) host.scrollLeft = host.scrollWidth;
}

/** rows growing from a shared left edge — for a handful of long names */
function rows(host: HTMLElement, bars: Bar[], fmt: (v: number) => string) {
  host.innerHTML = "";
  if (!bars.length) {
    host.innerHTML = `<div class="empty">${t("ยังไม่มีข้อมูลในช่วงนี้")}</div>`;
    return;
  }
  const list = bars.slice(0, 10);
  const max = Math.max(...list.map((b) => b.value)) || 1;
  const wrap = document.createElement("table");
  wrap.innerHTML = `<thead><tr><th>${t("โซน")}</th><th></th><th class="num">${t("เวลารวม")}</th></tr></thead>`;
  const body = document.createElement("tbody");
  for (const b of list) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = b.label;
    name.style.whiteSpace = "nowrap";

    const barCell = document.createElement("td");
    barCell.style.width = "100%";
    const track = document.createElement("div");
    track.style.cssText = "height:14px;border-radius:4px;background:var(--mark-soft);overflow:hidden";
    const fill = document.createElement("div");
    fill.style.cssText = `height:100%;width:${Math.max(2, (b.value / max) * 100)}%;background:var(--mark);border-radius:0 4px 4px 0`;
    track.appendChild(fill);
    barCell.appendChild(track);
    barCell.title = b.tip;

    const val = document.createElement("td");
    val.className = "num";
    val.textContent = fmt(b.value);
    val.style.whiteSpace = "nowrap";

    tr.append(name, barCell, val);
    body.appendChild(tr);
  }
  wrap.appendChild(body);
  host.appendChild(wrap);
}

/** 1, 2, 5 x 10^n — the tick steps people read without thinking */
function niceStep(max: number) {
  if (max <= 0) return 1;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** every chart's numbers, as a table, because a chart is not a source */
function tableView(host: HTMLElement, head: string[], body: (string | number)[][]) {
  host.innerHTML = `<summary>${t("ดูเป็นตาราง")}</summary>`;
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("")}</tr></thead>`;
  const tb = document.createElement("tbody");
  for (const r of body) {
    const tr = document.createElement("tr");
    r.forEach((c, i) => {
      const td = document.createElement("td");
      if (i) td.className = "num";
      td.textContent = String(c);
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  host.appendChild(table);
}

// ---- the page -------------------------------------------------------------------

function paintKpis(s: Stats) {
  const avg = s.totals.visits - s.totals.open > 0
    ? Math.round(s.totals.seconds / (s.totals.visits - s.totals.open)) : 0;
  const busiest = s.daily.reduce((best, d) => (d.seconds > best.seconds ? d : best), s.daily[0] ?? { day: "", seconds: 0 });
  const tiles: [string, string, string][] = [
    [t("คนที่เข้ามา"), String(s.totals.people), t("ในช่วง {n} วัน").replace("{n}", String(s.days))],
    [t("การเข้าใช้"), String(s.totals.visits), s.totals.open
      ? t("{n} ครั้งยังอยู่ในห้อง").replace("{n}", String(s.totals.open)) : t("จบแล้วทุกครั้ง")],
    [t("เวลารวม"), hhmm(s.totals.seconds), t("นับเฉพาะครั้งที่จบแล้ว")],
    [t("เฉลี่ยต่อครั้ง"), hhmm(avg), busiest?.seconds
      ? t("วันที่ใช้มากสุด {day}").replace("{day}", dayLabel(busiest.day)) : ""],
  ];
  $("kpis").innerHTML = "";
  for (const [k, v, n] of tiles) {
    const el = document.createElement("div");
    el.className = "kpi";
    el.innerHTML = `<div class="k"></div><div class="v"></div><div class="n"></div>`;
    (el.querySelector(".k") as HTMLElement).textContent = k;
    (el.querySelector(".v") as HTMLElement).textContent = v;
    (el.querySelector(".n") as HTMLElement).textContent = n;
    $("kpis").appendChild(el);
  }
}

function paint(s: Stats) {
  paintKpis(s);

  const every = Math.max(1, Math.ceil(s.daily.length / 12));
  columns($("plot-daily"), s.daily.map((d) => ({
    label: dayLabel(d.day),
    value: hours(d.seconds),
    tip: `${dayLabel(d.day)} · ${hhmm(d.seconds)} · ${t("{n} ครั้ง").replace("{n}", String(d.visits))}`,
  })), (v) => String(Math.round(v * 10) / 10), every, true);
  tableView($("tbl-daily"), [t("วัน"), t("ชั่วโมง"), t("การเข้าใช้"), t("คน")],
    s.daily.filter((d) => d.visits).map((d) => [dayLabel(d.day), hours(d.seconds), d.visits, d.people]));

  columns($("plot-hourly"), s.hourly.map((secs, h) => ({
    label: String(h).padStart(2, "0"),
    value: hours(secs),
    tip: `${String(h).padStart(2, "0")}:00 · ${hhmm(secs)}`,
  })), (v) => String(Math.round(v * 10) / 10), 2);
  tableView($("tbl-hourly"), [t("ชั่วโมง"), t("ชั่วโมงรวม")],
    s.hourly.map((secs, h) => [`${String(h).padStart(2, "0")}:00`, hours(secs)]).filter((r) => r[1]));

  rows($("plot-rooms"), s.rooms.map((r) => ({
    label: r.open ? t("พื้นที่เปิด · {map}").replace("{map}", t(r.label)) : t(r.label),
    value: r.seconds,
    tip: hhmm(r.seconds),
  })), hhmm);

  const host = $("people");
  host.innerHTML = "";
  if (!s.people.length) {
    host.innerHTML = `<div class="empty">${t("ยังไม่มีข้อมูลในช่วงนี้")}</div>`;
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>${t("ชื่อ")}</th><th class="num">${t("การเข้าใช้")}</th>`
    + `<th class="num">${t("เวลารวม")}</th><th class="num">${t("มาล่าสุด")}</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const p of s.people) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = p.guest ? `${p.name} · ${t("แขก")}` : p.name;
    const a = document.createElement("td"); a.className = "num"; a.textContent = String(p.visits);
    const b = document.createElement("td"); b.className = "num"; b.textContent = hhmm(p.seconds);
    const c = document.createElement("td"); c.className = "num"; c.textContent = when(p.last);
    tr.append(name, a, b, c);
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  host.appendChild(table);
}

function block(title: string, body: string) {
  $("wall-title").textContent = title;
  $("wall-body").textContent = body;
  $("wall").hidden = false;
}

async function load() {
  const r = await fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}/stats?days=${days}`, {
    headers: { authorization: `Bearer ${authToken()}` },
  });
  if (r.status === 403) {
    block(t("ต้องเป็นเจ้าของหรือผู้ดูแล"), t("แดชบอร์ดนี้แสดงว่าใครอยู่ที่ไหนนานเท่าไร จึงเปิดให้เฉพาะเจ้าของพื้นที่และผู้ดูแล"));
    return;
  }
  if (r.status === 404) {
    block(t("ไม่พบพื้นที่นี้"), t('ไม่มีพื้นที่ชื่อ "{slug}" — เปิดหน้านี้จากลิงก์ที่มี ?w=<slug> ของพื้นที่ที่ต้องการดู').replace("{slug}", WORKSPACE));
    return;
  }
  if (!r.ok) { block(t("โหลดข้อมูลไม่ได้"), `HTTP ${r.status}`); return; }
  paint(await r.json());
}

function paintRange() {
  const box = $("range");
  box.innerHTML = "";
  for (const n of [7, 30, 90]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t("{n} วัน").replace("{n}", String(n));
    if (n === days) b.setAttribute("aria-pressed", "true");
    else b.addEventListener("click", () => { days = n; paintRange(); void load(); });
    box.appendChild(b);
  }
}

async function boot() {
  // the light/dark choice made in the app, not just the operating system's
  applyColorMode();
  watchSystemColorMode();
  applyLang();
  $("which").textContent = `${t("แดชบอร์ดผู้ดูแล")} · ${WORKSPACE}`;
  $<HTMLAnchorElement>("back").href = `/?w=${encodeURIComponent(WORKSPACE)}`;
  $<HTMLAnchorElement>("wall-link").href = `/?w=${encodeURIComponent(WORKSPACE)}`;

  if (!authToken()) {
    block(t("ต้องเข้าสู่ระบบก่อน"), t("แดชบอร์ดนี้เปิดให้เฉพาะเจ้าของพื้นที่และผู้ดูแล เข้าสู่ระบบที่หน้าหลักก่อนแล้วกลับมาที่ลิงก์นี้อีกครั้ง"));
    return;
  }
  paintRange();
  await load();

  // expose for verification
  (window as unknown as { admin: unknown }).admin = { load, paint, get days() { return days; } };
}

void boot();
