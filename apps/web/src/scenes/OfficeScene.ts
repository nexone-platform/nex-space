import Phaser from "phaser";
import { Client, getStateCallbacks, type Room } from "colyseus.js";
import { wallTileIndex } from "../wallAutotile";
import { WebRTCManager } from "../net/webrtc";
import { LiveKitManager } from "../net/livekit";
import type { MediaManager } from "../net/media";
import { buildWalkCanvas, buildSitCanvas, SIT_COLS, SIT_SEATED_COL, decodeAvatar, encodeAvatar, isLpc, avatarKey, defaultDressedConfig, LPC_ROW } from "../avatar/avatarCompose";
import { openAvatarEditor } from "../avatar/avatarEditor";

const LPC_COLS = 9; // LPC walk sheet: 9 frames per direction row
const LPC_SCALE = 0.5;    // 64px LPC frames render large vs 32px furniture -> scale down
const PRESET_SCALE = 0.62; // shrink the older whole-avatar presets too (independent of LPC)
// chair facing (CHAIR_DIRS) -> avatar facing (DIRS8) for sitting
const CHAIR_TO_FACING: Record<string, string> = {
  south: "down", "south-east": "down-right", east: "right", "north-east": "up-right",
  north: "up", "north-west": "up-left", west: "left", "south-west": "down-left",
};

// In production the app is served by nginx, which reverse-proxies the game server
// and API on the same origin (/colyseus, /livekit, /me). Use same-origin URLs there
// so it works over any host/port/protocol; fall back to local ports only in dev.
const env = (import.meta as any).env || {};
const isDev = !!env.DEV;
const wsProto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
const sameHost = typeof window !== "undefined" ? window.location.host : "";
const SERVER_URL = (env.VITE_GAME_SERVER_URL as string) || (isDev ? "ws://localhost:2567" : `${wsProto}//${sameHost}/colyseus`);
const HTTP_URL = (env.VITE_GAME_SERVER_HTTP as string) || (isDev ? "http://localhost:2567" : "");
const AUTH_API = (env.VITE_API_URL as string) || (isDev ? "http://localhost:3001" : "");

// selectable avatars: spritesheet key + frame size (walk sheet 8 rows x 6 frames)
// frame size + frames-per-direction (nf) MUST match the generated walk sheets
const AVATARS: Record<string, { tex: string; file: string; fw: number; fh: number; nf: number }> = {
  "1": { tex: "avatar1", file: "player-walk.png", fw: 28, fh: 50, nf: 6 },
  "2": { tex: "avatar2", file: "player-walk-2.png", fw: 26, fh: 50, nf: 6 },
  "3": { tex: "avatar3", file: "player-walk-3.png", fw: 27, fh: 49, nf: 8 },
  "4": { tex: "avatar4", file: "player-walk-4.png", fw: 29, fh: 73, nf: 8 },
  "5": { tex: "avatar5", file: "player-walk-5.png", fw: 34, fh: 49, nf: 8 },
  "6": { tex: "avatar6", file: "player-walk-6.png", fw: 28, fh: 48, nf: 8 },
  "7": { tex: "avatar7", file: "player-walk-7.png", fw: 27, fh: 50, nf: 8 },
};
const DIRS8 = ["down", "up", "left", "right", "down-right", "down-left", "up-right", "up-left"];
// idle frame = first frame of a direction's row (row index * frames-per-direction)
const idleFrame = (avatar: string, dir: string) =>
  DIRS8.indexOf(dir) * (AVATARS[avatar]?.nf ?? 6);

interface Interactive {
  type: "whiteboard" | "screen" | "portal" | "embed";
  x: number; y: number; label: string; icon: string;
  url?: string; target?: { x: number; y: number };
}

const INTERACTIVES: Interactive[] = [
  { type: "whiteboard", x: 7, y: 1, label: "เปิดไวท์บอร์ด Excalidraw", icon: "", url: "https://excalidraw.com" },
  { type: "screen", x: 16, y: 0, label: "แชร์จอขึ้นจอนำเสนอ", icon: "" },
  { type: "portal", x: 2, y: 7, label: "เทเลพอร์ตไปโซนขวา", icon: "✨", target: { x: 17, y: 11 } },
  { type: "portal", x: 17, y: 11, label: "เทเลพอร์ตกลับ", icon: "✨", target: { x: 2, y: 7 } },
];

interface Remote {
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Container; // rounded name tag (see makeNameTag)
  name: string;                        // display name (the tag is a container, so keep it here)
  tx: number;
  ty: number;
  dir: string;
  moving: boolean;
  avatar: string;
  sitting?: boolean;
  ring?: Phaser.GameObjects.Arc;
  deskId?: string;
}

// ===== Office size: SMALL (S) — 1-10 people — compact 20x15 =====
const TILE = 32;
const COLS = 32;
const ROWS = 25;
const SPAWN = { x: 15, y: 18 }; // entrance hall, just inside the front door
// building footprint (wall rectangle); interior walkable is x5..26, y4..19
const BUILD = { x0: 4, y0: 3, x1: 27, y1: 20 };
const ZOOM_MIN = 1.3, ZOOM_MAX = 4, ZOOM_DEFAULT = 2.2;

// furniture: [key, tileX, tileY, solid?]  (map is 20x15)
// new directional chair styles from assets/office_chair
const CHAIR_STYLES = ["chair-1", "chair-2", "chair-3", "chair-4", "chair-5", "chair-6", "chair-7", "chair-8"];
const CHAIR_DIRS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];

const FURNITURE: [string, number, number, boolean][] = [
  // --- lounge (top-left, pink carpet) ---
  ["sofa-yellow", 6, 5, false], ["sofa-pink", 9, 5, false],
  ["side-table", 7.5, 6, false], ["floor-lamp", 11, 5, false],
  ["plant-large", 5, 8, true], ["rug-round", 8, 7, false],

  // --- private office (top-center, blue carpet) ---
  ["bookshelf", 13, 4, true], ["whiteboard", 15, 4, true],
  ["desk", 14, 6, true], ["chair-4-north", 14, 7, false],
  ["desk-monitor", 17, 6, true], ["chair-5-north", 17, 7, false],
  ["plant", 18, 4, true],

  // --- meeting room (top-right, mint carpet) ---
  ["conference-table", 23, 6, true],
  ["chair-1-south", 22, 5, false], ["chair-2-south", 24, 5, false],
  ["chair-1-north", 22, 8, false], ["chair-2-north", 24, 8, false],
  ["chair-4-east", 21, 6, false], ["chair-6-west", 25, 6, false],
  ["plant-small", 20, 4, false], ["plant-small", 26, 4, false],

  // --- main hall (marble): reception + open desks ---
  ["reception-desk", 15, 16, true], ["plant", 17, 16, true],
  ["desk", 8, 12, true], ["chair-6-south", 8, 13, false],
  ["desk-monitor", 11, 12, true], ["chair-7-south", 11, 13, false],
  ["desk", 20, 12, true], ["chair-3-south", 20, 13, false],
  ["desk-monitor", 23, 12, true], ["chair-4-south", 23, 13, false],
  ["rug", 15, 13, false],
  ["plant-large", 11, 17, true], ["plant-large", 20, 17, true],
  ["plant", 5, 11, false], ["plant", 26, 11, false],

  // --- pantry (bottom-left, plank floor) ---
  ["kitchen-counter", 6, 15, true], ["coffee-machine", 8, 15, true],
  ["beverage-cooler", 9, 15, true],
  ["lounge-sofa", 6, 18, false], ["lounge-coffee-table", 7.5, 18, false], ["bean-bag", 9, 18, false],

  // --- game / chill room (bottom-right, dark wood) — symmetric lounge around x=23.5 ---
  ["gaming-tv", 23.5, 15, true],
  ["arcade", 21.5, 16, true], ["plant-large", 25.5, 16, true],
  ["lounge-coffee-table", 23.5, 17, false],
  ["sofa-teal", 23.5, 18, false],
  ["armchair", 21.5, 18.3, false], ["armchair", 25.5, 18.3, false],
];

// outdoor props on the grass ring: [key, tileX, tileY, solid?]  (loaded from /assets/outdoor)
const OUTDOOR: [string, number, number, boolean][] = [
  ["fountain", 15, 22, true],                                   // front-yard centerpiece
  // trees around the perimeter (left / right / top / bottom-corners)
  ["tree", 1, 5, true], ["tree-oval", 2, 11, true], ["pine", 1, 17, true],
  ["tree-oval", 30, 5, true], ["tree", 29, 11, true], ["pine", 30, 17, true],
  ["pine", 6, 1, true], ["tree", 11, 1, true], ["tree-oval", 16, 1, true], ["pine", 21, 1, true], ["tree", 25, 1, true],
  ["tree-oval", 2, 22, true], ["tree", 29, 22, true],
  // shrubs hugging the building base
  ["shrub", 5, 2, false], ["shrub", 9, 2, false], ["shrub", 22, 2, false], ["shrub", 26, 2, false],
  ["shrub", 5, 21, false], ["shrub", 26, 21, false],
  // entrance furnishings — kept clear of the fountain (which spans x13.5..17.5)
  ["bench", 7, 23, false], ["bench", 24, 23, false], ["bench-sofa", 2, 15, false],
  ["planter-round", 13, 21, false], ["planter-round", 18, 21, false],
  ["lamp-post", 5, 22, true], ["lamp-post", 26, 22, true],
  ["sign-welcome", 10, 22, false], ["sign-team", 21, 22, false], ["sign-dir", 3, 9, false],
];

// flat grass decals (flowers / clover / bushes) scattered on the lawn, drawn just above the floor
const DECALS: [string, number, number][] = [
  ["flower-yellow", 1, 3], ["clover", 3, 8], ["flower-mixed", 1, 14], ["flower-pink", 3, 19],
  ["clover", 28, 4], ["flower-yellow", 30, 9], ["flower-mixed", 28, 15], ["flower-pink", 30, 19],
  ["clover", 8, 1], ["flower-yellow", 14, 2], ["flower-pink", 19, 2], ["flower-mixed", 24, 1],
  ["bush-blob", 4, 1], ["bush-blob", 27, 1], ["rocks", 5, 23], ["rocks", 26, 23],
  ["flower-yellow", 9, 24], ["flower-yellow", 22, 24], ["clover", 11, 24], ["clover", 20, 24],
];

// decor overlays drawn ON TOP of walls (windows / art / signage). [key, tileX, tileY]
const DECOR: [string, number, number][] = [
  // arched windows along the front (top) wall
  ["arched-window", 8, 3], ["arched-window", 15, 3], ["arched-window", 22, 3],
  // windows on the side walls
  ["window", 4, 8], ["window", 27, 8],
  // meeting-room glass front (along the y=10 partition, x20..26)
  ["glass-panel", 21, 10], ["glass-panel", 25, 10],
  // wall art & signage mounted on interior walls
  ["art-landscape", 12, 3], ["art-poster", 6, 10], ["wall-shelf", 10, 10],
  ["wall-clock", 14, 10], ["corkboard", 17, 10], ["neon-sign", 24, 3],
];

// claimable "home desks": id + desk tile + seat tile (chair sits just below the desk)
const DESKS: { id: string; x: number; y: number; sx: number; sy: number }[] = [
  { id: "office-1", x: 14, y: 6, sx: 14, sy: 7 },
  { id: "office-2", x: 17, y: 6, sx: 17, sy: 7 },
  { id: "hall-1", x: 8, y: 12, sx: 8, sy: 13 },
  { id: "hall-2", x: 11, y: 12, sx: 11, sy: 13 },
  { id: "hall-3", x: 20, y: 12, sx: 20, sy: 13 },
  { id: "hall-4", x: 23, y: 12, sx: 23, sy: 13 },
];

export class OfficeScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private myLabel?: Phaser.GameObjects.Container; // my own name tag above my head
  private myDesk = "";                          // id of my claimed home desk ("" = none)
  private deskClaimAt = 0;                      // scene time of my last claim (grace window for state reconcile)
  private toastTimer?: number;                  // pending hide timer for the DOM toast
  private deskPlates = new Map<string, Phaser.GameObjects.Container>(); // deskId -> owner nameplate
  private sitting = false;
  private satChair?: Phaser.GameObjects.Image;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private facing = "down"; // one of 8: down/up/left/right/down-right/down-left/up-right/up-left
  private rotatables: Phaser.GameObjects.Image[] = [];
  private chairStyles = new Map<Phaser.GameObjects.Image, string>(); // image -> chair style prefix (e.g. "chair-2")
  private selected?: Phaser.GameObjects.Image;
  private selRing!: Phaser.GameObjects.Arc;
  private room?: Room;
  private mySessionId = "";
  private remotes = new Map<string, Remote>();
  private lastSent = 0;
  private lastState = { x: 0, y: 0, dir: "", moving: false };
  private readonly NEAR = 5 * TILE; // proximity radius (must match server)
  private bubbles = new Map<string, Phaser.GameObjects.Text>();
  private localRing!: Phaser.GameObjects.Arc;
  private webrtc?: MediaManager;
  private myName = "Guest";
  private myAvatar = "1";
  private created = false;
  private pendingStart = false;
  private nearInteractive?: Interactive;
  private sceneScreens = new Map<string, Phaser.GameObjects.Video>(); // screenId -> video
  private screenPresenter = new Map<string, string>();                // screenId -> sessionId presenting
  private myScreenId?: string;                                         // screen I'm presenting on
  private lpcReady = new Set<string>();                               // LPC texKeys with texture+anims registered
  private lpcBuilding = new Map<string, Promise<string | null>>();    // in-flight LPC texture builds
  private lpcSitReady = new Set<string>();                            // LPC sit texKeys registered
  private lpcSitBuilding = new Map<string, Promise<string | null>>(); // in-flight LPC sit builds
  private activeScreenStream: MediaStream | null = null;
  private activePresenterName: string = "";

  constructor() {
    super("office");
  }

  preload() {
    this.load.maxParallelDownloads = 100; // load all assets at once (robust when tab/pane is backgrounded)
    this.load.image("floors", "/assets/tilesets/floors-atlas.png"); // 0=cream 1=wood 2=gray
    this.load.image("walls", "/assets/tilesets/walls-teal.png");
    for (const id of Object.keys(AVATARS)) {
      const a = AVATARS[id];
      this.load.spritesheet(a.tex, `/assets/${a.file}`, { frameWidth: a.fw, frameHeight: a.fh });
    }
    const items = new Set(FURNITURE.map((f) => f[0]));
    items.forEach((k) => this.load.image(k, `/assets/furniture/${k}.png`));
    new Set(DECOR.map((d) => d[0])).forEach((k) => this.load.image(k, `/assets/decor/${k}.png`));
    new Set(OUTDOOR.map((o) => o[0])).forEach((k) => this.load.image(k, `/assets/outdoor/${k}.png`));
    new Set(DECALS.map((d) => d[0])).forEach((k) => this.load.image(k, `/assets/outdoor/${k}.png`));
    // load all directional chair images for rotation
    for (const style of CHAIR_STYLES) {
      for (const dir of CHAIR_DIRS) {
        const key = `${style}-${dir}`;
        if (!items.has(key)) this.load.image(key, `/assets/furniture/${key}.png`);
      }
    }
  }

  create() {
    const worldW = COLS * TILE;
    const worldH = ROWS * TILE;

    // --- floor zones (atlas index): 0 marble, 1 grass, 2 plank, 3 pink, 4 mint,
    //     5 blue, 6 dark-wood, 7 path, 8 brick ---
    const inBuild = (x: number, y: number) => x >= 5 && x <= 26 && y >= 4 && y <= 19;
    const floorAt = (x: number, y: number): number => {
      if (x >= 13 && x <= 18 && y >= 21 && y <= 23) return 8;  // symmetric stone plaza under the fountain
      if (!inBuild(x, y)) return 1;                            // grass (outdoor)
      if (x >= 5 && x <= 11 && y >= 4 && y <= 9) return 3;     // lounge (pink)
      if (x >= 13 && x <= 18 && y >= 4 && y <= 9) return 5;    // private office (blue)
      if (x >= 20 && x <= 26 && y >= 4 && y <= 9) return 4;    // meeting (mint)
      if (x >= 5 && x <= 10 && y >= 15 && y <= 19) return 2;   // pantry (plank)
      if (x >= 21 && x <= 26 && y >= 15 && y <= 19) return 6;  // game room (dark wood)
      return 0;                                                // marble hall
    };
    const floorData: number[][] = [];
    for (let y = 0; y < ROWS; y++) {
      const row: number[] = [];
      for (let x = 0; x < COLS; x++) row.push(floorAt(x, y));
      floorData.push(row);
    }
    const floorMap = this.make.tilemap({ data: floorData, tileWidth: TILE, tileHeight: TILE });
    floorMap.createLayer(0, floorMap.addTilesetImage("floors")!, 0, 0)!.setDepth(-1000);

    // --- walls: building perimeter + interior room partitions ---
    const walls = new Set<string>();
    const addWall = (x: number, y: number) => walls.add(`${x},${y}`);
    // building perimeter rectangle
    for (let x = BUILD.x0; x <= BUILD.x1; x++) { addWall(x, BUILD.y0); addWall(x, BUILD.y1); }
    for (let y = BUILD.y0; y <= BUILD.y1; y++) { addWall(BUILD.x0, y); addWall(BUILD.x1, y); }
    // horizontal partition splitting the top rooms from the hall
    for (let x = 5; x <= 26; x++) addWall(x, 10);
    // vertical partitions between the three top rooms
    for (let y = 4; y <= 9; y++) { addWall(12, y); addWall(19, y); }
    // doors
    walls.delete("15,20"); walls.delete("16,20");                  // front entrance
    walls.delete("8,10"); walls.delete("16,10"); walls.delete("23,10"); // lounge / office / meeting
    const isWall = (x: number, y: number) => walls.has(`${x},${y}`);

    const data: number[][] = [];
    for (let y = 0; y < ROWS; y++) {
      const row: number[] = [];
      for (let x = 0; x < COLS; x++) row.push(wallTileIndex(isWall, x, y));
      data.push(row);
    }
    const map = this.make.tilemap({ data, tileWidth: TILE, tileHeight: TILE });
    const wallLayer = map.createLayer(0, map.addTilesetImage("walls")!, 0, 0)!;
    wallLayer.setCollisionByExclusion([-1]);
    wallLayer.setDepth(50);

    // --- furniture ---
    const solids = this.physics.add.staticGroup();
    for (const [k, tx, ty, solid] of FURNITURE) {
      const px = tx * TILE + TILE / 2;
      const py = ty * TILE + TILE / 2;
      if (solid) {
        const img = solids.create(px, py, k) as Phaser.Physics.Arcade.Sprite;
        img.setDepth(py);
        img.refreshBody();
        const desk = DESKS.find((d) => d.x === tx && d.y === ty);
        if (desk) {
          img.setInteractive({ useHandCursor: true });
          img.on("pointerdown", () => this.claimDesk(desk.id));
        }
      } else {
        const spr = this.add.image(px, py, k).setDepth(k.startsWith("rug") ? -900 : py);
        if (k.includes("chair") || k === "stool" || k.includes("sofa") || k.includes("bean-bag")) {
          spr.setInteractive({ useHandCursor: true });
          this.rotatables.push(spr);
          // extract chair style prefix (e.g. "chair-2" from "chair-2-south")
          const m = k.match(/^(chair-\d+)/);
          if (m) this.chairStyles.set(spr, m[1]);
        }
      }
    }

    // --- flat grass decals (flowers / clover) drawn just above the floor ---
    for (const [k, tx, ty] of DECALS) {
      this.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, k).setDepth(-800);
    }

    // --- outdoor props (trees / fountain / benches / signs) on the grass ring ---
    const outdoorScale = (k: string) => (/planter/.test(k) ? 0.6 : 1); // shrink bulky planters
    for (const [k, tx, ty, solid] of OUTDOOR) {
      const px = tx * TILE + TILE / 2;
      const py = ty * TILE + TILE / 2;
      const s = outdoorScale(k);
      if (solid) {
        const img = solids.create(px, py, k) as Phaser.Physics.Arcade.Sprite;
        img.setScale(s).setDepth(py);
        img.refreshBody();
      } else {
        this.add.image(px, py, k).setScale(s).setDepth(py);
      }
    }

    // --- decor overlays (windows / art / signage) drawn on top of walls ---
    // scale down so wall decor sits proportionally on the wall instead of filling a whole tile
    const decorScale = (k: string) => (/window|glass/.test(k) ? 0.85 : 0.6);
    for (const [k, tx, ty] of DECOR) {
      this.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, k)
        .setScale(decorScale(k))
        .setDepth(55);
    }

    // walk animations for each avatar (8 dirs x 6 frames), keyed "<avatarId>-<dir>"
    for (const id of Object.keys(AVATARS)) {
      const nf = AVATARS[id].nf;
      DIRS8.forEach((d, row) =>
        this.anims.create({
          key: `${id}-${d}`,
          frames: this.anims.generateFrameNumbers(AVATARS[id].tex, { start: row * nf, end: row * nf + nf - 1 }),
          frameRate: 10,
          repeat: -1,
        }));
    }

    // --- player (avatar/name applied on startSession after login) ---
    this.player = this.physics.add.sprite(SPAWN.x * TILE + TILE / 2, SPAWN.y * TILE + TILE / 2, AVATARS[this.myAvatar].tex, 0);
    this.player.setCollideWorldBounds(true);
    this.applyAvatarBody();
    this.player.setDepth(this.player.y);
    this.physics.add.collider(this.player, wallLayer);
    this.physics.add.collider(this.player, solids);

    // my own name above my head (same tag style as remote players)
    this.refreshMyLabel();

    // --- camera ---
    this.physics.world.setBounds(0, 0, worldW, worldH);
    this.cameras.main.setBounds(0, 0, worldW, worldH);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.cameras.main.setZoom(ZOOM_DEFAULT);

    // --- input: movement ---
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys("W,A,S,D") as Record<string, Phaser.Input.Keyboard.Key>;

    // --- input: rotate chairs by swapping directional sprites (click to select, drag/wheel = change direction) ---
    this.selRing = this.add.circle(0, 0, 17).setStrokeStyle(2, 0x2bb3a3).setFillStyle(0x2bb3a3, 0.08)
      .setVisible(false).setDepth(99999);

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      const hit = this.input.hitTestPointer(p).find((o) => this.rotatables.includes(o as Phaser.GameObjects.Image));
      if (hit) this.selectChair(hit as Phaser.GameObjects.Image);
      else this.deselectChair();
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (this.selected && p.isDown) {
        const ang = Phaser.Math.Angle.Between(this.selected.x, this.selected.y, p.worldX, p.worldY);
        this.rotateChairToAngle(this.selected, ang);
      }
    });
    this.input.on("wheel", (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      if (this.selected) this.rotateChairStep(this.selected, Math.sign(dy));
      else this.zoomBy(dy > 0 ? 1 / 1.12 : 1.12); // scroll = zoom the camera
    });
    this.input.keyboard!.on("keydown-ESC", () => this.deselectChair());
    this.input.keyboard!.on("keydown-Q", () => { if (this.selected) this.rotateChairStep(this.selected, -1); });
    this.input.keyboard!.on("keydown-E", () => {
      if (document.activeElement instanceof HTMLInputElement) return; // typing
      if (this.selected) { this.rotateChairStep(this.selected, 1); return; } // rotate chair
      if (this.nearInteractive) void this.activateInteractive(this.nearInteractive);
    });
    this.input.keyboard!.on("keydown-F", () => {
      if (document.activeElement instanceof HTMLInputElement) return; // typing
      this.toggleSit();
    });
    this.input.keyboard!.on("keydown-M", () => this.setZoom(ZOOM_MIN)); // zoom out fully
    this.setupInputFocusGuard();
    this.setupZoomControls();
    this.setupInteractives();

    // --- multiplayer + proximity chat ---
    this.localRing = this.add.circle(0, 0, 15).setStrokeStyle(2, 0x2bb3a3, 0.9)
      .setDepth(1).setVisible(false);
    this.setupChat();
    this.setupSidebar();
    this.setupTopHeader();
    this.created = true;
    if (this.pendingStart) void this.connectMultiplayer(); // login already completed
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => { this.webrtc?.dispose(); this.room?.leave(); });
  }

  /** called by the auth flow once the user has logged in / picked a character */
  startSession(name: string, avatar: string, desk = "") {
    this.myName = name || "Guest";
    this.myAvatar = isLpc(avatar) || AVATARS[avatar] ? avatar : "1";
    this.myDesk = desk || "";
    if (this.player) this.refreshMyLabel();
    if (this.player) void this.applyAvatarBody();
    if (this.created) void this.connectMultiplayer();
    else this.pendingStart = true;
  }

  private async applyAvatarBody() {
    if (isLpc(this.myAvatar)) {
      const key = await this.ensureLpc(this.myAvatar);
      if (key && this.player) {
        this.player.setTexture(key, this.idleFrameFor(this.myAvatar, this.facing));
        this.player.setScale(LPC_SCALE);
        this.player.body!.setSize(16, 9).setOffset((64 - 16) / 2, 64 - 13); // hitbox at feet
      }
      return;
    }
    const a = AVATARS[this.myAvatar] ?? AVATARS["1"];
    this.player.setScale(PRESET_SCALE);
    this.player.setTexture(a.tex, 0);
    this.player.body!.setSize(12, 8).setOffset((a.fw - 12) / 2, a.fh - 10); // hitbox at feet
  }

  // ---- LPC (custom avatar) helpers ----------------------------------------
  /** build + register the spritesheet texture and 8-dir anims for an LPC config (idempotent) */
  private ensureLpc(avatar: string): Promise<string | null> {
    const cfg = decodeAvatar(avatar);
    if (!cfg) return Promise.resolve(null);
    const key = avatarKey(avatar);
    if (this.lpcReady.has(key)) return Promise.resolve(key);
    let p = this.lpcBuilding.get(key);
    if (!p) {
      p = (async () => {
        const canvas = await buildWalkCanvas(cfg);
        if (!this.textures.exists(key)) {
          const tex = this.textures.addCanvas(key, canvas)!;
          let i = 0; // slice the 9x4 grid into numbered frames 0..35
          for (let r = 0; r < 4; r++)
            for (let c = 0; c < LPC_COLS; c++) tex.add(i++, 0, c * 64, r * 64, 64, 64);
        }
        for (const d of DIRS8) {
          const ak = `${key}-${d}`;
          if (this.anims.exists(ak)) continue;
          const row = LPC_ROW[d] ?? 2;
          this.anims.create({
            key: ak,
            frames: this.anims.generateFrameNumbers(key, { start: row * LPC_COLS, end: row * LPC_COLS + LPC_COLS - 1 }),
            frameRate: 10, repeat: -1,
          });
        }
        this.lpcReady.add(key);
        return key;
      })();
      this.lpcBuilding.set(key, p);
    }
    return p;
  }

  /** build + register the LPC sit spritesheet (3 cols x 4 dir rows), idempotent */
  private ensureLpcSit(avatar: string): Promise<string | null> {
    const cfg = decodeAvatar(avatar);
    if (!cfg) return Promise.resolve(null);
    const key = avatarKey(avatar) + "-sit";
    if (this.lpcSitReady.has(key)) return Promise.resolve(key);
    let p = this.lpcSitBuilding.get(key);
    if (!p) {
      p = (async () => {
        const canvas = await buildSitCanvas(cfg);
        if (!this.textures.exists(key)) {
          const tex = this.textures.addCanvas(key, canvas)!;
          let i = 0;
          for (let r = 0; r < 4; r++)
            for (let c = 0; c < SIT_COLS; c++) tex.add(i++, 0, c * 64, r * 64, 64, 64);
        }
        this.lpcSitReady.add(key);
        return key;
      })();
      this.lpcSitBuilding.set(key, p);
    }
    return p;
  }
  private sitFrameFor(dir: string): number { return (LPC_ROW[dir] ?? 2) * SIT_COLS + SIT_SEATED_COL; }
  /** seated depth: facing away (up/north) -> behind the chair so its backrest occludes you; else in front */
  private sitDepth(chairDepth: number, facing: string): number {
    const away = facing.startsWith("up") || facing.startsWith("north");
    return away ? chairDepth - 1 : chairDepth + 1;
  }

  private texKeyFor(avatar: string): string {
    return isLpc(avatar) ? avatarKey(avatar) : (AVATARS[avatar] ?? AVATARS["1"]).tex;
  }
  private animKeyFor(avatar: string, dir: string): string {
    return isLpc(avatar) ? `${avatarKey(avatar)}-${dir}` : `${AVATARS[avatar] ? avatar : "1"}-${dir}`;
  }
  private idleFrameFor(avatar: string, dir: string): number {
    return isLpc(avatar) ? (LPC_ROW[dir] ?? 2) * LPC_COLS : idleFrame(AVATARS[avatar] ? avatar : "1", dir);
  }

  /** open the editor while in the room, then apply + broadcast + persist without leaving */
  private async editAvatarInRoom() {
    const initial = decodeAvatar(this.myAvatar) ?? await defaultDressedConfig();
    const cfg = await openAvatarEditor(initial, this.myName);
    if (!cfg) return;
    this.myAvatar = encodeAvatar(cfg);
    await this.applyAvatarBody();
    this.room?.send("avatar", this.myAvatar);
    const token = localStorage.getItem("nexspace-token");
    if (token) {
      fetch(`${AUTH_API}/me/avatar`, {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ lpc: cfg }),
      }).catch(() => {});
    }
  }

  /** a peer changed their avatar mid-session -> rebuild their sprite */
  private changeRemoteAvatar(sessionId: string, raw: string) {
    const r = this.remotes.get(sessionId);
    if (!r) return;
    const av = isLpc(raw) ? raw : (AVATARS[raw] ? raw : "1");
    r.avatar = av;
    r.sprite.setScale(isLpc(av) ? LPC_SCALE : PRESET_SCALE);
    if (isLpc(av)) {
      void this.ensureLpc(av).then((key) => {
        const rr = this.remotes.get(sessionId);
        if (key && rr) rr.sprite.setTexture(key, this.idleFrameFor(av, rr.dir));
      });
    } else if (this.textures.exists(this.texKeyFor(av))) {
      r.sprite.setTexture(this.texKeyFor(av), this.idleFrameFor(av, r.dir));
    }
  }

  private async createMedia(room: Room, tilesEl: HTMLElement): Promise<MediaManager> {
    try {
      const cfg = await fetch(`${HTTP_URL}/livekit/config`).then((r) => r.json());
      if (cfg?.enabled) {
        const name = (room.state.players.get(this.mySessionId) as any)?.name ?? this.mySessionId;
        const tk = await fetch(
          `${HTTP_URL}/livekit/token?room=office&identity=${this.mySessionId}&name=${encodeURIComponent(name)}`
        ).then((r) => r.json());
        const lk = new LiveKitManager(tilesEl);
        await lk.connect(tk.url, tk.token);
        console.log("[nexspace] media backend: LiveKit SFU");
        return lk;
      }
    } catch (e) {
      console.warn("[nexspace] LiveKit unavailable, using P2P:", e);
    }
    console.log("[nexspace] media backend: P2P mesh");
    return new WebRTCManager(room, this.mySessionId, tilesEl);
  }

  private async connectMultiplayer() {
    try {
      const client = new Client(SERVER_URL);
      const room = await client.joinOrCreate("office", { name: this.myName, avatar: this.myAvatar });
      this.room = room;
      this.mySessionId = room.sessionId;
      console.log(`[nexspace] joined room ${room.roomId} as ${room.sessionId}`);
      setTimeout(() => console.log(`[nexspace] room ${room.roomId}: ${room.state.players.size} online`), 1200);
      const $ = getStateCallbacks(room);

      $(room.state).players.onAdd((player: any, sessionId: string) => {
        if (sessionId === this.mySessionId) {
          this.setAvatarChip(player.name);
          // the server is authoritative: it may reject a claim (desk already taken),
          // so reconcile my local desk with whatever it settled on
          $(player).onChange(() => {
            if (player.desk === this.myDesk) return;
            // a patch generated before the server handled my claim still carries the
            // old desk — ignore mismatches briefly so an in-flight claim isn't undone
            if (this.time.now - this.deskClaimAt < 1500) return;
            this.myDesk = player.desk;
            this.refreshDeskPlates();
          });
        } else {
          this.addRemote(sessionId, player);
          $(player).onChange(() => {
            const r = this.remotes.get(sessionId);
            if (!r) return;
            r.tx = player.x; r.ty = player.y; r.dir = player.dir; r.moving = player.moving;
            if (player.avatar && player.avatar !== r.avatar) this.changeRemoteAvatar(sessionId, player.avatar);
            if (player.desk !== r.deskId) { r.deskId = player.desk; this.refreshDeskPlates(); }
          });
        }
        this.refreshRoster();
        this.refreshDeskPlates();
      });
      $(room.state).players.onRemove((_p: any, sessionId: string) => { this.removeRemote(sessionId); this.refreshRoster(); this.refreshDeskPlates(); });

      // apply my saved desk: claim it and spawn seated there
      if (this.myDesk) {
        this.deskClaimAt = this.time.now;
        room.send("claimDesk", this.myDesk);
        const d = DESKS.find((x) => x.id === this.myDesk);
        if (d) {
          const dx = d.sx * TILE + TILE / 2, dy = d.sy * TILE + TILE / 2;
          this.player.setPosition(dx, dy);
          this.player.body!.reset(dx, dy);
          this.time.delayedCall(200, () => { if (!this.sitting) this.toggleSit(); });
        }
      }

      room.onMessage("chat", (msg: { from: string; text: string }) => this.showBubble(msg.from, msg.text));
      room.onMessage("roomchat", (msg: { from: string; name: string; text: string }) => this.appendChatLog(msg.from, msg.name, msg.text));
      room.onMessage("sit", (m: { from: string; on: boolean; dir: string }) => {
        const r = this.remotes.get(m.from);
        if (!r) return;
        r.sitting = m.on;
        if (m.on) {
          r.dir = m.dir;
          if (isLpc(r.avatar)) void this.ensureLpcSit(r.avatar).then((key) => {
            const rr = this.remotes.get(m.from);
            if (key && rr?.sitting) rr.sprite.setTexture(key, this.sitFrameFor(m.dir));
          });
          else if (this.textures.exists(this.texKeyFor(r.avatar))) r.sprite.setFrame(this.idleFrameFor(r.avatar, m.dir));
        } else {
          const wk = this.texKeyFor(r.avatar);
          if (this.textures.exists(wk)) r.sprite.setTexture(wk, this.idleFrameFor(r.avatar, r.dir));
        }
      });
      room.onMessage("screenshare", (msg: { from: string; on: boolean; screenId: string }) => {
        console.log(`[screen] ${msg.from} presenting=${msg.on} on ${msg.screenId}`);
        const it = INTERACTIVES.find((i) => i.type === "screen" && this.screenId(i) === msg.screenId);
        if (msg.on) {
          this.screenPresenter.set(msg.screenId, msg.from);
          const isMe = msg.from === this.mySessionId;
          const stream = isMe ? this.webrtc?.screenMediaStream ?? null : this.webrtc?.getPeerStream(msg.from) ?? null;
          const name = isMe ? this.myName : (this.remotes.get(msg.from)?.name ?? msg.from);
          this.activeScreenStream = stream;
          this.activePresenterName = name;
          this.setViewMode("call");
        } else {
          this.screenPresenter.delete(msg.screenId);
          this.webrtc?.hidePeerTile(msg.from, false);
          this.activeScreenStream = null;
          this.activePresenterName = "";
          this.updateCallStageUI();
        }
        if (it) this.updateScreen(it);
      });

      // media backend: LiveKit SFU if the server has it configured, else P2P mesh
      const tilesEl = document.getElementById("tiles");
      if (tilesEl) {
        this.webrtc = await this.createMedia(room, tilesEl);
        this.wireAvButtons();
        // when a peer's track arrives, refresh any screen they're presenting on
        this.webrtc.onPeerStream = (peerId) => {
          for (const it of INTERACTIVES) {
            if (it.type === "screen" && this.screenPresenter.get(this.screenId(it)) === peerId) {
              this.activeScreenStream = this.webrtc?.getPeerStream(peerId) ?? null;
              this.activePresenterName = this.remotes.get(peerId)?.name ?? peerId;
              this.updateScreen(it);
              this.updateCallStageUI();
            }
          }
          this.refreshCallSidebarTiles();
        };
        // browser "Stop sharing" bar -> pure cleanup (the track already ended; do NOT re-call getDisplayMedia)
        this.webrtc.onScreenEnd = () => {
          const id = this.myScreenId;
          if (!id) return;
          this.myScreenId = undefined;
          this.screenPresenter.delete(id);
          this.activeScreenStream = null;
          this.activePresenterName = "";
          this.room?.send("screenshare", { on: false, screenId: id });
          const it = INTERACTIVES.find((i) => i.type === "screen" && this.screenId(i) === id);
          if (it) this.updateScreen(it);
          this.setViewMode("space");
          this.webrtc?.onState?.();
        };
      }
    } catch (e) {
      console.warn("[nexspace] multiplayer offline — running single-player:", e);
    }
  }

  private wireAvButtons() {
    const w = this.webrtc!;
    const sv = (inner: string, w2 = "2.4") =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w2}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    const I = {
      mic: sv(`<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4"/>`, "1.8"),
      micOff: sv(`<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4"/><path d="M4 3l16 18"/>`, "1.8"),
      cam: sv(`<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>`, "1.8"),
      camOff: sv(`<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/><path d="M4 3l16 18"/>`, "1.8"),
      emoji: sv(`<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/>`, "1.8"),
      screen: sv(`<rect x="3" y="4" width="18" height="13" rx="2" stroke-dasharray="3 3"/><path d="M9 21h6"/>`, "1.8"),
      door: sv(`<path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M15 12H4"/><path d="M8 8l-4 4 4 4"/>`, "1.8"),
      chev: sv(`<path d="M6 15l6-6 6 6"/>`),
    };
    const el = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
    const mic = el("btn-mic"), cam = el("btn-cam"), scr = el("btn-screen"),
      emoji = el("btn-emoji"), leave = el("btn-leave"),
      micMenu = el("btn-mic-menu"), camMenu = el("btn-cam-menu");
    if (emoji) emoji.innerHTML = I.emoji;
    if (leave) leave.innerHTML = I.door;
    if (scr) scr.innerHTML = I.screen;
    if (micMenu) micMenu.innerHTML = I.chev;
    if (camMenu) camMenu.innerHTML = I.chev;

    if (mic) mic.onclick = () => void w.toggleMic();
    if (cam) cam.onclick = () => void w.toggleCam();
    // AV-bar "share screen" -> present onto the big in-scene screen, room-wide
    if (scr) scr.onclick = () => { const it = this.presentationScreen(); if (it) void this.activateScreen(it); };
    if (micMenu) micMenu.onclick = () => void this.openDeviceMenu("mic", micMenu);
    if (camMenu) camMenu.onclick = () => void this.openDeviceMenu("cam", camMenu);

    const refresh = () => {
      if (mic) { mic.innerHTML = w.micOn ? I.mic : I.micOff; mic.classList.toggle("off", !w.micOn); mic.classList.toggle("active", w.micOn); }
      if (cam) { cam.innerHTML = w.camOn ? I.cam : I.camOff; cam.classList.toggle("off", !w.camOn); cam.classList.toggle("active", w.camOn); }
      if (scr) scr.classList.toggle("active", w.screenOn);
    };
    w.onState = refresh;
    refresh();

    // emoji reactions → sent as a proximity chat bubble
    const pop = document.getElementById("emoji-pop") as HTMLElement | null;
    if (emoji && pop) {
      pop.innerHTML = ["👍", "❤️", "😂", "🎉", "👋", "😮"].map((e) => `<button>${e}</button>`).join("");
      Array.from(pop.children).forEach((b) => ((b as HTMLElement).onclick = () => {
        this.room?.send("chat", { text: (b as HTMLElement).textContent ?? "" });
        pop.style.display = "none";
      }));
      emoji.onclick = () => { pop.style.display = pop.style.display === "flex" ? "none" : "flex"; };
    }

    // leave the room
    if (leave) leave.onclick = () => {
      this.webrtc?.dispose();
      this.room?.leave();
      const ov = document.getElementById("left-overlay");
      if (ov) ov.style.display = "grid";
      document.getElementById("btn-rejoin")?.addEventListener("click", () => location.reload());
    };
  }

  private chipParts(name: string): { initial: string; color: string } {
    const clean = (name || "?").trim();
    const initial = (clean.match(/[A-Za-z0-9฀-๿]/)?.[0] || "?").toUpperCase();
    let h = 0;
    for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
    return { initial, color: `hsl(${h % 360} 60% 68%)` };
  }

  private setAvatarChip(name: string) {
    const chip = document.getElementById("ava-chip");
    if (!chip) return;
    const { initial, color } = this.chipParts(name);
    chip.style.background = color;
    chip.style.color = "#2a2330";
    chip.innerHTML = `${initial}<i class="dot"></i>`;
  }

  private setupSidebar() {
    const sidebar = document.getElementById("sidebar");
    const views: Record<string, string> = { people: "view-people", chat: "view-chat", settings: "view-settings" };
    const titles: Record<string, string> = { people: "NexSpace", chat: "แชตห้องรวม", settings: "ตั้งค่า" };
    const showView = (v: string) => {
      sidebar?.classList.remove("closed");
      for (const [k, id] of Object.entries(views)) {
        const el = document.getElementById(id);
        if (el) (el as HTMLElement).hidden = k !== v;
      }
      for (const k of Object.keys(views)) document.getElementById(`rail-${k}`)?.classList.toggle("active", k === v);
      const t = document.getElementById("sb-title"); if (t) t.textContent = titles[v] ?? "NexSpace";
    };
    document.getElementById("btn-edit-avatar")?.addEventListener("click", () => void this.editAvatarInRoom());
    document.getElementById("rail-people")?.addEventListener("click", () => showView("people"));
    document.getElementById("rail-chat")?.addEventListener("click", () => showView("chat"));
    document.getElementById("rail-settings")?.addEventListener("click", () => showView("settings"));
    document.getElementById("sb-close")?.addEventListener("click", () => sidebar?.classList.add("closed"));
    document.getElementById("sb-search")?.addEventListener("input", () => this.refreshRoster());

    // invite: copy the room link
    document.getElementById("btn-invite")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-invite") as HTMLButtonElement;
      try { await navigator.clipboard.writeText(location.href); btn.textContent = "✓ คัดลอกลิงก์แล้ว!"; }
      catch { btn.textContent = location.href; }
      setTimeout(() => (btn.textContent = "＋ เชิญ / คัดลอกลิงก์"), 2000);
    });

    // room-wide chat
    const input = document.getElementById("room-chat-input") as HTMLInputElement | null;
    const send = () => {
      const text = input?.value.trim();
      if (text && this.room) this.room.send("roomchat", { text });
      if (input) input.value = "";
    };
    document.getElementById("room-chat-send")?.addEventListener("click", send);
    input?.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") send(); });
  }

  private appendChatLog(from: string, name: string, text: string) {
    const log = document.getElementById("chat-log");
    if (!log) return;
    log.querySelector(".chat-empty")?.remove();
    const div = document.createElement("div"); div.className = "msg";
    const who = document.createElement("span");
    who.className = "who" + (from === this.mySessionId ? " me" : "");
    who.textContent = (from === this.mySessionId ? "คุณ" : name) + ":";
    const txt = document.createElement("span"); txt.className = "txt"; txt.textContent = " " + text;
    div.append(who, txt); log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  private refreshRoster() {
    const count = this.room?.state.players.size ?? 0;
    for (const id of ["sb-count", "rail-count"]) {
      const e = document.getElementById(id);
      if (e) e.textContent = String(count);
    }
    const list = document.getElementById("people");
    if (!list || !this.room) return;
    const q = (document.getElementById("sb-search") as HTMLInputElement | null)?.value.toLowerCase() ?? "";
    const rows: { name: string; self: boolean }[] = [];
    this.room.state.players.forEach((p: any, id: string) =>
      rows.push({ name: p.name || "Guest", self: id === this.mySessionId }));
    rows.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
    list.innerHTML = "";
    for (const r of rows) {
      if (q && !r.name.toLowerCase().includes(q)) continue;
      const { initial, color } = this.chipParts(r.name);
      const row = document.createElement("div"); row.className = "person";
      const chip = document.createElement("span"); chip.className = "p-chip";
      chip.style.background = color; chip.textContent = initial;
      const dot = document.createElement("i"); dot.className = "p-dot"; chip.appendChild(dot);
      const info = document.createElement("span"); info.className = "p-info";
      const nm = document.createElement("b"); nm.textContent = r.name + (r.self ? " (คุณ)" : "");
      const st = document.createElement("small"); st.textContent = "Active";
      info.append(nm, st); row.append(chip, info); list.appendChild(row);
    }
  }

  private async openDeviceMenu(kind: "mic" | "cam", anchor: HTMLElement) {
    const w = this.webrtc;
    if (!w) return;
    let pop = document.getElementById("dev-pop") as HTMLElement | null;
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "dev-pop";
      pop.style.cssText = "position:fixed;z-index:22;background:#2e3238f2;border-radius:10px;padding:6px;" +
        "min-width:210px;box-shadow:0 6px 20px #0006;font:13px 'Segoe UI',sans-serif;color:#e6e9ee;";
      document.body.appendChild(pop);
    }
    if (pop.dataset.open === kind && pop.style.display !== "none") { pop.style.display = "none"; pop.dataset.open = ""; return; }

    const dev = await w.devices();
    pop.innerHTML = "";
    const section = (title: string, items: MediaDeviceInfo[], cur: string | undefined, pick: (id: string) => void, fb: string) => {
      const head = document.createElement("div");
      head.textContent = title;
      head.style.cssText = "opacity:.55;font-size:11px;padding:5px 8px 2px;";
      pop!.appendChild(head);
      if (!items.length) {
        const e = document.createElement("div");
        e.textContent = "— อนุญาตอุปกรณ์ก่อน (เปิดไมค์/กล้อง) —";
        e.style.cssText = "padding:4px 8px;opacity:.5;font-size:12px;";
        pop!.appendChild(e);
      }
      items.forEach((d, i) => {
        const b = document.createElement("button");
        b.textContent = (cur === d.deviceId ? "✓ " : "") + (d.label || `${fb} ${i + 1}`);
        b.style.cssText = "display:block;width:100%;text-align:left;border:none;background:transparent;" +
          "color:#e6e9ee;padding:6px 8px;border-radius:6px;cursor:pointer;font:13px 'Segoe UI',sans-serif;";
        b.onmouseenter = () => (b.style.background = "#ffffff1a");
        b.onmouseleave = () => (b.style.background = "transparent");
        b.onclick = () => { pick(d.deviceId); pop!.style.display = "none"; pop!.dataset.open = ""; };
        pop!.appendChild(b);
      });
    };

    if (kind === "mic") {
      section("ไมโครโฟน", dev.mics, w.selMic, (id) => void w.setMic(id), "Microphone");
      section("ลำโพง", dev.speakers, w.selSpk, (id) => void w.setSpeaker(id), "Speaker");
    } else {
      section("กล้อง", dev.cams, w.selCam, (id) => void w.setCam(id), "Camera");
    }

    const r = anchor.getBoundingClientRect();
    pop.style.display = "block";
    pop.dataset.open = kind;
    pop.style.left = Math.max(8, r.left - 95) + "px";
    pop.style.bottom = window.innerHeight - r.top + 8 + "px";
  }

  private setZoom(z: number) {
    this.cameras.main.setZoom(Phaser.Math.Clamp(z, ZOOM_MIN, ZOOM_MAX));
  }
  private zoomBy(factor: number) {
    this.setZoom(this.cameras.main.zoom * factor);
  }

  private setupZoomControls() {
    const svg = (inner: string) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    const icons = {
      locate: svg(`<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/>`),
      in: svg(`<path d="M12 5v14M5 12h14"/>`),
      out: svg(`<path d="M5 12h14"/>`),
      fully: svg(`<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>`),
      desk: svg(`<path d="M3 10h18M4 10v8M20 10v8M6 10V7h12v3"/><path d="M8 18v2M16 18v2"/>`),
    };
    const b = (id: string, html: string, fn: () => void) => {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (el) { el.innerHTML = html; el.onclick = fn; }
    };
    b("zb-locate", icons.locate, () => { this.setZoom(ZOOM_DEFAULT); this.cameras.main.startFollow(this.player, true, 0.12, 0.12); });
    b("zb-desk", icons.desk, () => this.goToMyDesk());
    b("zb-in", icons.in, () => this.zoomBy(1.2));
    b("zb-out", icons.out, () => this.zoomBy(1 / 1.2));
    b("zb-fully", icons.fully, () => this.setZoom(ZOOM_MIN));
  }

  private setupInteractives() {
    // floating bobbing icon over each interactive tile
    for (const it of INTERACTIVES) {
      const px = it.x * TILE + TILE / 2, py = it.y * TILE + TILE / 2;
      const ic = this.add.text(px, py - 22, it.icon, { fontSize: "16px" }).setOrigin(0.5).setDepth(90000);
      this.tweens.add({ targets: ic, y: py - 28, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
    document.getElementById("modal-close")?.addEventListener("click", () => this.closeModal());
    this.input.keyboard!.on("keydown-ESC", () => this.closeModal());
  }

  private async activateInteractive(it: Interactive) {
    if (it.type === "portal" && it.target) {
      const tx = it.target.x * TILE + TILE / 2, ty = it.target.y * TILE + TILE / 2;
      const cam = this.cameras.main;
      cam.fadeOut(140);
      cam.once("camerafadeoutcomplete", () => {
        this.player.setPosition(tx, ty);
        this.player.body!.reset(tx, ty);
        cam.fadeIn(160);
      });
      return;
    }
    if (it.type === "screen") { await this.activateScreen(it); return; }
    if (it.url) this.openModal(it.label, it.url); // whiteboard / embed
  }

  private screenId(it: Interactive) { return `${it.x},${it.y}`; }
  /** the shared presentation screen (the AV-bar share button routes here) */
  private presentationScreen() { return INTERACTIVES.find((i) => i.type === "screen"); }

  /** presenter toggles their screen-share onto this in-scene screen (room-wide) */
  private async activateScreen(it: Interactive) {
    const id = this.screenId(it);
    if (this.myScreenId === id) {
      // stop presenting
      if (this.webrtc?.screenOn) await this.webrtc.toggleScreen();
      this.myScreenId = undefined;
      this.activeScreenStream = null;
      this.activePresenterName = "";
      this.room?.send("screenshare", { on: false, screenId: id });
      this.screenPresenter.delete(id);
      this.updateScreen(it);
      this.setViewMode("space");
      this.webrtc?.onState?.();
      return;
    }
    await this.webrtc?.toggleScreen(); // getDisplayMedia
    if (!this.webrtc?.screenOn) {
      this.activeScreenStream = null;
      this.activePresenterName = "";
      this.updateCallStageUI();
      return;
    }
    this.myScreenId = id;
    this.screenPresenter.set(id, this.mySessionId);
    this.activeScreenStream = this.webrtc?.screenMediaStream ?? null;
    this.activePresenterName = this.myName;
    this.setViewMode("call");
    this.room?.send("screenshare", { on: true, screenId: id }); // broadcast -> everyone force-connects a peer
    this.updateScreen(it);
    this.webrtc?.onState?.();
  }

  private setupTopHeader() {
    const spaceBtn = document.getElementById("nav-tab-space");
    const callBtn = document.getElementById("nav-tab-call");
    spaceBtn?.addEventListener("click", () => this.setViewMode("space"));
    callBtn?.addEventListener("click", () => this.setViewMode("call"));

    document.getElementById("btn-fullscreen")?.addEventListener("click", () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else document.exitFullscreen().catch(() => {});
    });
  }

  private setViewMode(mode: "space" | "call") {
    const spaceBtn = document.getElementById("nav-tab-space");
    const callBtn = document.getElementById("nav-tab-call");
    const callOverlay = document.getElementById("call-view-overlay");
    const appContainer = document.getElementById("app");
    const zoomBar = document.getElementById("zoom-bar");

    spaceBtn?.classList.toggle("active", mode === "space");
    callBtn?.classList.toggle("active", mode === "call");

    if (callOverlay) callOverlay.style.display = mode === "call" ? "grid" : "none";
    if (appContainer) appContainer.style.visibility = mode === "call" ? "hidden" : "visible";
    if (zoomBar) zoomBar.style.display = mode === "call" ? "none" : "flex";

    if (mode === "call") this.updateCallStageUI();
  }

  private updateCallStageUI() {
    const stageVideo = document.getElementById("call-stage-video") as HTMLVideoElement | null;
    const noStreamEl = document.getElementById("call-no-stream");
    const presenterTag = document.getElementById("presenter-tag");
    const callBtn = document.getElementById("nav-tab-call");

    const hasStream = !!this.activeScreenStream;
    document.body.classList.toggle("has-screenshare", hasStream);
    if (callBtn) callBtn.classList.toggle("has-call", hasStream);

    if (stageVideo) {
      if (hasStream) {
        if (stageVideo.srcObject !== this.activeScreenStream) {
          stageVideo.srcObject = this.activeScreenStream;
          stageVideo.play().catch(() => {});
        }
        stageVideo.style.display = "block";
      } else {
        stageVideo.srcObject = null;
        stageVideo.style.display = "none";
      }
    }
    if (noStreamEl) noStreamEl.style.display = hasStream ? "none" : "flex";
    if (presenterTag) {
      presenterTag.style.display = hasStream ? "block" : "none";
      presenterTag.textContent = `${this.activePresenterName}'s Screenshare`;
    }
    this.refreshCallSidebarTiles();
  }

  private refreshCallSidebarTiles() {
    const selfLabel = document.getElementById("call-self-label");
    if (selfLabel) selfLabel.textContent = this.myName + " (คุณ)";
    const container = document.getElementById("call-peers-container");
    if (!container) return;
    container.innerHTML = "";
    for (const [id, r] of this.remotes) {
      const card = document.createElement("div");
      card.className = "peer-card";
      const lbl = document.createElement("span");
      lbl.className = "peer-label";
      lbl.textContent = r.name || id;
      const avatar = document.createElement("div");
      avatar.className = "peer-avatar-fallback";
      avatar.textContent = "👤";
      card.append(avatar, lbl);
      const peerStream = this.webrtc?.getPeerStream(id);
      if (peerStream) {
        const vid = document.createElement("video");
        vid.autoplay = true; vid.playsInline = true;
        vid.srcObject = peerStream;
        avatar.style.display = "none";
        card.appendChild(vid);
      }
      container.appendChild(card);
    }
  }

  /** pick the right stream (mine or the remote presenter's) and (re)render it on the object */
  private updateScreen(it: Interactive) {
    const id = this.screenId(it);
    const presenter = this.screenPresenter.get(id);
    if (!presenter) return this.renderScreen(it, null);
    const stream = presenter === this.mySessionId
      ? this.webrtc?.screenMediaStream ?? null
      : this.webrtc?.getPeerStream(presenter) ?? null;
    if (presenter !== this.mySessionId) this.webrtc?.hidePeerTile(presenter, true); // route to big screen, not a small tile
    this.renderScreen(it, stream);
  }

  private renderScreen(it: Interactive, stream: MediaStream | null) {
    const id = this.screenId(it);
    console.log(`[screen] render ${id}: ${stream ? "STREAM (" + stream.getVideoTracks().length + " video)" : "clear"}`);
    this.sceneScreens.get(id)?.destroy();
    this.sceneScreens.delete(id);
    if (!stream) return;
    const px = it.x * TILE + TILE / 2, py = it.y * TILE + TILE / 2 + TILE; // sits just below the top wall
    // fixed 16:9 panel on the wall (don't depend on late-arriving video dimensions)
    const SW = 6 * TILE, SH = Math.round(SW * 9 / 16);
    const v = this.add.video(px, py).setOrigin(0.5, 0).setDisplaySize(SW, SH).setDepth(90000); // above walls/furniture
    this.sceneScreens.set(id, v);
    const start = (why: string) => { v.setDisplaySize(SW, SH); const p = v.play(true) as unknown as Promise<void> | undefined; if (p?.catch) p.catch(() => {}); console.log(`[screen] play (${why})`); };
    v.on("created", () => start("created"));
    v.on("playing", () => v.setDisplaySize(SW, SH));
    try {
      v.loadMediaStream(stream, true);
      start("immediate");
    } catch (e) { console.warn("scene screen", e); }
  }

  private openModal(title: string, url: string) {
    const m = document.getElementById("modal");
    const f = document.getElementById("modal-frame") as HTMLIFrameElement | null;
    const t = document.getElementById("modal-title");
    if (t) t.textContent = title;
    if (f) f.src = url;
    if (m) m.style.display = "grid";
  }

  private closeModal() {
    const m = document.getElementById("modal");
    const f = document.getElementById("modal-frame") as HTMLIFrameElement | null;
    if (f) f.src = "about:blank";
    if (m) m.style.display = "none";
  }

  // Phaser globally captures WASD + arrow keys for movement (calls preventDefault),
  // which otherwise stops those letters reaching any HTML field — auth/name inputs,
  // sidebar search, room chat. Release the keyboard to the DOM while a field is focused.
  private setupInputFocusGuard() {
    const kb = this.input.keyboard;
    if (!kb) return;
    const editable = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    const release = () => { kb.enabled = false; kb.disableGlobalCapture(); kb.resetKeys(); };
    const grab = () => { kb.enabled = true; kb.enableGlobalCapture(); };
    document.addEventListener("focusin", (e) => { if (editable(e.target)) release(); });
    document.addEventListener("focusout", (e) => { if (editable(e.target)) grab(); });
    // a field may already hold focus when the scene boots (e.g. autofilled login)
    if (editable(document.activeElement)) release();
  }

  private setupChat() {
    const input = document.getElementById("chat") as HTMLInputElement | null;
    if (!input) return;
    const open = (v: boolean) => { input.style.display = v ? "block" : "none"; if (v) input.focus(); else input.blur(); };
    // Enter (game focused) opens the chat box
    this.input.keyboard!.on("keydown-ENTER", () => { if (input.style.display === "none") open(true); });
    // keys inside the box don't leak to the game (stops movement while typing)
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const text = input.value.trim();
        if (text && this.room) this.room.send("chat", { text });
        input.value = ""; open(false);
      } else if (e.key === "Escape") { input.value = ""; open(false); }
    });
  }

  private showBubble(fromId: string, text: string) {
    const key = fromId === this.mySessionId ? "local" : fromId;
    this.bubbles.get(key)?.destroy();
    const t = this.add.text(0, 0, text, {
      fontSize: "9px", color: "#2a2f36", backgroundColor: "#fffef9",
      padding: { x: 5, y: 3 }, wordWrap: { width: 120 }, align: "center",
    }).setOrigin(0.5, 1).setDepth(100001);
    this.bubbles.set(key, t);
    this.time.delayedCall(4500, () => {
      if (this.bubbles.get(key) === t) { t.destroy(); this.bubbles.delete(key); }
    });
  }

  /**
   * Rounded "pill" name tag used for player labels and desk nameplates.
   * The canvas is pixelArt (NEAREST) and the camera zooms ~2.2x, which turns
   * plain 8-9px text into a blurry, jagged mess — so render the glyphs at 3x
   * and let the texture downscale linearly instead.
   */
  private makeNameTag(x: number, y: number, label: string, accent = false): Phaser.GameObjects.Container {
    const t = this.add.text(0, 0, label, {
      fontFamily: '"Segoe UI", system-ui, sans-serif',
      fontSize: "8px",
      color: accent ? "#8ff2e2" : "#f2f5f8",
      resolution: 3, // must be set at construction: Text only wires frame.source.resolution there
    }).setOrigin(0, 0.5);
    t.texture.setFilter(Phaser.Textures.FilterMode.LINEAR); // smooth 3x -> 1x downscale (canvas is NEAREST)

    const PAD = 3.5, DOT_R = 1.5, GAP = 2.5;
    const w = PAD * 2 + DOT_R * 2 + GAP + Math.ceil(t.width);
    const h = Math.ceil(t.height) + 2;
    const r = Math.min(4, h / 2);
    const g = this.add.graphics();
    g.fillStyle(0x171a1f, 0.8);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, r);
    g.lineStyle(1, accent ? 0x2bb3a3 : 0xffffff, accent ? 0.9 : 0.2);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, r);
    g.fillStyle(0x39d353, 1); // online status dot (same green as the av-bar / roster dots)
    g.fillCircle(-w / 2 + PAD + DOT_R, 0, DOT_R);

    t.setPosition(-w / 2 + PAD + DOT_R * 2 + GAP, 0);
    return this.add.container(x, y, [g, t]).setDepth(100000);
  }

  /** (re)build my own name tag — the tag is a container, so a name change rebuilds it */
  private refreshMyLabel() {
    this.myLabel?.destroy();
    this.myLabel = this.makeNameTag(this.player.x, this.player.y - 34, this.myName);
  }

  private addRemote(sessionId: string, player: any) {
    const raw: string = player.avatar || "1";
    const av = isLpc(raw) ? raw : (AVATARS[raw] ? raw : "1");
    // custom avatars aren't ready yet -> start on a placeholder, swap in when composed
    const startTex = this.textures.exists(this.texKeyFor(av)) ? this.texKeyFor(av) : AVATARS["1"].tex;
    const sprite = this.add.sprite(player.x, player.y, startTex, 0).setDepth(player.y);
    sprite.setScale(isLpc(av) ? LPC_SCALE : PRESET_SCALE);
    const name: string = player.name ?? "Guest";
    const label = this.makeNameTag(player.x, player.y - 34, name);
    this.remotes.set(sessionId, { sprite, label, name, tx: player.x, ty: player.y, dir: player.dir, moving: player.moving, avatar: av });
    if (isLpc(av)) void this.ensureLpc(av).then((key) => {
      const r = this.remotes.get(sessionId);
      if (key && r) r.sprite.setTexture(key, this.idleFrameFor(av, r.dir));
    });
  }

  private removeRemote(sessionId: string) {
    const r = this.remotes.get(sessionId);
    if (!r) return;
    r.sprite.destroy();
    r.label.destroy();
    r.ring?.destroy();
    this.bubbles.get(sessionId)?.destroy();
    this.bubbles.delete(sessionId);
    this.remotes.delete(sessionId);
    // if they were presenting on a screen, clear it
    for (const it of INTERACTIVES) {
      if (it.type === "screen" && this.screenPresenter.get(this.screenId(it)) === sessionId) {
        this.screenPresenter.delete(this.screenId(it));
        this.updateScreen(it);
      }
    }
  }

  private selectChair(obj: Phaser.GameObjects.Image) {
    this.selected?.clearTint();
    this.selected = obj;
    obj.setTint(0xfff2c0);
    this.selRing.setPosition(obj.x, obj.y).setVisible(true);
  }

  private deselectChair() {
    this.selected?.clearTint();
    this.selected = undefined;
    this.selRing.setVisible(false);
  }

  /** nearest directional chair to the player, within ~1.5 tiles (else undefined) */
  private chairNearPlayer(): Phaser.GameObjects.Image | undefined {
    let best: Phaser.GameObjects.Image | undefined, bd = (1.5 * TILE) ** 2;
    for (const c of this.rotatables) {
      const d2 = (c.x - this.player.x) ** 2 + (c.y - this.player.y) ** 2;
      if (d2 < bd) { bd = d2; best = c; }
    }
    return best;
  }

  /** sit on the nearest chair (facing the way it points), or stand up if already sitting */
  private toggleSit() {
    if (this.sitting) { this.standUp(); return; }
    const chair = this.chairNearPlayer();
    if (!chair) return;
    const dir = CHAIR_DIRS[this.getChairDirIndex(chair)] ?? "south";
    this.facing = CHAIR_TO_FACING[dir] ?? "down";
    this.sitting = true;
    this.satChair = chair;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    this.player.setPosition(chair.x, chair.y - 6); // sit on the seat
    body.reset(chair.x, chair.y - 6);
    this.player.setDepth(this.sitDepth(chair.depth, this.facing));
    if (this.textures.exists(this.texKeyFor(this.myAvatar)))
      this.player.setFrame(this.idleFrameFor(this.myAvatar, this.facing)); // immediate; sit pose swaps in below
    if (isLpc(this.myAvatar)) {
      void this.ensureLpcSit(this.myAvatar).then((key) => {
        if (key && this.sitting) this.player.setTexture(key, this.sitFrameFor(this.facing)); // real sit pose
      });
    }
    this.room?.send("move", { x: Math.round(chair.x), y: Math.round(chair.y - 6), dir: this.facing, moving: false });
    this.room?.send("sit", { on: true, dir: this.facing }); // let peers show the sit pose too
  }

  private standUp() {
    if (!this.sitting) return;
    this.sitting = false;
    this.satChair = undefined;
    if (isLpc(this.myAvatar)) { // back to the walk texture
      const wk = this.texKeyFor(this.myAvatar);
      if (this.textures.exists(wk)) this.player.setTexture(wk, this.idleFrameFor(this.myAvatar, this.facing));
    }
    this.room?.send("sit", { on: false, dir: this.facing });
  }

  // ---- home desks ----------------------------------------------------------
  /** click a desk to claim it (or click your own again to release) */
  private claimDesk(deskId: string) {
    if (!this.room) return;
    const next = this.myDesk === deskId ? "" : deskId;
    if (next) {
      let taken = false;
      this.room.state.players.forEach((p: any, sid: string) => {
        if (sid !== this.mySessionId && p.desk === deskId) taken = true;
      });
      if (taken) { this.toast("โต๊ะนี้มีเจ้าของแล้ว", "warn"); return; }
    }
    this.myDesk = next;
    this.deskClaimAt = this.time.now;
    this.room.send("claimDesk", next);
    this.saveDesk(next);
    this.refreshDeskPlates();
    if (next) this.toast("จองโต๊ะนี้เป็นโต๊ะของคุณแล้ว", "success");
    else this.toast("ยกเลิกการจองโต๊ะแล้ว", "info");
  }

  /** persist the chosen desk: member -> API, everyone -> localStorage */
  private saveDesk(deskId: string) {
    try { localStorage.setItem("nexspace-desk", deskId); } catch { /* ignore */ }
    const token = localStorage.getItem("nexspace-token");
    if (token) {
      fetch(`${AUTH_API}/me/desk`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ desk: deskId }),
      }).catch(() => {});
    }
  }

  /** redraw owner nameplates over every claimed desk (shared: reads room state) */
  private refreshDeskPlates() {
    for (const t of this.deskPlates.values()) t.destroy();
    this.deskPlates.clear();
    if (!this.room) return;
    const owners = new Map<string, string>();
    // peers come from room state; my own claim comes from local state because the
    // server round-trip lags the click (state still holds my previous desk here)
    this.room.state.players.forEach((p: any, sid: string) => {
      if (sid === this.mySessionId) return;
      if (p.desk) owners.set(p.desk, p.name || "?");
    });
    if (this.myDesk) owners.set(this.myDesk, this.myName);
    for (const d of DESKS) {
      const owner = owners.get(d.id);
      if (!owner) continue;
      const mine = d.id === this.myDesk;
      const t = this.makeNameTag(d.x * TILE + TILE / 2, d.y * TILE - 12, owner, mine).setDepth(99000);
      this.deskPlates.set(d.id, t);
    }
  }

  /** teleport to my desk's seat and sit down */
  private goToMyDesk() {
    if (!this.myDesk) { this.toast("ยังไม่ได้เลือกโต๊ะ — คลิกที่โต๊ะเพื่อจอง", "info"); return; }
    const d = DESKS.find((x) => x.id === this.myDesk);
    if (!d) return;
    const tx = d.sx * TILE + TILE / 2, ty = d.sy * TILE + TILE / 2;
    const cam = this.cameras.main;
    cam.fadeOut(120);
    cam.once("camerafadeoutcomplete", () => {
      if (this.sitting) this.standUp();
      this.player.setPosition(tx, ty);
      this.player.body!.reset(tx, ty);
      cam.fadeIn(150);
      cam.startFollow(this.player, true, 0.12, 0.12);
      this.time.delayedCall(90, () => { if (!this.sitting) this.toggleSit(); });
    });
  }

  /** brief screen-anchored message */
  private toast(msg: string, kind: "success" | "warn" | "info" = "success") {
    const el = document.getElementById("toast");
    const ico = el?.querySelector<HTMLElement>(".t-ico");
    const txt = el?.querySelector<HTMLElement>(".t-msg");
    if (!el || !ico || !txt) return;
    ico.textContent = kind === "success" ? "✓" : kind === "warn" ? "!" : "🪑";
    txt.textContent = msg;
    el.className = kind;          // resets .show so the enter animation replays
    el.style.display = "flex";
    void el.offsetWidth;          // flush styles so the transition restarts
    el.classList.add("show");
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.classList.remove("show");
      window.setTimeout(() => { if (!el.classList.contains("show")) el.style.display = "none"; }, 260);
    }, 2300);
  }

  /** Get the current direction index of a directional chair from its texture key */
  private getChairDirIndex(obj: Phaser.GameObjects.Image): number {
    const texKey = obj.texture.key;
    for (let i = 0; i < CHAIR_DIRS.length; i++) {
      if (texKey.endsWith(`-${CHAIR_DIRS[i]}`)) return i;
    }
    return 0; // default south
  }

  /** Rotate a chair to the nearest 8-way direction based on angle (radians) */
  private rotateChairToAngle(obj: Phaser.GameObjects.Image, ang: number) {
    const style = this.chairStyles.get(obj);
    if (!style) return; // stool or non-directional chair
    // Snap angle to nearest of 8 directions
    let deg = Phaser.Math.RadToDeg(ang);
    if (deg < 0) deg += 360;
    // 0=E, 45=SE, 90=S, 135=SW, 180=W, 225=NW, 270=N, 315=NE
    const snapDirs: [number, string][] = [
      [0, "east"], [45, "south-east"], [90, "south"], [135, "south-west"],
      [180, "west"], [225, "north-west"], [270, "north"], [315, "north-east"],
    ];
    let best = "south";
    let bestDist = 999;
    for (const [a, d] of snapDirs) {
      let diff = Math.abs(deg - a);
      if (diff > 180) diff = 360 - diff;
      if (diff < bestDist) { bestDist = diff; best = d; }
    }
    const key = `${style}-${best}`;
    if (this.textures.exists(key)) obj.setTexture(key);
  }

  /** Step a chair through directions by +1 or -1 */
  private rotateChairStep(obj: Phaser.GameObjects.Image, step: number) {
    const style = this.chairStyles.get(obj);
    if (!style) {
      // fallback for non-directional chairs (stool etc): use rotation
      obj.rotation += step * Phaser.Math.DegToRad(45);
      return;
    }
    const idx = this.getChairDirIndex(obj);
    const newIdx = ((idx + step) % CHAIR_DIRS.length + CHAIR_DIRS.length) % CHAIR_DIRS.length;
    const key = `${style}-${CHAIR_DIRS[newIdx]}`;
    if (this.textures.exists(key)) obj.setTexture(key);
  }

  update() {
    const speed = 150;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    let vx = 0, vy = 0;
    const typing = document.activeElement instanceof HTMLInputElement; // any text field (chat/search/room-chat)
    if (!typing) {
      if (this.cursors.left.isDown || this.keys.A.isDown) vx = -1;
      else if (this.cursors.right.isDown || this.keys.D.isDown) vx = 1;
      if (this.cursors.up.isDown || this.keys.W.isDown) vy = -1;
      else if (this.cursors.down.isDown || this.keys.S.isDown) vy = 1;
    }

    if (this.sitting && (vx !== 0 || vy !== 0)) this.standUp(); // any movement input stands up

    const len = Math.hypot(vx, vy) || 1;
    body.setVelocity((vx / len) * speed, (vy / len) * speed);

    const h = vx < 0 ? "left" : vx > 0 ? "right" : "";
    const v = vy < 0 ? "up" : vy > 0 ? "down" : "";
    if (v && h) this.facing = `${v}-${h}`;
    else if (v || h) this.facing = v || h;

    // walk animation while moving; stand on the neutral frame when idle
    // (skip entirely while seated so the sit pose/texture isn't overwritten)
    const myAnim = this.animKeyFor(this.myAvatar, this.facing);
    if (this.sitting) {
      this.player.anims.stop();
    } else if ((vx !== 0 || vy !== 0) && this.anims.exists(myAnim)) {
      this.player.anims.play(myAnim, true);
    } else {
      this.player.anims.stop();
      if (this.textures.exists(this.texKeyFor(this.myAvatar)))
        this.player.setFrame(this.idleFrameFor(this.myAvatar, this.facing));
    }
    this.player.setDepth(this.sitting && this.satChair ? this.sitDepth(this.satChair.depth, this.facing) : this.player.y);
    this.myLabel?.setPosition(this.player.x, this.player.y - 34);

    // --- send my state to server (throttled + only when it changes) ---
    const moving = vx !== 0 || vy !== 0;
    if (this.room) {
      const now = this.time.now;
      const changed =
        Math.abs(this.player.x - this.lastState.x) > 0.5 ||
        Math.abs(this.player.y - this.lastState.y) > 0.5 ||
        this.facing !== this.lastState.dir ||
        moving !== this.lastState.moving;
      if (changed && now - this.lastSent > 60) {
        this.room.send("move", { x: Math.round(this.player.x), y: Math.round(this.player.y), dir: this.facing, moving });
        this.lastSent = now;
        this.lastState = { x: this.player.x, y: this.player.y, dir: this.facing, moving };
      }
    }

    // --- interpolate + animate remotes, and compute proximity ("in conversation") ---
    const near2 = this.NEAR * this.NEAR;
    const FULL = 2 * TILE; // distance for full audio volume
    let anyNear = false;
    const nearbyIds = new Set<string>();
    for (const [id, r] of this.remotes) {
      r.sprite.x = Phaser.Math.Linear(r.sprite.x, r.tx, 0.25);
      r.sprite.y = Phaser.Math.Linear(r.sprite.y, r.ty, 0.25);
      r.sprite.setDepth(r.sitting ? this.sitDepth(r.ty + 6, r.dir) : r.sprite.y);
      const rAnim = this.animKeyFor(r.avatar, r.dir);
      if (r.sitting) {
        r.sprite.anims.stop(); // seated: keep the sit pose (set on the sit message)
      } else if (r.moving && this.anims.exists(rAnim)) r.sprite.anims.play(rAnim, true);
      else if (this.textures.exists(this.texKeyFor(r.avatar))) {
        r.sprite.anims.stop(); r.sprite.setFrame(this.idleFrameFor(r.avatar, r.dir));
      }
      r.label.setPosition(r.sprite.x, r.sprite.y - 34);

      const dx = r.sprite.x - this.player.x, dy = r.sprite.y - this.player.y;
      const d2 = dx * dx + dy * dy;
      const near = d2 <= near2;
      if (near) { anyNear = true; nearbyIds.add(id); }
      if (near && !r.ring) r.ring = this.add.circle(0, 0, 15).setStrokeStyle(2, 0x2bb3a3, 0.9).setDepth(1);
      if (r.ring) r.ring.setVisible(near).setPosition(r.sprite.x, r.sprite.y + 18);

      // spatial audio: louder when close, fading to silent at the proximity edge
      if (near) {
        const dist = Math.sqrt(d2);
        const vol = dist <= FULL ? 1 : 1 - (dist - FULL) / (this.NEAR - FULL);
        this.webrtc?.setPeerVolume(id, Math.max(0, Math.min(1, vol)));
      }
    }
    this.localRing.setVisible(anyNear).setPosition(this.player.x, this.player.y + 18);

    // connect/disconnect P2P media by proximity, PLUS a room-wide set for screen
    // sharing: if I'm presenting, connect to everyone; also connect to any presenter.
    const forced = new Set<string>();
    if (this.webrtc?.screenOn) for (const id of this.remotes.keys()) forced.add(id);
    for (const pid of this.screenPresenter.values()) if (this.remotes.has(pid)) forced.add(pid);
    this.webrtc?.syncPeers(nearbyIds, forced);

    // --- keep chat bubbles above their owner ---
    for (const [key, t] of this.bubbles) {
      const spr = key === "local" ? this.player : this.remotes.get(key)?.sprite;
      if (spr) t.setPosition(spr.x, spr.y - 42);
    }

    // --- interactive objects: find nearest in range, show/hide the "press E" hint ---
    let near: Interactive | undefined;
    let best = 46 * 46;
    for (const it of INTERACTIVES) {
      const dx = it.x * TILE + TILE / 2 - this.player.x;
      const dy = it.y * TILE + TILE / 2 - this.player.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; near = it; }
    }
    this.nearInteractive = near;
    const hint = document.getElementById("interact-hint");
    if (hint) {
      hint.style.display = near ? "flex" : "none";
      if (near) { const l = document.getElementById("interact-label"); if (l) l.textContent = near.label; }
    }
  }
}
