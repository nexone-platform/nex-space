import Phaser from "phaser";
import { OfficeScene } from "./scenes/OfficeScene";
import { runAuthFlow } from "./authUI";

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "app",
  width: 960,
  height: 640,
  backgroundColor: "#f3e7ca",
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: "arcade",
    arcade: { debug: false },
  },
  scene: [OfficeScene],
});

// expose for debugging / verification
(window as unknown as { game: Phaser.Game }).game = game;

// login / character select, then start the multiplayer session
runAuthFlow(({ name, avatar, desk }) => {
  (game.scene.getScene("office") as OfficeScene).startSession(name, avatar, desk);
});
