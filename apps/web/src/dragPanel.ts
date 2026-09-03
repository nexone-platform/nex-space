import { t } from "./i18n";

/**
 * Let a floating panel be moved to wherever its owner wants it.
 *
 * These panels are pinned to the top of the window, and the top of the window
 * is crowded: the nav bar, the conversation tiles, the meeting panel and the
 * nudge card all want the same strip, and which of them is in the way depends
 * on what the person happens to be doing. Rather than keep re-deciding that for
 * them, the two that cover the map can be dragged aside.
 *
 * A moved panel stays moved, per browser, because a panel that returns to the
 * middle of the map on every reload has not really been moved at all. Double
 * click puts it back — losing a panel off the edge of a smaller screen and
 * having no way to call it home would be a worse problem than the one this
 * solves, and the clamp alone cannot promise that.
 */

const KEY = (name: string) => `nexspace-panel-${name}`;

type Spot = { left: number; top: number };

/** keep the whole panel on screen, whatever it was asked for */
function clamped(panel: HTMLElement, spot: Spot): Spot {
  const box = panel.getBoundingClientRect();
  const room = (span: number, of: number) => Math.max(0, of - span);
  return {
    left: Math.min(Math.max(0, spot.left), room(box.width, window.innerWidth)),
    top: Math.min(Math.max(0, spot.top), room(box.height, window.innerHeight)),
  };
}

/**
 * Explicit coordinates, and no transform.
 *
 * Both of these panels are centred with a translate, which is measured from
 * wherever the layout put them — so left alone it would go on shifting the
 * panel after it had been placed by hand.
 */
function place(panel: HTMLElement, spot: Spot) {
  const at = clamped(panel, spot);
  panel.style.left = `${at.left}px`;
  panel.style.top = `${at.top}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  panel.style.transform = "none";
}

function forget(panel: HTMLElement, name: string) {
  for (const prop of ["left", "top", "right", "bottom", "transform"]) {
    panel.style.removeProperty(prop);
  }
  try { localStorage.removeItem(KEY(name)); } catch { /* private window */ }
}

export function makeDraggable(panel: HTMLElement, handle: HTMLElement, name: string) {
  let spot: Spot | null = null;
  try {
    const saved = localStorage.getItem(KEY(name));
    if (saved) spot = JSON.parse(saved) as Spot;
  } catch { /* nothing saved, or unreadable */ }

  handle.style.cursor = "grab";
  handle.title = t("ลากเพื่อย้าย · ดับเบิลคลิกเพื่อคืนที่เดิม");

  // A hidden panel measures zero, so a saved position cannot be applied until
  // it is on screen — which for both of these is long after startup.
  if (spot) {
    const watch = new ResizeObserver(() => {
      if (!panel.getBoundingClientRect().width) return;
      watch.disconnect();
      place(panel, spot!);
    });
    watch.observe(panel);
  }
  window.addEventListener("resize", () => { if (spot) place(panel, spot); });

  let draggedAt = 0;
  // A drag that ends over a button must not also press it.
  panel.addEventListener("click", (e) => {
    if (Date.now() - draggedAt < 250) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  handle.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    spot = null;
    forget(panel, name);
  });

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // The controls inside keep doing what they do; only the panel's own
    // background is a place to pick it up by.
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [contenteditable]")) return;

    const box = panel.getBoundingClientRect();
    const grip = { x: e.clientX - box.left, y: e.clientY - box.top };
    let moving = false;

    const move = (ev: PointerEvent) => {
      // A few pixels of slack, so a click that trembles is still a click.
      if (!moving && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      if (!moving) { moving = true; handle.style.cursor = "grabbing"; document.body.style.userSelect = "none"; }
      spot = { left: ev.clientX - grip.x, top: ev.clientY - grip.y };
      place(panel, spot);
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      handle.style.cursor = "grab";
      document.body.style.removeProperty("user-select");
      if (!moving) return;
      draggedAt = Date.now();
      // Save where it ended up on screen, not where the pointer was: the clamp
      // may have had something to say about it.
      const box2 = panel.getBoundingClientRect();
      spot = { left: box2.left, top: box2.top };
      try { localStorage.setItem(KEY(name), JSON.stringify(spot)); } catch { /* private window */ }
    };

    try { handle.setPointerCapture(e.pointerId); } catch { /* older browser */ }
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
    e.preventDefault();
  });
}

/** the two panels that float over the map and get in each other's way */
export function makePanelsDraggable() {
  const convo = document.getElementById("convo");
  const convoGrip = document.getElementById("convo-tiles");
  if (convo && convoGrip) makeDraggable(convo, convoGrip, "convo");

  const meet = document.getElementById("meet-panel");
  if (meet) makeDraggable(meet, meet, "meet");
}
