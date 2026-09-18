import Phaser from "phaser";
import { runAuthFlow } from "./authUI";
import { applyColorMode, watchSystemColorMode } from "./appearance";
import { applyLang } from "./i18n";
import { splitLayout } from "./layout";
import { makePanelsDraggable } from "./dragPanel";

// The head script already painted the right palette; this re-applies it from the
// same source of truth and starts following the OS while the choice is "system".
applyColorMode();
watchSystemColorMode();
// and put the markup in the chosen language before anyone reads it
applyLang();

/**
 * Have the typeface in hand before the first name tag is drawn.
 *
 * Name tags are canvas text baked into a texture once. Canvas does not ask for
 * a webfont the way markup does, and it draws with whatever is available at
 * that instant — so a tag made a moment too early is stuck in the fallback for
 * as long as that player is on screen, while the panel beside it is in Sarabun.
 *
 * Capped, and never a reason not to start: a font that will not arrive is worth
 * mismatched labels, not a map nobody can enter.
 */
function nameTagFont() {
  if (!document.fonts?.load) return Promise.resolve();
  const want = ["8px Sarabun", "600 10px Sarabun"].map((f) =>
    document.fonts.load(f, "ก"));
  return Promise.race([
    Promise.all(want),
    new Promise((go) => setTimeout(go, 1500)),
  ]).catch(() => {});
}

/**
 * Fetch the map, then build the world out of it.
 *
 * The ordering is the point. OfficeScene reads its layout at import time, so it
 * has to be imported *after* the answer is in — hence the dynamic imports here
 * rather than at the top of the file, and hence a function rather than
 * top-level await, which the build target (es2020) predates.
 *
 * Nothing a person can see is waiting on this: the login overlay is plain
 * markup in index.html and is already on screen while it runs.
 */
async function boot() {
  const { loadMap, mapOrigin } = await import("./scenes/mapSource");
  await Promise.all([loadMap(), nameTagFont()]);
  console.log(`[map] ${mapOrigin()}`);
  const { OfficeScene } = await import("./scenes/OfficeScene");

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "app",
    backgroundColor: "#f3e7ca",
    pixelArt: true,
    roundPixels: true,
    scale: {
      // RESIZE, not FIT. FIT keeps a fixed 960x640 buffer and stretches it to the
      // window by whatever factor fits — measured at x0.6484 here, which combined
      // with a fractional camera zoom put one art pixel on 0.843 screen pixels and
      // threw away most of the detail before it reached the screen. RESIZE gives
      // the canvas the window's own size, so that factor is exactly 1 and the
      // camera's (integer) zoom is the only scaling left.
      mode: Phaser.Scale.RESIZE,
      width: "100%",
      height: "100%",
      // Give the drawing buffer one pixel per DEVICE pixel. Without this the buffer
      // is sized in CSS pixels and the browser rescales the finished frame by the
      // display scaling factor — fine at 100% or 200%, but Windows at 125% or 150%
      // would land art pixels between device pixels again. Phaser derives the game
      // size as parent/zoom, so 1/dpr makes the buffer dpr times larger while the
      // canvas still occupies the same CSS space.
      zoom: 1 / (window.devicePixelRatio || 1),
    },
    physics: {
      default: "arcade",
      arcade: { debug: false },
    },
    scene: [OfficeScene],
  });

  // keep the dock and the stage in step with each other
  splitLayout(game);

  // the panels that float over the map can be put wherever they are wanted
  makePanelsDraggable();

  // expose for debugging / verification
  (window as unknown as { game: Phaser.Game }).game = game;

  // login / character select, then start the multiplayer session
  runAuthFlow(({ name, avatar, desk }) => {
    (game.scene.getScene("office") as InstanceType<typeof OfficeScene>).startSession(name, avatar, desk);
  });
}

void boot();
