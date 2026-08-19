import type Phaser from "phaser";

/**
 * Two panes, not one stack of overlays.
 *
 * The rail and the people list are a dock on the left; everything else — the map,
 * the meeting view, a shared screen — lives on a stage that starts where the dock
 * ends. The stylesheet does the dividing with `--dock`; this file only keeps two
 * things honest that CSS cannot:
 *
 *  1. `--dock` has to shrink when the people list is closed, and the list is
 *     opened and closed from several places. Watching its class means none of
 *     those callers has to remember to tell the layout.
 *  2. Phaser only notices its parent changed size when it polls, twice a second.
 *     Left alone, the canvas keeps the old width for up to half a second after
 *     the dock opens — a visible strip of background down one side. The observer
 *     hands it the new size on the frame it changes.
 */
export function splitLayout(game: Phaser.Game) {
  const sidebar = document.getElementById("sidebar");
  const app = document.getElementById("app");
  if (!sidebar || !app) return;

  const readDock = () => document.body.classList.toggle("dock-narrow", sidebar.classList.contains("closed"));
  readDock();
  new MutationObserver(readDock).observe(sidebar, { attributes: true, attributeFilter: ["class"] });

  // Both halves of what Phaser's own poll does, in that order: refresh() rescales
  // to the parent size it last measured, so measuring first is what makes it a
  // new size rather than the old one applied again.
  new ResizeObserver(() => {
    if (game.scale.getParentBounds()) game.scale.refresh();
  }).observe(app);
}
