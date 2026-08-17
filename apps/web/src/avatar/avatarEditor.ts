// Gather-style "Edit Avatar" modal: gender toggle + category sidebar + item grid
// + material color swatches + live preview. Returns the chosen LpcConfig or null.
import {
  getCatalog, buildFrameCanvas, itemThumb,
  type BodyType, type Category, type LpcConfig,
} from "./avatarCompose";
// `t` is taken by a local in the category loop, so the translator comes in as tr
import { translateDom, t as tr } from "../i18n";

// simple line icons per category (stroke = currentColor, so they invert on the active tab)
const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS: Record<string, string> = {
  skin: svg(`<circle cx="12" cy="8.5" r="4.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>`),
  eyes: svg(`<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.4"/>`),
  hair: svg(`<rect x="5" y="3.5" width="14" height="4.5" rx="1"/><path d="M7 8v12M10 8v12M13 8v12M16 8v12"/>`),
  facial: svg(`<path d="M12 6v4"/><path d="M4 12c2-3 5-1 8-1s6-2 8 1c-2 2.4-5 1.2-8 1.2S6 14.4 4 12z"/>`),
  top: svg(`<path d="M8.5 4l-5 3 1.8 3 2.7-1v11h8V9l2.7 1 1.8-3-5-3a3.6 3.6 0 0 1-7 0z"/>`),
  jacket: svg(`<path d="M9 4L4 7v13h16V7l-5-3-3 2.5L9 4z"/><path d="M12 6.5V20"/>`),
  bottom: svg(`<path d="M6.5 3h11l-1 18h-3.5l-1-11-1 11H7.5L6.5 3z"/>`),
  shoes: svg(`<path d="M3 15V9h3l2.2 4.2L20 17v3H3v-5z"/><path d="M3 17h17"/>`),
  hat: svg(`<path d="M5 15a7 7 0 0 1 14 0z"/><rect x="3.5" y="15" width="17" height="3" rx="1.5"/>`),
  glasses: svg(`<circle cx="7" cy="13" r="3"/><circle cx="17" cy="13" r="3"/><path d="M10 13h4"/><path d="M4.5 11l1.5-1.5M19.5 11L18 9.5"/>`),
  other: svg(`<path d="M12 3l1.8 5.6L19.5 10l-5.7 1.6L12 17l-1.8-5.4L4.5 10l5.7-1.4L12 3z"/>`),
};
const DICE = svg(`<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.1" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.1" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.1" fill="currentColor"/>`);

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
  .ave-overlay{position:fixed;inset:0;background:rgba(20,20,30,.55);display:flex;
    align-items:center;justify-content:center;z-index:9999;font-family:system-ui,sans-serif}
  .ave-modal{width:900px;max-width:96vw;height:660px;max-height:94vh;background:#fff;border-radius:16px;
    box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden}
  .ave-head{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid #eee}
  .ave-head h2{margin:0;font-size:20px;font-weight:700;color:#222}
  .ave-gender{display:flex;gap:6px;margin-left:16px}
  .ave-gender button{border:1px solid #d5d5dd;background:#fff;color:#444;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:14px}
  .ave-gender button.on{background:#2f6bff;color:#fff;border-color:#2f6bff}
  .ave-x{border:0;background:#f2f2f4;width:34px;height:34px;border-radius:8px;font-size:18px;cursor:pointer;color:#555}
  .ave-body{flex:1;display:flex;min-height:0}
  .ave-side{width:180px;border-right:1px solid #eee;padding:12px;overflow-y:auto}
  .ave-tab{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;font-size:15px;color:#333;margin-bottom:2px}
  .ave-tab:hover{background:#f5f5f7}
  .ave-tab.on{background:#2f6bff;color:#fff}
  .ave-tab .ic{width:24px;height:24px;flex:none;display:flex;align-items:center;justify-content:center;color:inherit;opacity:.9}
  .ave-tab .ic svg{width:22px;height:22px}
  .ave-dice{position:absolute;right:12px;bottom:12px;width:40px;height:40px;border-radius:11px;border:1px solid #d5d5dd;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#555;box-shadow:0 2px 8px rgba(0,0,0,.14)}
  .ave-dice:hover{background:#eef3ff;color:#2f6bff;border-color:#2f6bff;transform:rotate(-8deg)}
  .ave-dice svg{width:22px;height:22px}
  .ave-mid{flex:1;padding:16px;overflow:hidden;background:#fafafb;display:flex;flex-direction:column}
  .ave-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;overflow-y:auto;flex:1;align-content:start}
  .ave-cell{position:relative;aspect-ratio:1;background:#ececf0;border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;border:2px solid transparent}
  .ave-cell:hover{background:#e3e3ea}
  .ave-cell.on{border-color:#2f6bff;background:#e7efff}
  .ave-cell img{width:80%;height:80%;image-rendering:pixelated;object-fit:contain}
  .ave-cell.none::after{content:"∅";font-size:26px;color:#aab}
  .ave-swatches{display:flex;flex-wrap:wrap;gap:8px;padding-top:12px;margin-top:10px;border-top:1px solid #eee}
  .ave-sw{width:26px;height:26px;border-radius:50%;cursor:pointer;border:2px solid #fff;box-shadow:0 0 0 1px #ccd}
  .ave-sw.on{box-shadow:0 0 0 2px #2f6bff}
  .ave-prev{width:290px;border-left:1px solid #eee;background:#eef0f7;display:flex;align-items:center;justify-content:center;position:relative}
  .ave-prev canvas{image-rendering:pixelated;width:192px;height:192px;filter:drop-shadow(0 6px 6px rgba(0,0,0,.18))}
  .ave-tag{position:absolute;top:calc(50% - 130px);left:50%;transform:translateX(-50%);background:#1f2330;color:#fff;font-size:13px;padding:5px 12px;border-radius:8px;white-space:nowrap}
  .ave-tag::after{content:"";position:absolute;bottom:-5px;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#1f2330;border-bottom:0}
  .ave-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid #eee}
  .ave-btn{border:0;padding:10px 22px;border-radius:9px;font-size:15px;cursor:pointer;font-weight:600}
  .ave-cancel{background:#ececef;color:#333}
  .ave-done{background:#2f6bff;color:#fff}
  `;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

export async function openAvatarEditor(
  initial?: LpcConfig | null, name = "avatar",
): Promise<LpcConfig | null> {
  injectStyle();
  const cat = await getCatalog();
  const cfg: LpcConfig = {
    bodyType: initial?.bodyType === "female" ? "female" : "male",
    skin: initial?.skin,
    parts: { ...(initial?.parts ?? {}) },
    colors: { ...(initial?.colors ?? {}) },
  };
  const COLOR_ONLY = new Set(["skin", "eyes"]); // tabs with no item grid, just swatches
  const colorField = (k: string): "skin" | "eyes" => (k === "eyes" ? "eyes" : "skin");
  // keep color-only tabs + any category that has items
  const cats = cat.categories.filter((c) => COLOR_ONLY.has(c.key) || c.items.length > 0);
  let active = cats[0];

  // material palette for a category (skin->body, eyes->eye; items use their own material)
  const matOf = (c: Category): string | null =>
    c.material ?? (c.items.find((i) => i.material)?.material ?? null);
  const swatchColor = (ramp: string[]) => ramp[Math.min(ramp.length - 1, Math.floor(ramp.length * 0.62))];

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ave-overlay";
    overlay.innerHTML = `
      <div class="ave-modal">
        <div class="ave-head">
          <div style="display:flex;align-items:center">
            <h2>แก้ไขอวาตาร์</h2>
            <div class="ave-gender">
              <button data-bt="male">ชาย</button><button data-bt="female">หญิง</button>
            </div>
          </div>
          <button class="ave-x">✕</button>
        </div>
        <div class="ave-body">
          <div class="ave-side"></div>
          <div class="ave-mid"><div class="ave-grid"></div><div class="ave-swatches"></div></div>
          <div class="ave-prev"><div class="ave-tag"></div><button class="ave-dice" title="สุ่มอวาตาร์">${DICE}</button></div>
        </div>
        <div class="ave-foot">
          <button class="ave-btn ave-cancel">ยกเลิก</button>
          <button class="ave-btn ave-done">เสร็จสิ้น</button>
        </div>
      </div>`;
    // the markup above is Thai, like index.html's, so the same walker translates
    // it — cheaper and less error-prone than threading t() through a template
    translateDom(overlay);
    document.body.appendChild(overlay);

    const sideEl = overlay.querySelector(".ave-side") as HTMLElement;
    const gridEl = overlay.querySelector(".ave-grid") as HTMLElement;
    const swEl = overlay.querySelector(".ave-swatches") as HTMLElement;
    const prevEl = overlay.querySelector(".ave-prev") as HTMLElement;
    (overlay.querySelector(".ave-tag") as HTMLElement).textContent = name;

    const close = (result: LpcConfig | null) => { overlay.remove(); resolve(result); };

    let prevCanvas: HTMLCanvasElement | null = null;
    const renderPreview = async () => {
      const c = await buildFrameCanvas(cfg, "down", 4);
      if (prevCanvas) prevCanvas.remove();
      prevCanvas = c; prevEl.appendChild(c);
    };

    const syncGender = () => overlay.querySelectorAll<HTMLElement>(".ave-gender button")
      .forEach((b) => b.classList.toggle("on", b.dataset.bt === cfg.bodyType));

    const renderSide = () => {
      sideEl.innerHTML = "";
      for (const c of cats) {
        const t = document.createElement("div");
        t.className = "ave-tab" + (c === active ? " on" : "");
        t.innerHTML = `<span class="ic">${ICONS[c.key] ?? ""}</span><span>${tr(c.label)}</span>`;
        t.onclick = () => { active = c; renderSide(); renderGrid(); renderSwatches(); };
        sideEl.appendChild(t);
      }
    };

    const thumbCache = new Map<string, string>();
    const renderGrid = async () => {
      const c = active;
      gridEl.innerHTML = "";
      if (!c.items.length) return; // color-only tab (skin/eyes): swatches only
      const bt = cfg.bodyType;
      const mkCell = (id: string, none = false) => {
        const el = document.createElement("div");
        el.className = "ave-cell" + (none ? " none" : "") + ((cfg.parts[c.key] ?? "") === id ? " on" : "");
        el.onclick = () => {
          if (id) cfg.parts[c.key] = id; else delete cfg.parts[c.key];
          gridEl.querySelectorAll(".ave-cell").forEach((x) => x.classList.remove("on"));
          el.classList.add("on");
          renderPreview();
        };
        gridEl.appendChild(el);
        return el;
      };
      mkCell("", true);
      for (const item of c.items) {
        if (!item.bodyTypes.includes(bt)) continue; // hide items with no sheet for this body
        const el = mkCell(item.id);
        const img = document.createElement("img");
        el.appendChild(img);
        const key = bt + "/" + c.key + "/" + item.id;
        const cached = thumbCache.get(key);
        if (cached) img.src = cached;
        else itemThumb(cfg, c.key, item, undefined, 3).then((url) => { thumbCache.set(key, url); img.src = url; });
      }
    };

    const renderSwatches = () => {
      swEl.innerHTML = "";
      const mat = matOf(active);
      const pal = mat ? cat.materials[mat] : null;
      if (!pal) return;
      const isCO = COLOR_ONLY.has(active.key);
      const current = isCO ? (cfg[colorField(active.key)] ?? pal.base) : (cfg.colors[active.key] ?? pal.base);
      for (const [nameC, ramp] of Object.entries(pal.colors)) {
        const sw = document.createElement("div");
        sw.className = "ave-sw" + (nameC === current ? " on" : "");
        sw.style.background = swatchColor(ramp);
        sw.title = nameC;
        sw.onclick = () => {
          if (isCO) cfg[colorField(active.key)] = nameC;
          else cfg.colors[active.key] = nameC;
          swEl.querySelectorAll(".ave-sw").forEach((x) => x.classList.remove("on"));
          sw.classList.add("on");
          renderPreview();
        };
        swEl.appendChild(sw);
      }
    };

    // dice: randomize body/skin/eyes + a plausible outfit
    const randOf = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
    const CHANCE: Record<string, number> = { hair: 0.92, facial: 0.25, top: 1, bottom: 1, shoes: 0.9, hat: 0.3, glasses: 0.25, other: 0.15 };
    const randomize = () => {
      cfg.bodyType = Math.random() < 0.5 ? "male" : "female";
      cfg.skin = randOf(Object.keys(cat.materials.body.colors));
      cfg.eyes = randOf(Object.keys(cat.materials.eye.colors));
      cfg.parts = {}; cfg.colors = {};
      for (const c of cats) {
        if (COLOR_ONLY.has(c.key) || !c.items.length) continue;
        if (Math.random() > (CHANCE[c.key] ?? 0.5)) continue;
        const avail = c.items.filter((i) => i.bodyTypes.includes(cfg.bodyType));
        if (!avail.length) continue;
        cfg.parts[c.key] = randOf(avail).id;
        const mat = matOf(c);
        if (mat && cat.materials[mat]) cfg.colors[c.key] = randOf(Object.keys(cat.materials[mat].colors));
      }
      thumbCache.clear(); syncGender(); renderSide(); renderGrid(); renderSwatches(); renderPreview();
    };
    (overlay.querySelector(".ave-dice") as HTMLElement).onclick = randomize;

    overlay.querySelectorAll<HTMLElement>(".ave-gender button").forEach((b) => (b.onclick = () => {
      cfg.bodyType = (b.dataset.bt as BodyType) || "male";
      thumbCache.clear(); syncGender(); renderGrid(); renderPreview();
    }));
    (overlay.querySelector(".ave-x") as HTMLElement).onclick = () => close(null);
    (overlay.querySelector(".ave-cancel") as HTMLElement).onclick = () => close(null);
    (overlay.querySelector(".ave-done") as HTMLElement).onclick = () => close(cfg);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });

    syncGender(); renderSide(); renderGrid(); renderSwatches(); renderPreview();
  });
}
