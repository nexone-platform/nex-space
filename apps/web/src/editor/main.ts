// The map editor.
//
// A separate page rather than an overlay in the app: the app boots Phaser, a
// multiplayer session and a media stack, none of which drawing a floor needs.
// It shares the origin, so it reads the same session token, and it shares the
// renderer, so what it draws is what the room will look like.
//
// Everything it produces is a MapDoc — the same document the API validates and
// the browsers load. There is no editor-only format to keep in step.

import { API, authToken } from "../api";
import { t, applyLang } from "../i18n";
import { applyColorMode, watchSystemColorMode } from "../appearance";
import { WORKSPACE, MAP_SLUG } from "../workspace";
import { THEMES, classicTheme } from "../scenes/mapThemes";
import { bakeTheme } from "../scenes/mapFormat";
import type { MapDoc } from "../scenes/mapValidate";
import { EditorState, guessScale, guessSolid, listFor, type Rect, type Tool } from "./state";
import { CATALOGUE } from "./catalogue";
import { artFor, render, type Overlays } from "./view";
import type { MapArt } from "../themePreview";

const TILE = 32;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- the wall in front of everything ---------------------------------------

function block(title: string, body: string) {
  $("wall-title").textContent = title;
  $("wall-body").textContent = body;
  $("wall").hidden = false;
}

// ---- state ------------------------------------------------------------------

let state: EditorState;
let art: MapArt;
let tool: Tool = "floor";
let floorIndex = 0;
// Something is selected from the start, or the prop and desk tools are two
// buttons that silently do nothing until you notice the palette.
let propKey = "desk";
let propDir = "furniture";
let propSolid = true;
let propScale = 1;
let objType: "whiteboard" | "screen" | "portal" | "embed" = "whiteboard";
/**
 * For a whiteboard or an embed: the page it opens.
 *
 * Https only, because the validator refuses anything else — an embed becomes an
 * iframe, and "javascript:" in one is a script on our origin with the signed-in
 * user's session behind it. The whiteboard starts on the board the built-in
 * layouts already use, so placing one is useful without typing anything.
 */
let objUrl = "https://excalidraw.com";
/** for a portal: which map it leads to, "" meaning this one */
let portalMap = "";
/** for a portal: where it puts you down, null meaning that map's own spawn */
let portalTo: { x: number; y: number } | null = null;
/** every map in this space, and which one is open */
let maps: { slug: string; label: string }[] = [];
let openMap = "";
let zoom = 2;
let drag: { rect: Rect } | null = null;
let hover: { x: number; y: number } | null = null;
let saving = false;

const canvas = $<HTMLCanvasElement>("map");

/** the nine tiles of the floors atlas, in atlas order */
const FLOOR_NAMES = ["ครีม", "หญ้า", "ไม้", "ชมพู", "มินต์", "ฟ้า", "ไม้เข้ม", "ทางเดิน", "อิฐ"];

const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: "floor", icon: "▦", label: "พื้น" },
  { id: "wall", icon: "▉", label: "กำแพง" },
  { id: "prop", icon: "🪑", label: "พร็อพ" },
  { id: "desk", icon: "💻", label: "โต๊ะ" },
  { id: "area", icon: "🔒", label: "โซน" },
  { id: "spawn", icon: "📍", label: "จุดเกิด" },
  { id: "interactive", icon: "🖊", label: "วัตถุ" },
  { id: "erase", icon: "🧽", label: "ลบ" },
];

// ---- drawing ------------------------------------------------------------------

/** the whole picture, now */
function paint() {
  const o: Overlays = {
    grid: $<HTMLInputElement>("ck-grid").checked,
    areas: true,
    markers: $<HTMLInputElement>("ck-marks").checked,
    dragRect: drag?.rect ?? null,
    hover,
  };
  render(canvas, state.doc, art, o);
  // The canvas is always the map's true pixel size; zoom is CSS, so the art
  // stays on whole pixels and `image-rendering: pixelated` scales it cleanly.
  canvas.style.width = `${state.doc.cols * TILE * zoom}px`;
  canvas.style.height = `${state.doc.rows * TILE * zoom}px`;
}

/**
 * Ask for a repaint. Coalesced onto a frame because a pointer sweep fires far
 * more often than a screen refreshes, and repainting a 200x200 map per pointer
 * event is the difference between a smooth drag and a stuttering one.
 */
let pending = false;
function draw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; paint(); });
}

/** the art for a document changes as props are added, so reload then redraw */
async function refreshArt() {
  const extra = propKey ? [[propKey, folderFor(propKey, propDir)] as const] : [];
  art = await artFor(state.doc, extra);
  draw();
}

const folderFor = (key: string, dir: string) =>
  key.includes("/") ? key.slice(0, key.indexOf("/")) : dir === "furniture" || dir === "office" ? "furniture" : dir;

// ---- the panels ---------------------------------------------------------------

/**
 * The maps of this space, along the top.
 *
 * Switching is a reload rather than a swap, for the same reason it is in the
 * app: everything here is built around one document, and one document is what
 * an editor should hold. Unsaved work is guarded by the browser's own prompt.
 */
function paintTabs() {
  const box = $("map-tabs");
  box.innerHTML = "";
  for (const m of maps) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t(m.label);
    b.title = m.slug;
    if (m.slug === openMap) b.setAttribute("aria-current", "true");
    else b.addEventListener("click", () => { location.search = `?w=${encodeURIComponent(WORKSPACE)}&m=${encodeURIComponent(m.slug)}`; });
    box.appendChild(b);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "add";
  add.textContent = "＋";
  add.title = t("แผนที่ใหม่");
  add.addEventListener("click", () => void addMap());
  box.appendChild(add);

  // Nothing to arrange until there are two: a lone map cannot be moved anywhere,
  // and removing it is what "back to the stock map" already does.
  if (maps.length < 2) return;

  const at = maps.findIndex((m) => m.slug === openMap);
  const tools = document.createElement("div");
  tools.className = "tools";
  const tool = (label: string, title: string, disabled: boolean, go: () => void, danger = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.disabled = disabled;
    if (danger) b.className = "danger";
    if (!disabled) b.addEventListener("click", go);
    tools.appendChild(b);
  };
  // The first map is the one people land on, so moving one is not decoration —
  // it is how a space picks its front door.
  tool("\u2190", t("ย้ายมาก่อนหน้า"), at <= 0, () => void moveMap(-1));
  tool("\u2192", t("ย้ายไปถัดไป"), at < 0 || at >= maps.length - 1, () => void moveMap(1));
  tool("\ud83d\uddd1", t("ลบแผนที่นี้"), at < 0, () => void deleteMap(), true);
  box.appendChild(tools);

  if (at === 0) {
    const note = document.createElement("span");
    note.className = "landing";
    note.textContent = t("คนเข้ามาเจอชั้นนี้");
    box.appendChild(note);
  }
}

/** shuffle this map one place along; the first is the one people land on */
async function moveMap(by: -1 | 1) {
  const order = maps.map((m) => m.slug);
  const at = order.indexOf(openMap);
  const to = at + by;
  if (at < 0 || to < 0 || to >= order.length) return;
  [order[at], order[to]] = [order[to], order[at]];

  const r = await fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}/maps/order`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken()}` },
    body: JSON.stringify({ order }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { alert(`${t("เรียงลำดับไม่สำเร็จ")} (${r.status})\n${d.error || ""}`); return; }
  maps = order.map((slug) => maps.find((m) => m.slug === slug)!);
  paintTabs();
}

/**
 * Remove this floor.
 *
 * Named in the confirmation rather than a bare yes/no: the button sits beside
 * two that only move things, and what it destroys is somebody's afternoon.
 */
async function deleteMap() {
  const me = maps.find((m) => m.slug === openMap);
  const label = me ? t(me.label) : openMap;
  if (!confirm(t('ลบ "{name}" ทิ้งถาวร? ทุกอย่างที่วางไว้บนแผนที่นี้จะหายไปด้วย').replace("{name}", label))) return;

  const r = await fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}/map/${encodeURIComponent(openMap)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${authToken()}` },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { alert(`${t("ลบไม่สำเร็จ")} (${r.status}) ${d.error || ""}`); return; }
  // the document on screen no longer exists anywhere, so stop offering to save it
  state?.markSaved();
  location.search = d.landing
    ? `?w=${encodeURIComponent(WORKSPACE)}&m=${encodeURIComponent(d.landing)}`
    : `?w=${encodeURIComponent(WORKSPACE)}`;
}

/**
 * A new, empty floor.
 *
 * Empty rather than a copy of the current one: a duplicate carries its desks
 * and its areas, and two floors sharing a desk id is a claim that lands on
 * whichever the server saw last.
 */
async function addMap() {
  const label = prompt(t("ชื่อแผนที่ใหม่"), t("ชั้นใหม่"));
  if (!label || !label.trim()) return;
  let n = maps.length + 1;
  while (maps.some((m) => m.slug === `map-${n}`)) n++;
  const slug = `map-${n}`;

  const cols = 24, rows = 18;
  const blank: MapDoc = {
    v: 1, id: slug, label: label.trim().slice(0, 60), cols, rows,
    spawn: { x: 2, y: 2 }, meetingRoom: { x0: 0, x1: 0, y0: 0, y1: 0 },
    floors: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0)),
    walls: [], furniture: [], outdoor: [], decals: [], decor: [],
    desks: [], interactives: [], areas: [],
  };
  const r = await fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}/map/${slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken()}` },
    body: JSON.stringify({ map: blank }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { alert(`${t("บันทึกไม่สำเร็จ")} (${r.status})\n${d.problem || d.error || ""}`); return; }
  location.search = `?w=${encodeURIComponent(WORKSPACE)}&m=${slug}`;
}

function paintTools() {
  const box = $("tools");
  box.innerHTML = "";
  for (const tl of TOOLS) {
    const b = document.createElement("button");
    b.className = "tool";
    b.type = "button";
    b.setAttribute("aria-pressed", String(tool === tl.id));
    b.innerHTML = `<span class="k">${tl.icon}</span>`;
    const s = document.createElement("span");
    s.textContent = t(tl.label);
    b.appendChild(s);
    b.addEventListener("click", () => { tool = tl.id; paintTools(); paintOptions(); });
    box.appendChild(b);
  }
}

/** one 32px slice of the floors atlas, drawn into a swatch */
function floorSwatch(i: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = TILE; c.height = TILE;
  const img = art?.floors;
  if (img) c.getContext("2d")!.drawImage(img, i * TILE, 0, TILE, TILE, 0, 0, TILE, TILE);
  return c;
}

function paintOptions() {
  const box = $("opts");
  box.innerHTML = "";
  const head = (text: string) => {
    const h = document.createElement("h3");
    h.textContent = t(text);
    box.appendChild(h);
  };
  const hint = (text: string) => {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = t(text);
    box.appendChild(p);
  };

  if (tool === "floor") {
    head("พื้น");
    const g = document.createElement("div");
    g.className = "swatches";
    for (let i = 0; i < 9; i++) {
      const b = document.createElement("button");
      b.className = "sw";
      b.type = "button";
      b.title = t(FLOOR_NAMES[i]);
      b.setAttribute("aria-pressed", String(floorIndex === i));
      b.appendChild(floorSwatch(i));
      b.addEventListener("click", () => { floorIndex = i; paintOptions(); });
      g.appendChild(b);
    }
    box.appendChild(g);
    hint("ลากเพื่อทาหลายช่อง");
    return;
  }

  if (tool === "wall") {
    head("กำแพง");
    hint("คลิกหรือลากเพื่อวางกำแพง · กด Alt ค้างไว้เพื่อลบ · ลายกำแพงต่อกันเองอัตโนมัติ");
    return;
  }

  if (tool === "prop" || tool === "desk") {
    head(tool === "desk" ? "โต๊ะที่จะวาง" : "พร็อพ");
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = t("ค้นหา…");
    box.appendChild(search);

    const list = document.createElement("div");
    box.appendChild(list);

    const paintProps = (q: string) => {
      list.innerHTML = "";
      for (const group of CATALOGUE) {
        const keys = group.keys.filter((k) => !q || k.includes(q));
        if (!keys.length) continue;
        const h = document.createElement("h3");
        h.textContent = t(group.label);
        h.style.marginTop = "8px";
        list.appendChild(h);
        const g = document.createElement("div");
        g.className = "props";
        for (const key of keys) {
          const b = document.createElement("button");
          b.className = "prop";
          b.type = "button";
          b.title = key;
          b.setAttribute("aria-pressed", String(propKey === key));
          const img = document.createElement("img");
          const folder = folderFor(key, group.dir);
          const file = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
          img.src = `/assets/${folder}/${file}.png`;
          img.alt = key;
          img.loading = "lazy";
          b.appendChild(img);
          b.addEventListener("click", () => {
            propKey = key;
            propDir = group.dir;
            propSolid = guessSolid(key);
            propScale = guessScale(key);
            paintOptions();
            void refreshArt();
          });
          g.appendChild(b);
        }
        list.appendChild(g);
      }
      if (!list.children.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = t("ไม่พบพร็อพที่ค้นหา");
        list.appendChild(e);
      }
    };
    paintProps("");
    search.addEventListener("input", () => paintProps(search.value.trim().toLowerCase()));

    if (tool === "prop" && listFor(propDir) === "furniture") {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<label><input type="checkbox" id="ck-solid"${propSolid ? " checked" : ""} /> ${t("เดินทะลุไม่ได้")}</label>`;
      const scale = document.createElement("label");
      scale.append(t("ขนาด") + " ");
      const sel = document.createElement("select");
      for (const v of [0.5, 1]) {
        const o = document.createElement("option");
        o.value = String(v);
        o.textContent = v === 1 ? t("เต็ม") : t("ครึ่ง");
        if (v === propScale) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => { propScale = Number(sel.value); });
      scale.appendChild(sel);
      row.appendChild(scale);
      box.appendChild(row);
      row.querySelector<HTMLInputElement>("#ck-solid")!
        .addEventListener("change", (e) => { propSolid = (e.target as HTMLInputElement).checked; });
    }
    if (tool === "desk") hint("วางโต๊ะที่จองได้ ที่นั่งจะอยู่ช่องถัดลงมาหนึ่งช่อง");
    return;
  }

  if (tool === "area") {
    head("โซนส่วนตัว");
    hint("ลากคลุมพื้นที่เพื่อสร้างโซน · ตั้งชื่อได้จากรายการทางขวา");
    return;
  }
  if (tool === "spawn") {
    head("จุดเกิด");
    hint("คลิกช่องที่คนเข้าห้องใหม่จะยืน · ต้องไม่ใช่กำแพง");
    return;
  }
  if (tool === "interactive") {
    head("วัตถุโต้ตอบ");
    const sel = document.createElement("select");
    for (const [v, name] of [["whiteboard", "ไวท์บอร์ด"], ["screen", "จอนำเสนอ"], ["portal", "ประตูมิติ"], ["embed", "ฝังหน้าเว็บ"]] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t(name);
      if (objType === v) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      objType = sel.value as typeof objType;
      // An embed with the whiteboard's address still open in the field would be
      // a link to somebody else's drawing board, which is nobody's intent.
      if (objType === "embed" && objUrl === "https://excalidraw.com") objUrl = "";
      if (objType === "whiteboard" && !objUrl) objUrl = "https://excalidraw.com";
      paintOptions();
    });
    box.appendChild(sel);

    if (objType === "whiteboard" || objType === "embed") {
      head("ที่อยู่เว็บที่จะเปิด");
      const url = document.createElement("input");
      url.type = "text";
      url.placeholder = "https://…";
      url.value = objUrl;
      url.addEventListener("input", () => { objUrl = url.value.trim(); paintUrlNote(); });
      box.appendChild(url);

      const note = document.createElement("p");
      note.className = "hint";
      note.id = "obj-url-note";
      box.appendChild(note);
      // said while typing rather than on refusal: the map cannot be saved with a
      // bad one, and finding that out at save time means finding it out late
      const paintUrlNote = () => {
        const ok = /^https:\/\/\S+$/i.test(objUrl);
        note.textContent = ok
          ? t("กด E ตอนยืนข้าง ๆ เพื่อเปิด")
          : t("ต้องเป็น https:// — วางแบบอื่นไม่ได้ เพราะหน้านี้ถูกเปิดในเฟรมบนโดเมนของเรา");
        note.style.color = ok ? "" : "var(--danger)";
      };
      paintUrlNote();
    }

    if (objType === "portal") {
      head("ไปที่แผนที่");
      const dest = document.createElement("select");
      for (const m of [{ slug: "", label: "แผนที่นี้" }, ...maps.filter((m) => m.slug !== openMap)]) {
        const o = document.createElement("option");
        o.value = m.slug;
        o.textContent = t(m.label);
        if (m.slug === portalMap) o.selected = true;
        dest.appendChild(o);
      }
      dest.addEventListener("change", () => { portalMap = dest.value; paintOptions(); });
      box.appendChild(dest);

      const row = document.createElement("div");
      row.className = "row";
      const mk = (which: "x" | "y") => {
        const l = document.createElement("label");
        l.append(which.toUpperCase() + " ");
        const i = document.createElement("input");
        i.type = "number"; i.min = "0"; i.max = "199";
        i.value = portalTo ? String(portalTo[which]) : "";
        i.addEventListener("change", () => {
          const x = Number((row.querySelector("input") as HTMLInputElement).value);
          const y = Number((row.querySelectorAll("input")[1] as HTMLInputElement).value);
          portalTo = Number.isFinite(x) && Number.isFinite(y)
            && (row.querySelector("input") as HTMLInputElement).value !== ""
            && (row.querySelectorAll("input")[1] as HTMLInputElement).value !== ""
            ? { x, y } : null;
        });
        l.appendChild(i);
        return l;
      };
      row.append(mk("x"), mk("y"));
      box.appendChild(row);
      hint(portalMap
        ? "เว้นช่องว่างไว้เพื่อไปโผล่ที่จุดเกิดของแผนที่ปลายทาง"
        : "ประตูมิติในแผนที่เดียวกันต้องระบุช่องปลายทาง");
    }

    // the url field says this already for the two kinds that have one
    if (objType === "screen" || objType === "portal") hint("ยืนข้างวัตถุแล้วกด E เพื่อใช้งาน");
    return;
  }
  if (tool === "erase") {
    head("ลบ");
    hint("ลบสิ่งที่อยู่บนสุดของช่องนั้น: วัตถุ → โต๊ะ → พร็อพ → กำแพง · โซนลบได้จากรายการทางขวา");
  }
}

function paintLists() {
  const d = state.doc;

  const areas = $("area-list");
  areas.innerHTML = "";
  if (!d.areas.length) areas.innerHTML = `<div class="empty">${t("ยังไม่มีโซน")}</div>`;
  for (const a of d.areas) {
    const isMeeting = d.meetingRoom.x0 === a.x0 && d.meetingRoom.x1 === a.x1
                   && d.meetingRoom.y0 === a.y0 && d.meetingRoom.y1 === a.y1;
    const row = document.createElement("div");
    row.className = "item" + (isMeeting ? " meet" : "");
    const b = document.createElement("b");
    b.textContent = t(a.label);
    b.title = `${a.x0},${a.y0} → ${a.x1},${a.y1}`;
    row.appendChild(b);

    const lock = document.createElement("button");
    lock.textContent = a.locked ? "🔐" : "🔓";
    lock.title = a.locked ? t("ล็อกอยู่ — ต้องมีคนข้างในเปิดให้") : t("เปิดให้ทุกคนเดินเข้าได้");
    lock.setAttribute("aria-label", lock.title);
    lock.addEventListener("click", () => state.toggleLock(a.id));
    row.appendChild(lock);

    const rename = document.createElement("button");
    rename.textContent = t("เปลี่ยนชื่อ");
    rename.addEventListener("click", () => {
      const name = prompt(t("ชื่อโซน"), a.label);
      if (name && name.trim()) state.renameArea(a.id, name.trim().slice(0, 60));
    });
    const meet = document.createElement("button");
    meet.textContent = t("ประชุม");
    meet.title = t("ใช้โซนนี้เป็นห้องประชุม");
    meet.disabled = isMeeting;
    meet.addEventListener("click", () => state.useAreaAsMeetingRoom(a.id));
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = t("ลบ");
    del.addEventListener("click", () => state.removeArea(a.id));
    row.append(rename, meet, del);
    areas.appendChild(row);
  }

  const desks = $("desk-list");
  desks.innerHTML = "";
  if (!d.desks.length) desks.innerHTML = `<div class="empty">${t("ยังไม่มีโต๊ะ")}</div>`;
  for (const k of d.desks) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<b>${k.id}</b><span>${k.x},${k.y}</span>`;
    desks.appendChild(row);
  }

  const objs = $("obj-list");
  objs.innerHTML = "";
  if (!d.interactives.length) objs.innerHTML = `<div class="empty">${t("ยังไม่มีวัตถุ")}</div>`;
  for (const i of d.interactives) {
    const row = document.createElement("div");
    row.className = "item";
    const where = i.type === "portal"
      ? (i.map ? `→ ${t(maps.find((m) => m.slug === i.map)?.label ?? i.map)}` : "→ " + t("แผนที่นี้"))
      : `${i.x},${i.y}`;
    row.innerHTML = `<b>${i.icon} ${t(i.label)}</b><span>${where}</span>`;
    objs.appendChild(row);
  }
}

function paintStatus() {
  const p = state.problem;
  const el = $("st-problem");
  el.textContent = p ? `${t("บันทึกไม่ได้")}: ${p}` : "";
  el.className = p ? "bad" : "";
  $("st-saved").textContent = saving ? t("กำลังบันทึก…") : state.dirty ? t("ยังไม่ได้บันทึก") : t("บันทึกแล้ว");
  $("st-saved").className = state.dirty && !saving ? "" : "good";
  $<HTMLButtonElement>("btn-save").disabled = saving || !!p || !state.dirty;
  $<HTMLButtonElement>("btn-undo").disabled = !state.canUndo;
  $<HTMLButtonElement>("btn-redo").disabled = !state.canRedo;
  ($("in-cols") as HTMLInputElement).value = String(state.doc.cols);
  ($("in-rows") as HTMLInputElement).value = String(state.doc.rows);
  const name = $<HTMLInputElement>("map-name");
  if (document.activeElement !== name) name.value = state.doc.label;
}

// ---- pointer ------------------------------------------------------------------

function tileAt(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.floor((e.clientX - r.left) / (TILE * zoom)),
    y: Math.floor((e.clientY - r.top) / (TILE * zoom)),
  };
}

function apply(x: number, y: number, alt: boolean) {
  if (!state.inside(x, y)) return;
  switch (tool) {
    case "floor": state.setFloor(x, y, floorIndex); break;
    case "wall": state.setWall(x, y, !alt); break;
    case "prop":
      if (propKey) state.addProp(propKey, propDir, x, y, propSolid, propScale);
      break;
    case "desk":
      if (propKey) state.addDesk(propKey, propDir, x, y, propScale);
      break;
    case "spawn": state.setSpawn(x, y); break;
    case "interactive": {
      // stored in Thai, like every other label on a map, and translated where
      // it is displayed — a map made here has to read the same in both languages
      const label = objType === "whiteboard" ? "ไวท์บอร์ด"
        : objType === "screen" ? "จอนำเสนอ"
        : objType === "embed" ? "ฝังหน้าเว็บ" : "ประตูมิติ";
      const to = objType === "portal" ? { map: portalMap, target: portalTo ?? undefined } : undefined;
      const needsUrl = objType === "whiteboard" || objType === "embed";
      if (needsUrl && !/^https:\/\/\S+$/i.test(objUrl)) {
        // Refused here rather than placed and rejected at save: an object that
        // opens nothing looks identical to one that works until somebody
        // presses E on it.
        alert(t("ต้องใส่ที่อยู่ https:// ก่อนวางวัตถุนี้"));
        break;
      }
      state.addInteractive(objType, x, y, label, to, needsUrl ? objUrl : undefined);
      break;
    }
    case "erase": state.eraseAt(x, y); break;
  }
}

/** tools you can hold the button down and sweep with; the rest place one thing */
const SWEEPABLE: Tool[] = ["floor", "wall", "erase"];

function wirePointer() {
  let down = false;
  let last = "";

  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = tileAt(e);
    if (!state.inside(x, y)) return;
    canvas.setPointerCapture(e.pointerId);
    down = true;
    if (tool === "area") {
      drag = { rect: { x0: x, y0: y, x1: x, y1: y } };
      draw();
      return;
    }
    state.beginStroke();
    last = `${x},${y}`;
    apply(x, y, e.altKey);
  });

  canvas.addEventListener("pointermove", (e) => {
    const { x, y } = tileAt(e);
    const inb = state.inside(x, y);
    const next = inb ? { x, y } : null;
    if (next?.x !== hover?.x || next?.y !== hover?.y) {
      hover = next;
      $("st-tile").innerHTML = inb ? `${t("ช่อง")} <b>${x}, ${y}</b>` : "—";
      const what = inb ? state.whatIsAt(x, y) : null;
      $("st-what").textContent = what ? t(what) : "";
      draw();
    }
    if (!down || !inb) return;
    if (drag) { drag.rect.x1 = x; drag.rect.y1 = y; draw(); return; }
    if (!SWEEPABLE.includes(tool)) return;
    const key = `${x},${y}`;
    if (key === last) return;
    last = key;
    apply(x, y, e.altKey);
  });

  const release = () => {
    if (!down) return;
    down = false;
    if (drag) {
      const r = drag.rect;
      drag = null;
      const name = prompt(t("ชื่อโซน"), t("โซนใหม่"));
      if (name && name.trim()) state.addArea(r, name.trim().slice(0, 60));
      else draw();
      return;
    }
    state.endStroke();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    if (hover) { hover = null; $("st-tile").textContent = "—"; $("st-what").textContent = ""; draw(); }
  });
}

// ---- saving -------------------------------------------------------------------

async function save() {
  if (saving) return;
  saving = true;
  paintStatus();
  try {
    // By name, always. Saving to the unnamed path would write whichever map
    // happens to be first, which is how you lose a floor.
    const r = await fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}/map/${encodeURIComponent(state.doc.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${authToken()}` },
      body: JSON.stringify({ map: state.doc }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      state.markSaved();
    } else {
      // The API is the authority on what a map may be, so its refusal is shown
      // as it came back rather than restated — a second wording of the same
      // rule is a second rule to keep in step.
      alert(`${t("บันทึกไม่สำเร็จ")} (${r.status})\n${d.problem || d.error || ""}`);
    }
  } catch (e) {
    alert(`${t("บันทึกไม่สำเร็จ")}: ${e}`);
  } finally {
    saving = false;
    paintStatus();
  }
}

async function revert() {
  if (!confirm(t("ลบแผนที่ที่ทำเอง แล้วกลับไปใช้แผนที่สำเร็จรูปของพื้นที่นี้?"))) return;
  const r = await fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}/map`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${authToken()}` },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { alert(`${t("ลบไม่สำเร็จ")} (${r.status}) ${d.error || ""}`); return; }
  const theme = THEMES[d.builtin] ?? classicTheme;
  state.replace(bakeTheme(theme), { keepHistory: false });
  await refreshArt();
}

// ---- boot ---------------------------------------------------------------------

async function boot() {
  // the light/dark choice made in the app, not just the operating system's
  applyColorMode();
  watchSystemColorMode();
  applyLang();
  $("which").textContent = `${t("แก้ไขแผนที่")} · ${WORKSPACE}`;
  $<HTMLAnchorElement>("wall-link").href = `/?w=${encodeURIComponent(WORKSPACE)}`;

  if (!authToken()) {
    block(t("ต้องเข้าสู่ระบบก่อน"), t("เครื่องมือแก้ไขแผนที่ใช้ได้เฉพาะเจ้าของพื้นที่และผู้ดูแล เข้าสู่ระบบที่หน้าหลักก่อนแล้วกลับมาที่ลิงก์นี้อีกครั้ง"));
    return;
  }

  // Which maps exist, and which one this URL is for
  try {
    const lr = await fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}/maps`);
    const ld = await lr.json().catch(() => ({}));
    if (Array.isArray(ld?.maps)) maps = ld.maps.map((m: any) => ({ slug: m.slug, label: String(m.label || m.slug) }));
  } catch { /* a space with no maps yet is the normal first visit */ }

  let doc: MapDoc;
  try {
    const path = MAP_SLUG ? `/map/${encodeURIComponent(MAP_SLUG)}` : "/map";
    const r = await fetch(`${API}/workspaces/${encodeURIComponent(WORKSPACE)}${path}`);
    if (r.status === 404 && MAP_SLUG) {
      block(t("ไม่พบแผนที่นี้"), t('พื้นที่นี้ไม่มีแผนที่ชื่อ "{slug}" — อาจถูกลบไปแล้ว', { slug: MAP_SLUG }));
      return;
    }
    if (r.status === 404) {
      block(t("ไม่พบพื้นที่นี้"), t('ไม่มีพื้นที่ชื่อ "{slug}" — เปิดเครื่องมือนี้จากลิงก์ที่มี ?w=<slug> ของพื้นที่ที่ต้องการแก้', { slug: WORKSPACE }));
      return;
    }
    const d = await r.json();
    // Starting from the stock layout is the normal first move: nobody draws an
    // office from an empty grid, they move the desks in the one they have.
    doc = d?.map ?? bakeTheme(THEMES[d?.builtin] ?? classicTheme);
    openMap = String(d?.slug || doc.id);
  } catch (e) {
    block(t("ติดต่อเซิร์ฟเวอร์ไม่ได้"), String(e));
    return;
  }

  state = new EditorState(doc);
  art = await artFor(doc);

  state.onChange(() => { paintLists(); paintStatus(); void refreshArt(); });

  paintTabs();
  paintTools();
  paintOptions();
  paintLists();
  paintStatus();
  draw();
  wirePointer();

  $("btn-save").addEventListener("click", () => void save());
  $("btn-revert").addEventListener("click", () => void revert());
  $("btn-undo").addEventListener("click", () => state.undo());
  $("btn-redo").addEventListener("click", () => state.redo());
  $("ck-grid").addEventListener("change", draw);
  $("ck-marks").addEventListener("change", draw);
  $("in-zoom").addEventListener("change", (e) => { zoom = Number((e.target as HTMLSelectElement).value); draw(); });
  $("map-name").addEventListener("input", (e) => state.setLabel((e.target as HTMLInputElement).value));

  const resize = () => {
    const cols = Math.max(4, Math.min(200, Number($<HTMLInputElement>("in-cols").value) || state.doc.cols));
    const rows = Math.max(4, Math.min(200, Number($<HTMLInputElement>("in-rows").value) || state.doc.rows));
    if (cols !== state.doc.cols || rows !== state.doc.rows) state.resize(cols, rows);
  };
  $("in-cols").addEventListener("change", resize);
  $("in-rows").addEventListener("change", resize);

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? state.redo() : state.undo(); return; }
    if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); return; }
    // 1-8 pick a tool, in the order they are listed
    const n = Number(e.key);
    if (n >= 1 && n <= TOOLS.length) { tool = TOOLS[n - 1].id; paintTools(); paintOptions(); }
  });

  // Closing with unsaved work loses it, and the map is the only copy — the
  // browser's own prompt is the one people recognise.
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  // expose for verification
  (window as unknown as { editor: unknown }).editor = { get doc() { return state.doc; }, state, save, paint };
}

void boot();
