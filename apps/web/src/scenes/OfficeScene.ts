import Phaser from "phaser";
import { Client, getStateCallbacks, type Room } from "colyseus.js";
import { wallTileIndex } from "../wallAutotile";
import { WebRTCManager } from "../net/webrtc";
import { LiveKitManager } from "../net/livekit";
import type { MediaManager } from "../net/media";
import { buildWalkCanvas, buildSitCanvas, SIT_COLS, SIT_SEATED_COL, decodeAvatar, encodeAvatar, isLpc, avatarKey, defaultDressedConfig, LPC_ROW } from "../avatar/avatarCompose";
import { openAvatarEditor } from "../avatar/avatarEditor";
import { WORKSPACE, IS_DEFAULT_WORKSPACE, workspaceLabel, inviteLink, wsKey,
         GUEST_CODE, ARRIVE_AT, gotoMap } from "../workspace";
import { API as AUTH_API } from "../api";
import { t, onLangChange, locale } from "../i18n";
import { ACCEPT, type Attach, attachNode, humanSize, upload } from "../net/attach";
import { type Booking, clock, mountCalendarPanel } from "../calendarPanel";
import { setupPrefsModal } from "../prefsModal";
import { roleLabel } from "../memberPanel";
import { propPath, type Interactive } from "./mapThemes";
import { currentTheme, currentMapSlug, loadMapList, mapList } from "./mapSource";
import { canHear, type PrivateArea } from "./areas";

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
  status?: string;
}

// ===== Office size: SMALL (S) — 1-10 people — compact 20x15 =====
const TILE = 32;

// the layout is chosen per page load; see mapThemes.ts
// Resolved before this module was imported — see mapSource.loadMap(), which
// main.ts awaits. The scene therefore never guesses which world it is in.
const THEME = currentTheme();
const COLS = THEME.cols;
const ROWS = THEME.rows;
// Where you appear. A portal from another map names the tile it puts you down
// on, which is what makes a doorway on one floor line up with the doorway on
// the other; without one you land on the map's own spawn.
const SPAWN = ARRIVE_AT && ARRIVE_AT.x < THEME.cols && ARRIVE_AT.y < THEME.rows ? ARRIVE_AT : THEME.spawn;
// The zoom ladder, as levels rather than camera zoom values — see setZoom. A
// step is what the +/- buttons and the wheel move. 2 is the readable default; 0.5
// is half size, which fits a whole floor plan on screen; 6 is close enough to
// read a desk plate.
//
// Only halves and whole numbers are on the ladder, because those are the zooms
// that keep pixel art sharp: a whole number puts one art pixel on N device
// pixels, and 0.5 puts a 2x2 block of art pixels on one. Anything between
// resamples the art into mush, which is the reason this is a ladder at all.
const ZOOM_STEPS = [0.5, 1, 2, 3, 4, 5, 6];
const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const ZOOM_DEFAULT = 2;

/**
 * The drawing buffer holds one pixel per device pixel (see main.ts), so a camera
 * zoom of N puts one art pixel on exactly N device pixels. Multiplying the level
 * by the display scaling keeps the room the same physical size on a 150% display
 * as on a 100% one, and the result is then snapped back onto a crisp value.
 */
const cameraZoomFor = (level: number) => {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const z = level * dpr;
  if (z >= 1) return Math.round(z);
  // Reducing, not enlarging: only 1/n is clean here. At 125% scaling a level of
  // 0.5 works out to 0.625, which would land 1.6 art pixels on each device pixel
  // — snapping to 1/2 keeps the block whole.
  return 1 / Math.max(2, Math.round(1 / z));
};

const CHAIR_DIRS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];

const FURNITURE = THEME.furniture;
const OUTDOOR = THEME.outdoor;
const DECALS = THEME.decals;
const DECOR = THEME.decor;
const DESKS = THEME.desks;
const INTERACTIVES = THEME.interactives;

// presence: green available, amber away, red mic muted, grey busy/in a meeting
const STATUS_META: Record<string, { color: number; css: string; label: string }> = {
  online:  { color: 0x39d353, css: "#39d353", label: "กำลังใช้งาน" },
  afk:     { color: 0xf0b429, css: "#f0b429", label: "ไม่อยู่" },
  muted:   { color: 0xe5484d, css: "#e5484d", label: "ปิดไมค์" },
  meeting: { color: 0x8b949e, css: "#8b949e", label: "อยู่ในประชุม" },
  busy:    { color: 0xb86bd1, css: "#b86bd1", label: "ห้ามรบกวน" },
};
const statusMeta = (s: string) => STATUS_META[s] ?? STATUS_META.online;
const AFK_MS = 180_000;              // no input for 3 min -> away
const MEETING_ROOM = THEME.meetingRoom;

/** what each gesture is called, for the button's tooltip */
const EMOTE_NAMES: Record<string, string> = {
  wave: "โบกมือ", dance: "เต้น", clap: "ปรบมือ",
  thumbs: "ยกนิ้วให้", party: "ฉลอง", think: "กำลังคิด",
};

// Must match STICKERS in the game server, which is the side that refuses one:
// an emoji this list offers and that one rejects is a button that does nothing.
const STICKER_SET = ["❤️", "👍", "🎉", "⭐", "❗", "❓", "💡", "🔥", "☕", "🍕", "🌿", "🚧"];
/** the private areas drawn on this map — empty for a map that has none */
const PRIVATE_AREAS = THEME.areas;
/** which map of the space this tab is on; "" on one of the built-in layouts */
const MAP = currentMapSlug();
/**
 * The same thing, as the calendar names it.
 *
 * A booking has to say which map its room is on, and "" is not a name — a stock
 * layout would store every space's bookings under the empty string and read
 * them back fine, right up until a space added a second map.
 */
const MAP_KEY = MAP || "main";

interface MeetingPerson { id: string; name: string; self: boolean; status: string; mic: boolean; hand: boolean }

export class OfficeScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private myLabel?: Phaser.GameObjects.Container; // my own name tag above my head
  private myDesk = "";                          // id of my claimed home desk ("" = none)
  private zoomLevel = ZOOM_DEFAULT;             // whole step; the camera gets it x dpr
  private unread = 0;                           // messages that arrived unseen
  private handUp = false;                       // my hand, broadcast to the room
  private meetGridKey = "";                     // last drawn meeting grid, to skip redraws
  private viewMode: "space" | "call" = "space";
  private meetPanelKey = "";                    // last rendered occupancy, to skip redraws
  private meetPanelAt = 0;
  private walkable: boolean[][] = [];           // tiles with no wall and no solid prop
  private path: { x: number; y: number }[] = []; // remaining click-to-move waypoints
  private moveMarker?: Phaser.GameObjects.Arc;
  private myUserId = "";                        // "" while a guest, or before the roster arrives
  private dmOpen = "";                          // the account whose thread is on screen
  private dmUnread = 0;
  private notifs: { icon: string; title: string; body: string; at: number; seen: boolean; go?: () => void }[] = [];
  private cardFor = "";                         // sessionId the open person card belongs to
  private cardTimer?: number;                   // pending open (hover) or close (leave)
  private following = "";                       // sessionId the camera is trailing, "" for me
  private dnd = false;                          // hearing nobody, on purpose                       // sessionId the camera is trailing, "" for me
  private panning = false;                      // a drag is moving the camera right now
  private cameraFree = false;                   // camera let go of the player to be dragged
  private deskClaimAt = 0;                      // scene time of my last claim (grace window for state reconcile)
  private toastTimer?: number;                  // pending hide timer for the DOM toast
  private myStatus = "online";                  // presence broadcast to peers
  private lastActiveAt = 0;                     // last real user input (for AFK)
  private statusCheckAt = 0;                    // throttle for recomputing my status
  private micEverOn = false;                    // muted only counts once you've actually unmuted
  private myMicOn = false;                      // last mic state sent to the room
  private deskPlates = new Map<string, Phaser.GameObjects.Container>(); // deskId -> owner nameplate
  private sitting = false;
  private satChair?: Phaser.GameObjects.Image;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private facing = "down"; // one of 8: down/up/left/right/down-right/down-left/up-right/up-left
  /**
   * Every chair on the map, so sitting can find the nearest one.
   *
   * A plain list now. Chairs used to be selectable and turnable, which is why
   * they also carried a style prefix and a tint — all of that is gone, and with
   * it the reason a chair listened for the mouse at all.
   */
  private chairs: Phaser.GameObjects.Image[] = [];
  private room?: Room;
  private mySessionId = "";
  private remotes = new Map<string, Remote>();
  /** the area I am standing in, remembered so entering one can be announced once */
  private myArea?: PrivateArea;
  /**
   * What I may do in this space: owner, admin, member or guest.
   *
   * Only used to decide what to OFFER. Every rule it stands in for is enforced
   * again by the server, which is the copy that matters — this one exists so a
   * person is not shown a button that will be refused.
   */
  private myRole = "member";
  /** every booking the calendar panel last saw, for the plates and the reminders */
  private bookings: Booking[] = [];
  /** bookings already reminded about, so a poll every two minutes reminds once */
  private reminded = new Set<string>();
  private calPanel?: { refresh: () => Promise<void>; bookRoom: (roomId: string) => void };
  /** every area label on this map, so a booking can be written over its door */
  private areaLabels = new Map<string, Phaser.GameObjects.Text>();
  /** locked rooms this visit has been let into, by area id */
  private admitted = new Set<string>();
  /** the sticker the next click on the floor will leave, if any */
  private armedSticker = "";
  /** what is drawn for each sticker in room state, so removals can be undrawn */
  private stickerArt = new Map<string, Phaser.GameObjects.Text>();
  /** the last place I stood that I was allowed to stand in */
  private lastAllowed?: { x: number; y: number };
  /** the locked room I am being turned away from, if any */
  private atDoor?: PrivateArea;
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
    // props may name a folder ("office/cs-desk"); bare keys come from furniture/
    const items = new Set(FURNITURE.map((f) => f[0]));
    const loadProp = (key: string, fallback: string) => {
      const { folder, file } = propPath(key, fallback);
      this.load.image(key, `/assets/${folder}/${file}.png`);
    };
    items.forEach((k) => loadProp(k, "furniture"));
    new Set(DECOR.map((d) => d[0])).forEach((k) => loadProp(k, "decor"));
    new Set(OUTDOOR.map((o) => o[0])).forEach((k) => loadProp(k, "outdoor"));
    new Set(DECALS.map((d) => d[0])).forEach((k) => loadProp(k, "outdoor"));

    // A chair is loaded facing the way the map places it, and no other way. The
    // seven other directions of every placed style used to be fetched as well,
    // because a chair could be turned in-game — around a hundred images for a
    // map with eight chair styles on it.
  }

  create() {
    const worldW = COLS * TILE;
    const worldH = ROWS * TILE;

    // floor zone -> floors-atlas index, defined by the theme
    const floorAt = (x: number, y: number) => THEME.floorAt(x, y);
    const floorData: number[][] = [];
    for (let y = 0; y < ROWS; y++) {
      const row: number[] = [];
      for (let x = 0; x < COLS; x++) row.push(floorAt(x, y));
      floorData.push(row);
    }
    const floorMap = this.make.tilemap({ data: floorData, tileWidth: TILE, tileHeight: TILE });
    floorMap.createLayer(0, floorMap.addTilesetImage("floors")!, 0, 0)!.setDepth(-1000);

    // --- private areas: a tinted panel and a label, over the floor ---
    // Drawn rather than merely enforced. The audio rule is invisible by nature,
    // so the only way somebody learns where a conversation stops carrying is if
    // the map says so before they walk in.
    for (const a of PRIVATE_AREAS) {
      const px = a.x0 * TILE, py = a.y0 * TILE;
      const w = (a.x1 - a.x0 + 1) * TILE, h = (a.y1 - a.y0 + 1) * TILE;
      // A locked room is drawn warmer and outlined harder than an open one, so
      // "you cannot walk in there" is visible before you try to.
      const tint = a.locked ? 0xd3564f : 0x2bb3a3;
      const g = this.add.graphics().setDepth(-950);
      g.fillStyle(tint, a.locked ? 0.1 : 0.07).fillRect(px, py, w, h);
      g.lineStyle(a.locked ? 1.5 : 1, tint, a.locked ? 0.6 : 0.35).strokeRect(px + 0.5, py + 0.5, w - 1, h - 1);
      const plate = this.add.text(px + 5, py + 3, (a.locked ? "🔐 " : "🔒 ") + t(a.label), {
        fontFamily: "monospace", fontSize: "9px", color: a.locked ? "#a83c36" : "#2bb3a3",
      }).setAlpha(0.85).setDepth(-949).setResolution(3);
      // kept, because what the room is booked for gets written into it
      this.areaLabels.set(a.id, plate);
    }

    // --- walls: perimeter + partitions, defined by the theme ---
    const walls = THEME.walls();
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
    for (const [k, tx, ty, solid, scale] of FURNITURE) {
      const px = tx * TILE + TILE / 2;
      const py = ty * TILE + TILE / 2;
      const s = scale ?? 1;
      if (solid) {
        const img = solids.create(px, py, k) as Phaser.Physics.Arcade.Sprite;
        img.setScale(s).setDepth(py);
        img.refreshBody(); // after setScale, so the body matches what is drawn
        const desk = DESKS.find((d) => d.x === tx && d.y === ty);
        if (desk) {
          img.setInteractive({ useHandCursor: true });
          img.on("pointerdown", () => this.claimDesk(desk.id));
        }
      } else {
        const spr = this.add.image(px, py, k).setScale(s).setDepth(k.startsWith("rug") ? -900 : py);
        // Somewhere to sit. Not interactive: a chair takes no clicks, so
        // clicking one walks you to it, which is what you wanted anyway.
        if (k.includes("chair") || k === "stool" || k.includes("sofa") || k.includes("bean-bag")) {
          this.chairs.push(spr);
        }
      }
    }

    // --- flat grass decals (flowers / clover) drawn just above the floor ---
    for (const [k, tx, ty] of DECALS) {
      this.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, k).setDepth(-800);
    }

    // --- outdoor props (trees / fountain / benches / signs) on the grass ring ---
    // 0.5, not 0.6: halving keeps the pixel grid (each drawn pixel comes from a
    // whole 2x2 block), where 0.6 lands source pixels between screen pixels
    const outdoorScale = (k: string) => (/planter/.test(k) ? 0.5 : 1); // shrink bulky planters
    /**
     * Greenery standing behind the building has to be drawn behind its wall.
     *
     * Props carry their own depth (their pixel y) while the wall layer carries a
     * single fixed one, so a prop anywhere below that value paints straight over
     * a wall. The trees and shrubs along the top of every map are wider than the
     * tile they sit on, and what spilled over the wall was greenery across the
     * wall band — which reads as a hole in the room rather than a plant behind it.
     * The give-away is a wall directly to the prop's south: that only happens when
     * the prop is outside, north of the building. Anything standing to the south
     * of a wall is in front of the building and keeps its own depth.
     */
    const behindTheWall = (tx: number, ty: number) => isWall(Math.round(tx), Math.round(ty) + 1);
    for (const [k, tx, ty, solid] of OUTDOOR) {
      const px = tx * TILE + TILE / 2;
      const py = ty * TILE + TILE / 2;
      // below the wall layer's 50, still above the floor's -1000, and ordered
      // among themselves the same way
      const depth = behindTheWall(tx, ty) ? py - 500 : py;
      const s = outdoorScale(k);
      if (solid) {
        const img = solids.create(px, py, k) as Phaser.Physics.Arcade.Sprite;
        img.setScale(s).setDepth(depth);
        img.refreshBody();
        // Collide with the base only, not the whole sprite. These are tall props
        // you should be able to walk behind, and the 4x4 fountain's full body
        // reached two tiles up into the building's front doorway and sealed the
        // only way outdoors — with the keys as much as with click-to-move.
        const body = img.body as Phaser.Physics.Arcade.StaticBody;
        const bh = Math.min(img.displayHeight, TILE);
        body.setSize(img.displayWidth, bh);
        body.position.set(img.x - img.displayWidth / 2, img.y + img.displayHeight / 2 - bh);
        body.updateCenter();
      } else {
        this.add.image(px, py, k).setScale(s).setDepth(depth);
      }
    }

    // --- decor overlays (windows / art / signage) drawn on top of walls ---
    // halved so wall decor sits proportionally on the wall instead of filling a
    // whole tile; 0.5 rather than 0.6 keeps it on the pixel grid
    for (const [k, tx, ty] of DECOR) {
      this.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, k)
        .setScale(0.5)
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
    // derive click-to-move's grid from the very bodies the player collides with,
    // so a route can never be planned through something that will block it
    this.walkable = this.buildWalkable(walls, solids);

    // my own name above my head (same tag style as remote players)
    this.refreshMyLabel();

    // --- camera ---
    this.physics.world.setBounds(0, 0, worldW, worldH);
    this.cameras.main.setBounds(0, 0, worldW, worldH);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.setZoom(ZOOM_DEFAULT); // via the helper so the dpr multiplier applies
    // the fill floor depends on the viewport, so re-apply it when that changes
    this.scale.on("resize", () => this.setZoom(this.zoomLevel));

    // --- input: movement ---
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys("W,A,S,D") as Record<string, Phaser.Input.Keyboard.Key>;

    // click empty floor to walk there. Tracked from pointerdown to pointerup so a
    // drag of the map never also sends the avatar off.
    let downAt: { x: number; y: number; onObject: boolean; scrollX: number; scrollY: number } | null = null;
    // far enough that a shaky click is still a click, short enough that a drag
    // feels immediate
    const PAN_START = 6;

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      const hits = this.input.hitTestPointer(p);
      // any hit means a desk or an object owns this click and handles it itself
      const cam = this.cameras.main;
      // A person is not furniture: their sprite listens for the mouse so the
      // card can open, but a click through them should still walk there.
      const solid = hits.filter((o) => !this.isRemoteSprite(o));
      downAt = { x: p.x, y: p.y, onObject: solid.length > 0, scrollX: cam.scrollX, scrollY: cam.scrollY };
    });

    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      const from = downAt;
      downAt = null;
      if (!from || from.onObject || p.button !== 0) return;
      if (Math.hypot(p.x - from.x, p.y - from.y) > 6) return; // a drag, not a click
      // an armed sticker owns the next click: walking there instead would be a
      // button that appears to do nothing
      if (this.armedSticker) {
        this.room?.send("sticker", { emoji: this.armedSticker, x: Math.round(p.worldX), y: Math.round(p.worldY) });
        this.armSticker("");
        return;
      }
      this.walkTo(p.worldX, p.worldY);
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!p.isDown || !downAt || downAt.onObject) return;
      const dx = p.x - downAt.x, dy = p.y - downAt.y;
      if (!this.panning && Math.hypot(dx, dy) <= PAN_START) return;
      const cam = this.cameras.main;
      if (!this.panning) {
        // The camera has to let go before it can be moved: while it is following,
        // it rewrites its own scroll every frame and a drag would be undone as
        // fast as it was made.
        this.panning = true;
        this.cameraFree = true;
        cam.stopFollow();
        this.game.canvas.style.cursor = "grabbing";
      }
      // Screen pixels over zoom: one art pixel covers zoom of them, so dividing
      // keeps the map moving exactly with the hand at any zoom level. Phaser
      // clamps to the camera bounds, so the drag stops at the edge of the map.
      cam.scrollX = downAt.scrollX - dx / cam.zoom;
      cam.scrollY = downAt.scrollY - dy / cam.zoom;
    });

    // let go anywhere, including outside the canvas, or the cursor stays a fist
    const endPan = () => {
      if (!this.panning) return;
      this.panning = false;
      this.game.canvas.style.cursor = "";
    };
    this.input.on("pointerup", endPan);
    this.input.on("pointerupoutside", endPan);
    this.input.on("wheel", (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      this.zoomBy(dy > 0 ? -1 : 1); // scroll = zoom the camera, one whole step
    });
    this.input.keyboard!.on("keydown-E", () => {
      if (document.activeElement instanceof HTMLInputElement) return; // typing
      if (this.nearInteractive) void this.activateInteractive(this.nearInteractive);
    });
    this.input.keyboard!.on("keydown-F", () => {
      if (document.activeElement instanceof HTMLInputElement) return; // typing
      this.toggleSit();
    });
    this.input.keyboard!.on("keydown-M", () => this.setZoom(ZOOM_MIN)); // zoom out fully
    this.setupInputFocusGuard();
    this.setupPresence();
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
    // desk ids belong to a layout: one claimed before the theme changed no
    // longer exists, and keeping it would show a nameplate on nothing
    this.myDesk = desk && DESKS.some((d) => d.id === desk) ? desk : "";
    if (desk && !this.myDesk) this.saveDesk("");
    if (this.player) this.refreshMyLabel();
    if (this.player) void this.applyAvatarBody();
    if (this.created) void this.connectMultiplayer();
    else this.pendingStart = true;
  }

  /**
   * The hitbox, in the frame's own pixels.
   *
   * It used to be a small pad at the feet, which let the character walk forward
   * until those feet touched a wall's base — putting four fifths of the drawn
   * body on top of the wall band (more than a whole tile for the tall preset).
   * Standing against the meeting room's top wall therefore looked like standing
   * outside the room.
   *
   * The box now runs from high on the body down to the feet, so a wall stops the
   * character with only their head over its band. It is capped to stay inside one
   * tile: the click-to-move grid marks whole tiles walkable, and a box larger
   * than a tile would make squares it calls walkable impossible to stand on.
   */
  private bodyBox(frameW: number, frameH: number, scale: number) {
    const FEET_PAD = 2;        // world px between the box's bottom and the drawn feet
    const HEAD_OVER_WALL = 8;  // world px of the sprite left free to overlap a wall band
    const MAX_BOX = TILE - 4;  // never larger than the tile it stands on
    const drawn = frameH * scale;
    const bottom = drawn / 2 - FEET_PAD;                                  // world, from the sprite centre
    const top = Math.max(-drawn / 2 + HEAD_OVER_WALL, bottom - MAX_BOX);  // world
    return {
      width: Math.max(10, Math.round(8 / scale)),                         // frame px; ~8px on screen
      height: Math.round((bottom - top) / scale),
      offsetY: Math.round(top / scale + frameH / 2),
    };
  }

  private async applyAvatarBody() {
    if (isLpc(this.myAvatar)) {
      const key = await this.ensureLpc(this.myAvatar);
      if (key && this.player) {
        this.player.setTexture(key, this.idleFrameFor(this.myAvatar, this.facing));
        this.player.setScale(LPC_SCALE);
        const b = this.bodyBox(64, 64, LPC_SCALE);
        this.player.body!.setSize(b.width, b.height).setOffset((64 - b.width) / 2, b.offsetY);
      }
      return;
    }
    const a = AVATARS[this.myAvatar] ?? AVATARS["1"];
    this.player.setScale(PRESET_SCALE);
    this.player.setTexture(a.tex, 0);
    const b = this.bodyBox(a.fw, a.fh, PRESET_SCALE);
    this.player.body!.setSize(b.width, b.height).setOffset((a.fw - b.width) / 2, b.offsetY);
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
          // per-workspace LiveKit room, otherwise audio/video would carry across workspaces
          `${HTTP_URL}/livekit/token?room=${encodeURIComponent("office-" + WORKSPACE)}&identity=${this.mySessionId}&name=${encodeURIComponent(name)}`
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
      // `workspace` is filterBy'd server-side (own room per workspace); the token
      // lets the server check membership before letting us in
      const room = await client.joinOrCreate("office", {
        workspace: WORKSPACE,
        token: localStorage.getItem("nexspace-token") ?? "",
        // a guest pass from ?g= — admits a named visitor even to a space that is
        // otherwise closed to guests
        guest: GUEST_CODE,
        name: this.myName,
        avatar: this.myAvatar,
      });
      this.room = room;
      this.mySessionId = room.sessionId;
      void this.loadChatHistory();
      void this.refreshDmCount();
      console.log(`[nexspace] joined room ${room.roomId} as ${room.sessionId}`);
      setTimeout(() => console.log(`[nexspace] room ${room.roomId}: ${room.state.players.size} online`), 1200);
      const $ = getStateCallbacks(room);

      // Said before anything else is read from the state: until the room knows,
      // this player counts as being on the landing map, and two people on
      // different floors would briefly hear each other.
      room.send("map", MAP);

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
          // Somebody on another floor stays in the roster — they are in this
          // space, and messages and "come over" still reach them — but they get
          // no sprite, because they are not in this room to be walked up to.
          if (this.onMyMap(player)) this.addRemote(sessionId, player);
          $(player).onChange(() => {
            // They walked through a portal, in one direction or the other
            const here = this.onMyMap(player);
            if (here !== this.remotes.has(sessionId)) {
              if (here) this.addRemote(sessionId, player);
              else this.removeRemote(sessionId);
              this.refreshRoster();
              this.refreshDeskPlates();
            }
            const r = this.remotes.get(sessionId);
            if (!r) return;
            r.tx = player.x; r.ty = player.y; r.dir = player.dir; r.moving = player.moving;
            if (player.avatar && player.avatar !== r.avatar) this.changeRemoteAvatar(sessionId, player.avatar);
            if (player.desk !== r.deskId) { r.deskId = player.desk; this.refreshDeskPlates(); }
            if (player.status !== r.status) {
              r.status = player.status;
              this.setTagStatus(r.label, player.status);
              this.refreshDeskPlates(); // their desk plate mirrors their status
              this.refreshRoster();
            }
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

      // the server refused a desk claim — undo the optimistic local change
      room.onMessage("deskDenied", () => {
        this.myDesk = "";
        this.saveDesk("");
        this.refreshDeskPlates();
        this.toast(t("สิทธิ์ผู้เยี่ยมชมจองโต๊ะไม่ได้ — ขอให้ผู้ดูแลตั้งคุณเป็นสมาชิก"), "warn");
      });
      room.onMessage("chat", (msg: { from: string; text: string }) => this.showBubble(msg.from, msg.text));
      room.onMessage("roomchat", (msg: { from: string; name: string; text: string; attach?: Attach }) =>
        this.appendChatLog(msg.from, msg.name, msg.text, msg.attach));
      room.onMessage("dm", (msg: { from: string; to: string; name: string; text: string }) => this.onDm(msg));
      room.onMessage("ping", (msg: { from: string; name: string; x: number; y: number }) => this.onPing(msg));
      room.onMessage("wave", (msg: { from: string; name: string }) => this.onWave(msg));

      /**
       * Somebody with the standing to do it has ended this visit.
       *
       * Said plainly and by name. Being disconnected with no explanation is
       * indistinguishable from the network failing, and a person who thinks the
       * network failed will reconnect immediately.
       */
      room.onMessage("kicked", (msg: { by: string }) => {
        this.webrtc?.dispose();
        alert(msg.by
          ? t("{name} เชิญคุณออกจากพื้นที่นี้").replace("{name}", msg.by)
          : t("คุณถูกเชิญออกจากพื้นที่นี้"));
        location.href = location.pathname;
      });

      // a gesture, played on whoever made it
      room.onMessage("emote", (msg: { from: string; kind: string }) => this.playEmote(msg.from, msg.kind));

      $(room.state).stickers.onAdd((st: any, id: string) => {
        this.drawSticker(id, st);
        $(st).onChange(() => this.drawSticker(id, st));
      });
      $(room.state).stickers.onRemove((_st: any, id: string) => {
        this.stickerArt.get(id)?.destroy();
        this.stickerArt.delete(id);
      });

      // somebody is at the door of the locked room I am in
      room.onMessage("knock", (msg: { from: string; name: string; area: string; label: string }) =>
        this.onKnock(msg));

      // the door was answered, one way or the other
      room.onMessage("admitted", (msg: { area: string; label: string; ok: boolean; by: string }) => {
        if (!msg.ok) {
          this.toast(t("{name} ยังไม่สะดวก").replace("{name}", msg.by || "?"), "warn");
          return;
        }
        this.admitted.add(msg.area);
        this.atDoor = undefined;
        this.closeNudge();
        // silent when nobody let us in, because nobody did: an empty room opens
        // on its own and saying so every time would be noise
        if (msg.by) this.toast(t("{name} เปิดให้เข้า {area}").replace("{name}", msg.by).replace("{area}", t(msg.label)), "success");
      });

      room.onMessage("knocked", (msg: { label: string; waiting: number }) =>
        this.toast(t("เคาะแล้ว — รออีก {n} คนในห้องรับ").replace("{n}", String(msg.waiting)), "info"));
      room.onMessage("waveSent", (msg: { name: string }) =>
        this.toast(t("โบกมือให้ {name} แล้ว").replace("{name}", msg.name), "info"));
      room.onMessage("pingRefused", (msg: { name: string }) =>
        this.toast(t("{name} กำลังห้ามรบกวน — ลองส่งข้อความแทน").replace("{name}", msg.name), "warn"));
      room.onMessage("pingSent", (msg: { name: string }) =>
        this.toast(t("เรียก {name} มาแล้ว").replace("{name}", msg.name), "info"));
      // The room refuses a second ask too soon after the first. Pressing twice
      // used to produce silence, which reads as a broken button.
      room.onMessage("pingTooSoon", (msg: { name: string; wait: number }) =>
        this.toast(t("เพิ่งเรียก {name} ไปเมื่อครู่ — รออีก {n} วิ")
          .replace("{name}", msg.name).replace("{n}", String(msg.wait)), "warn"));
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
        // a device that will not open used to fail into console.warn, so the
        // button simply stayed dark and nobody knew why
        this.webrtc.onError = (msg) => this.toast(msg, "warn");
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
      const msg = String((e as Error)?.message ?? "");
      if (msg.includes("members-only")) {
        this.toast(t("workspace นี้เปิดให้เฉพาะสมาชิก — ขอให้เจ้าของเชิญคุณก่อน"), "warn");
      } else if (msg.includes("workspace-not-found")) {
        this.toast(t("ไม่พบ workspace นี้ — ตรวจสอบลิงก์เชิญอีกครั้ง"), "warn");
      }
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

    // Three things that look alike and are not: something you SAY, something
    // your avatar DOES, and something you LEAVE BEHIND. They share a popover
    // because that is where a person looks for all three, and they are labelled
    // because a reaction that vanishes and a sticker that stays are not the
    // same offer.
    const pop = document.getElementById("emoji-pop") as HTMLElement | null;
    if (emoji && pop) {
      const hide = () => { pop.style.display = "none"; };
      const row = (label: string, items: string[], make: (v: string) => HTMLElement) => {
        const head = document.createElement("div");
        head.className = "ep-head";
        head.textContent = t(label);
        pop.appendChild(head);
        const box = document.createElement("div");
        box.className = "ep-row";
        for (const v of items) box.appendChild(make(v));
        pop.appendChild(box);
      };

      pop.innerHTML = "";
      row("พูดออกไป", ["👍", "❤️", "😂", "🎉", "👋", "😮"], (e) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = e;
        b.onclick = () => { this.room?.send("chat", { text: e }); hide(); };
        return b;
      });
      row("ท่าทาง", Object.keys(OfficeScene.EMOTES), (kind) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = OfficeScene.EMOTES[kind].icon;
        b.title = t(EMOTE_NAMES[kind] ?? kind);
        b.setAttribute("aria-label", b.title);
        b.onclick = () => { this.room?.send("emote", kind); hide(); };
        return b;
      });
      row("สติกเกอร์ — เลือกแล้วคลิกบนพื้น", STICKER_SET, (e) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = e;
        b.dataset.sticker = e;
        b.onclick = () => { this.armSticker(this.armedSticker === e ? "" : e); hide(); };
        return b;
      });

      emoji.onclick = () => { pop.style.display = pop.style.display === "flex" ? "none" : "flex"; };
      // Escape puts a held sticker away — the key that closes everything else here
      this.input.keyboard!.on("keydown-ESC", () => { if (this.armedSticker) this.armSticker(""); });
      document.getElementById("place-cancel")?.addEventListener("click", () => this.armSticker(""));
    }

    // leave the room
    if (leave) leave.onclick = () => {
      this.webrtc?.dispose();
      this.room?.leave();
      // drop the ?w= slug so the app opens the spaces dashboard rather than a room
      location.href = location.pathname;
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
    const views: Record<string, string> = {
      people: "view-people", dm: "view-dm", notif: "view-notif", chat: "view-chat", cal: "view-cal",
    };
    const titles: Record<string, string> = {
      people: "NexSpace", dm: t("ข้อความส่วนตัว"), notif: t("การแจ้งเตือน"),
      chat: t("แชตห้องรวม"), cal: t("ปฏิทินห้องประชุม"),
    };
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
    document.getElementById("rail-chat")?.addEventListener("click", () => { showView("chat"); this.markChatSeen(); });
    document.getElementById("rail-dm")?.addEventListener("click", () => { showView("dm"); this.showDmList(); });
    document.getElementById("rail-cal")?.addEventListener("click", () => showView("cal"));
    document.getElementById("rail-notif")?.addEventListener("click", () => { showView("notif"); this.renderNotifs(true); });
    document.getElementById("nf-clear")?.addEventListener("click", () => { this.notifs = []; this.renderNotifs(true); });
    document.getElementById("nf-sound")?.addEventListener("click", () => {
      const on = localStorage.getItem("nexspace-sound") !== "off";
      localStorage.setItem("nexspace-sound", on ? "off" : "on");
      this.refreshSoundButton();
      if (!on) this.blip();                       // let them hear what they just turned on
    });
    this.refreshSoundButton();

    document.getElementById("btn-dnd")?.addEventListener("click", () => this.setDnd(!this.dnd));
    document.getElementById("nudge-x")?.addEventListener("click", () => this.closeNudge());
    // Escape closes it too. A panel that waits indefinitely needs a way out that
    // is not a small ✕ in a corner, and Escape is the key that dismisses
    // everything else in this room.
    this.input.keyboard!.on("keydown-ESC", () => this.closeNudge());

    const card = document.getElementById("person-card");
    // moving from the person onto the card must not count as leaving
    card?.addEventListener("mouseenter", () => window.clearTimeout(this.cardTimer));
    card?.addEventListener("mouseleave", () => this.scheduleCardClose());
    document.getElementById("pc-cancel")?.addEventListener("click", () => this.closePersonCard());
    document.getElementById("pc-save")?.addEventListener("click", () => void this.saveMyProfile());
    this.showView = showView;

    document.getElementById("dm-back")?.addEventListener("click", () => this.showDmList());
    const dmInput = document.getElementById("dm-input") as HTMLInputElement | null;
    const dmFile = this.wireAttach({
      btn: "dm-attach", file: "dm-file", strip: "dm-pending", drop: "dm-thread",
    });
    const sendDm = () => {
      const text = dmInput?.value.trim() ?? "";
      const attach = dmFile.held();
      if ((!text && !attach) || !this.dmOpen || !this.room) return;
      this.room.send("dm", { to: this.dmOpen, text, ...(attach ? { attach: attach.id } : {}) });
      if (dmInput) dmInput.value = "";
      dmFile.clear();
    };
    document.getElementById("dm-send")?.addEventListener("click", sendDm);
    dmInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") sendDm(); });
    this.mountCalendar();

    // the gear opens the preferences dialog (members, space settings)
    void this.buildMapSwitcher();
    const prefs = setupPrefsModal(WORKSPACE, IS_DEFAULT_WORKSPACE, () => {
      // reopening is the only way the change reaches a track that is already live
      void (this.webrtc as { refreshMic?: () => Promise<void> } | undefined)?.refreshMic?.();
    });
    document.getElementById("rail-settings")?.addEventListener("click", () => prefs.open("members"));
    document.getElementById("sb-close")?.addEventListener("click", () => sidebar?.classList.add("closed"));
    document.getElementById("sb-search")?.addEventListener("input", () => this.refreshRoster());

    // The room's markup is swapped by translateDom; these are the parts the scene
    // draws itself, including the name tag over my own head.
    onLangChange(() => {
      this.refreshRoster();
      this.refreshDeskPlates();
      this.refreshMyLabel();
      this.meetPanelKey = "";      // force the meeting tiles to rebuild
    });

    // sidebar shows the workspace's display name (falls back to the slug)
    const title = document.getElementById("sb-title");
    /** the meeting composer names the space, the way the sidebar header does */
    const nameTheComposer = (name: string) => {
      const box = document.getElementById("meet-chat-input") as HTMLInputElement | null;
      if (box && name) box.placeholder = t("ส่งข้อความถึง {name}", { name });
    };
    if (title) {
      // the default space has no stored name — always show the product name there
      title.textContent = (!IS_DEFAULT_WORKSPACE && localStorage.getItem(wsKey("nexspace-ws-name")))
        || workspaceLabel();
      nameTheComposer(title.textContent);
      if (!IS_DEFAULT_WORKSPACE) {
        fetch(`${AUTH_API}/workspaces/${encodeURIComponent(WORKSPACE)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!d?.workspace) return;
            // what this account may do here, used only to decide what to offer
            this.myRole = String(d.workspace.role || "member");
            if (d.workspace.name) {
              title.textContent = d.workspace.name;
              nameTheComposer(d.workspace.name);
              localStorage.setItem(wsKey("nexspace-ws-name"), d.workspace.name);
            }
            // The layout is no longer guessed here and then corrected by a
            // reload: mapSource asked the server before this scene existed.
          })
          .catch(() => {});
      }
    }

    // invite: copy the room link
    document.getElementById("btn-invite")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-invite") as HTMLButtonElement;
      const link = inviteLink();
      try { await navigator.clipboard.writeText(link); btn.textContent = t("✓ คัดลอกลิงก์แล้ว!"); }
      catch { btn.textContent = link; }
      setTimeout(() => (btn.textContent = t("＋ เชิญ / คัดลอกลิงก์")), 2000);
    });

    // room-wide chat
    const input = document.getElementById("room-chat-input") as HTMLInputElement | null;
    const roomFile = this.wireAttach({
      btn: "room-chat-attach", file: "room-chat-file",
      strip: "room-chat-pending", drop: "view-chat",
    });
    const send = () => {
      const text = input?.value.trim() ?? "";
      const attach = roomFile.held();
      // a file on its own is a message; an empty box with no file is not
      if ((!text && !attach) || !this.room) return;
      this.room.send("roomchat", { text, ...(attach ? { attach: attach.id } : {}) });
      if (input) input.value = "";
      roomFile.clear();
    };
    document.getElementById("room-chat-send")?.addEventListener("click", send);
    input?.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") send(); });

    // the same conversation, from the meeting view's own composer
    const meetInput = document.getElementById("meet-chat-input") as HTMLInputElement | null;
    const meetFile = this.wireAttach({
      btn: "meet-chat-attach", file: "meet-chat-file",
      strip: "meet-chat-pending", drop: "meet-chat",
    });
    const meetSend = () => {
      const text = meetInput?.value.trim() ?? "";
      const attach = meetFile.held();
      if ((!text && !attach) || !this.room) return;
      this.room.send("roomchat", { text, ...(attach ? { attach: attach.id } : {}) });
      if (meetInput) meetInput.value = "";
      meetFile.clear();
    };
    document.getElementById("meet-chat-send")?.addEventListener("click", meetSend);
    // stopPropagation so WASD in a message does not walk the avatar across the room
    meetInput?.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") meetSend(); });

    const chat = (open: boolean) => {
      document.getElementById("call-view-overlay")?.classList.toggle("chat-open", open);
      if (open) meetInput?.focus();
    };
    document.getElementById("meet-chat-close")?.addEventListener("click", () => chat(false));
    document.getElementById("meet-chat-open")?.addEventListener("click", () => { chat(true); this.markChatSeen(); });
    document.getElementById("meet-chat-people")?.addEventListener("click", () => {
      // the roster lives in the sidebar; the meeting view is a place to glance at
      // the count, not a second copy of it
      this.setViewMode("space");
      document.getElementById("sidebar")?.classList.remove("closed");
      document.getElementById("rail-people")?.click();
    });

    // one chat button for both views: in the meeting view it opens the panel
    // beside the people, on the map the sidebar's chat — the same conversation
    // either way
    document.getElementById("btn-chat")?.addEventListener("click", () => {
      if (this.viewMode === "call") {
        const overlay = document.getElementById("call-view-overlay");
        const open = !overlay?.classList.contains("chat-open");
        overlay?.classList.toggle("chat-open", open);
        if (open) (document.getElementById("meet-chat-input") as HTMLInputElement | null)?.focus();
      } else {
        showView("chat");
        (document.getElementById("room-chat-input") as HTMLInputElement | null)?.focus();
      }
      this.markChatSeen();
    });

    // a raised hand: a request to speak that stays up until it is lowered
    document.getElementById("btn-hand")?.addEventListener("click", () => {
      this.handUp = !this.handUp;
      document.getElementById("btn-hand")?.classList.toggle("active", this.handUp);
      this.room?.send("hand", this.handUp);
      this.meetGridKey = ""; this.meetPanelKey = "";   // redraw with the badge
    });
  }

  /**
   * The room has one conversation. It is drawn in the sidebar and, while the
   * meeting view is open, down the side of that too — the same messages in both,
   * so nothing said in the meeting is missing from the room afterwards.
   */
  /**
   * Whether the conversation is in front of the person right now.
   *
   * Two places show it — the sidebar on the map, the panel in the meeting view —
   * and either one counts. Anything that arrives while neither is showing is what
   * the badge is for.
   */
  private chatIsVisible(): boolean {
    if (this.viewMode === "call") {
      return !!document.getElementById("call-view-overlay")?.classList.contains("chat-open");
    }
    const sidebar = document.getElementById("sidebar");
    const view = document.getElementById("view-chat") as HTMLElement | null;
    return !!sidebar && !sidebar.classList.contains("closed") && !!view && !view.hidden;
  }

  /** the count on the control bar's chat button */
  private refreshUnread() {
    const badge = document.getElementById("chat-unread");
    if (!badge) return;
    badge.textContent = this.unread > 9 ? "9+" : String(this.unread);
    badge.hidden = this.unread === 0;
  }

  /** called wherever the chat becomes visible, so the count cannot go stale */
  private markChatSeen() {
    if (!this.unread) return;
    this.unread = 0;
    this.refreshUnread();
  }

/**
   * The file half of a composer.
   *
   * Three composers want the same behaviour — the room, the meeting, and a
   * private thread — and the behaviour is fiddlier than it looks: a file can
   * arrive from a button, a paste, or a drop, it has to be visible before it is
   * sent so that it can be taken back, and the send has to know whether one is
   * waiting. So it is written once and handed the three ids.
   *
   * The upload happens on choosing, not on sending. By the time somebody has
   * finished typing a sentence about a screenshot, the screenshot is already
   * up, and pressing send is instant instead of a pause of unknown length.
   */
/**
   * The room calendar, and the two things it feeds.
   *
   * The panel owns the list; the scene borrows it for the plates on the map and
   * for the reminder. Keeping one copy means a booking cancelled in the sidebar
   * stops appearing over the door without any second fetch.
   */
  private mountCalendar() {
    const host = document.getElementById("view-cal");
    if (!host) return;
    this.calPanel = mountCalendarPanel({
      host,
      api: AUTH_API,
      workspace: WORKSPACE,
      mapSlug: MAP_KEY,
      token: localStorage.getItem("nexspace-token") ?? undefined,
      guest: GUEST_CODE || undefined,
      // Only the rooms on the map being looked at. Booking a room on another
      // floor from here would be booking something you cannot see.
      rooms: () => PRIVATE_AREAS.map((a) => ({ id: a.id, label: t(a.label) })),
      canManage: () => this.myRole === "owner" || this.myRole === "admin",
      canBook: () => this.myRole !== "guest",
      onChange: (all) => {
        this.bookings = all;
        this.refreshRoomPlates();
        this.checkReminders();
      },
    });
  }

  /** the booking happening in a room right now, if any */
  private bookingNow(roomId: string, at = Date.now()) {
    return this.bookings.find((b) =>
      b.mapSlug === MAP_KEY && b.roomId === roomId
      && +new Date(b.startsAt) <= at && at < +new Date(b.endsAt));
  }

  /** the next one after that */
  private bookingNext(roomId: string, at = Date.now()) {
    return this.bookings
      .filter((b) => b.mapSlug === MAP_KEY && b.roomId === roomId && +new Date(b.startsAt) > at)
      .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))[0];
  }

  /**
   * What each room is doing, written over its door.
   *
   * The point of a booking is that somebody walking up to the room can see it
   * without opening a calendar. Drawn into the same label the area already has,
   * rather than as a new object, so it moves and hides with the room.
   */
  private refreshRoomPlates() {
    const now = Date.now();
    for (const [id, label] of this.areaLabels) {
      const area = PRIVATE_AREAS.find((a) => a.id === id);
      if (!area) continue;
      const on = this.bookingNow(id, now);
      const soon = on ? undefined : this.bookingNext(id, now);
      // Only the next hour counts as "soon". Anything further away is not news
      // to somebody standing at the door.
      const near = soon && +new Date(soon.startsAt) - now < 60 * 60 * 1000 ? soon : undefined;
      label.setText(
        on ? `${t(area.label)} — ${on.title}`
          : near ? `${t(area.label)} — ${clock(near.startsAt)}`
          : t(area.label),
      );
      label.setColor(on ? "#ffd9a8" : "#ffffff");
    }
  }

  /**
   * Say something before it starts.
   *
   * Only to people who said they are coming, and only once each. The check runs
   * on the same poll the panel already does, so a meeting booked on another
   * machine still reminds this one.
   */
  private checkReminders() {
    const now = Date.now();
    const AHEAD = 5 * 60 * 1000;
    for (const b of this.bookings) {
      if (!b.imGoing || this.reminded.has(b.id)) continue;
      const inMs = +new Date(b.startsAt) - now;
      // A window, not a moment: the poll is every two minutes, so "exactly five
      // minutes before" would be missed more often than hit. Past the start is
      // excluded — a reminder for a meeting already running is not a reminder.
      if (inMs > AHEAD || inMs < -60_000) continue;
      this.reminded.add(b.id);
      const mins = Math.max(0, Math.round(inMs / 60_000));
      const line = mins > 0
        ? t("{title} เริ่มในอีก {n} นาที").replace("{title}", b.title).replace("{n}", String(mins))
        : t("{title} เริ่มแล้ว").replace("{title}", b.title);
      this.toast(line, "info");
      this.notify("📅", line, `${b.room} · ${clock(b.startsAt)}`, () => {
        this.showView?.("cal");
        // and walk them there, which is the actual next thing they wanted
        const area = PRIVATE_AREAS.find((a) => a.id === b.roomId);
        if (area) {
          const cx = ((area.x0 + area.x1) / 2) * TILE + TILE / 2;
          const cy = ((area.y0 + area.y1) / 2) * TILE + TILE / 2;
          this.walkOrJump(cx, cy);
        }
      });
    }
    this.refreshCalBadge();
  }

  /** how many of my meetings are still to come today */
  private refreshCalBadge() {
    const badge = document.getElementById("cal-soon");
    if (!badge) return;
    const now = Date.now();
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
    const mine = this.bookings.filter((b) =>
      b.imGoing && +new Date(b.endsAt) > now && +new Date(b.startsAt) <= +endOfDay).length;
    badge.textContent = String(mine);
    badge.hidden = mine === 0;
  }

  private wireAttach(ids: { btn: string; file: string; strip: string; drop: string }) {
    const btn = document.getElementById(ids.btn) as HTMLButtonElement | null;
    const file = document.getElementById(ids.file) as HTMLInputElement | null;
    const strip = document.getElementById(ids.strip) as HTMLElement | null;
    const drop = document.getElementById(ids.drop) as HTMLElement | null;
    if (!btn || !file || !strip) return { held: () => undefined as Attach | undefined, clear: () => {} };

    file.accept = ACCEPT;
    let held: Attach | undefined;
    let busy = false;

    const clear = () => {
      held = undefined;
      strip.hidden = true;
      strip.className = "att-pending";
      strip.innerHTML = "";
      file.value = "";
    };

    const show = (name: string, size: string, kind: "" | "busy" | "err", onX?: () => void) => {
      strip.hidden = false;
      strip.className = "att-pending" + (kind ? " " + kind : "");
      strip.innerHTML = "";
      const n = document.createElement("span"); n.className = "n"; n.textContent = name;
      const sz = document.createElement("span"); sz.className = "s"; sz.textContent = size;
      strip.append(n, sz);
      if (onX) {
        const x = document.createElement("button");
        x.className = "x"; x.type = "button"; x.textContent = "✕";
        x.title = t("เอาไฟล์ออก");
        x.onclick = onX;
        strip.appendChild(x);
      }
    };

    const take = async (f: File | null | undefined) => {
      if (!f || busy) return;
      busy = true;
      btn.disabled = true;
      show(f.name, t("กำลังส่ง…"), "busy");
      try {
        held = await upload(f, {
          api: AUTH_API, workspace: WORKSPACE,
          token: localStorage.getItem("nexspace-token") ?? undefined,
          guest: GUEST_CODE || undefined,
        });
        show(held.name, humanSize(held.bytes), "", clear);
      } catch (e) {
        // Said in the strip rather than as a toast: the file is part of the
        // message being written, so the complaint belongs where the message is.
        show(f.name, (e as Error).message, "err", clear);
        held = undefined;
      } finally {
        busy = false;
        btn.disabled = false;
      }
    };

    btn.addEventListener("click", () => file.click());
    file.addEventListener("change", () => void take(file.files?.[0]));

    if (drop) {
      // A paste is how a screenshot actually gets into a chat. It only counts
      // while this panel is the one being typed in, or a copied image would
      // land in whichever composer was wired first.
      drop.addEventListener("paste", (e: ClipboardEvent) => {
        const items = Array.from(e.clipboardData?.items ?? []);
        const f = items.filter((i) => i.kind === "file").map((i) => i.getAsFile())[0];
        if (f) { e.preventDefault(); void take(f); }
      });
      const stop = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); };
      drop.addEventListener("dragover", (e) => { stop(e); drop.classList.add("drop-here"); });
      drop.addEventListener("dragleave", (e) => { stop(e); drop.classList.remove("drop-here"); });
      drop.addEventListener("drop", (e) => {
        stop(e);
        drop.classList.remove("drop-here");
        void take(e.dataTransfer?.files?.[0]);
      });
    }

    return { held: () => held, clear };
  }

  private appendChatLog(from: string, name: string, text: string, attach?: Attach) {
    for (const id of ["chat-log", "meet-chat-log"]) {
      const log = document.getElementById(id);
      if (!log) continue;
      log.querySelector(".chat-empty, .mc-empty")?.remove();
      log.appendChild(this.chatLine(from === this.mySessionId, name, text, attach));
      log.scrollTop = log.scrollHeight;
    }
    if (from !== this.mySessionId && !this.chatIsVisible()) {
      this.unread++;
      this.refreshUnread();
    }
  }

  private chatLine(mine: boolean, name: string, text: string, attach?: Attach) {
    const div = document.createElement("div"); div.className = "msg";
    const who = document.createElement("span");
    who.className = "who" + (mine ? " me" : "");
    who.textContent = (mine ? t("คุณ") : name) + ":";
    div.append(who);
    // A file sent without a word is common, and " :" followed by nothing reads
    // as a message that failed to arrive.
    if (text) {
      const txt = document.createElement("span"); txt.className = "txt"; txt.textContent = " " + text;
      div.append(txt);
    }
    if (attach) div.append(attachNode(attach, AUTH_API));
    return div;
  }

  /**
   * What was said before we arrived.
   *
   * Written straight into the same panels the live messages go to, above
   * whatever is already there — a message that lands while this request is in
   * flight belongs after the history, not buried in it, and prepending gets that
   * right without any ordering bookkeeping.
   *
   * A member is recognised by their session; a visitor by the pass code in their
   * link. Anyone the API does not recognise simply gets no history, which is the
   * same silence they had before there was any.
   */
  private async loadChatHistory() {
    const guest = GUEST_CODE ? `&guest=${encodeURIComponent(GUEST_CODE)}` : "";
    const token = localStorage.getItem("nexspace-token") ?? "";
    try {
      const r = await fetch(
        `${AUTH_API}/workspaces/${encodeURIComponent(WORKSPACE)}/messages?limit=50${guest}`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} },
      );
      if (!r.ok) return;
      const d = (await r.json()) as {
        messages?: { name: string; text: string; at: string; mine: boolean; attach?: Attach }[];
      };
      const rows = d.messages ?? [];
      if (!rows.length) return;

      for (const id of ["chat-log", "meet-chat-log"]) {
        const log = document.getElementById(id);
        if (!log) continue;
        log.querySelector(".chat-empty, .mc-empty")?.remove();
        const frag = document.createDocumentFragment();
        for (const m of rows) frag.appendChild(this.chatLine(m.mine, m.name, m.text, m.attach));
        // a line the reader can stop at, so old and new are not one blur
        const mark = document.createElement("div");
        mark.className = "chat-mark";
        mark.textContent = t("ก่อนหน้านี้");
        frag.appendChild(mark);
        log.insertBefore(frag, log.firstChild);
        log.scrollTop = log.scrollHeight;
      }
    } catch (e) {
      // history is a convenience; the room works without it
      console.warn("[chat] could not load history:", e);
    }
  }

  private refreshRoster() {
    const count = this.room?.state.players.size ?? 0;
    for (const id of ["sb-count", "rail-count", "meet-chat-count"]) {
      const e = document.getElementById(id);
      if (e) e.textContent = String(count);
    }
    // the stack on the invite card is who is already here, not four stock faces
    const avas = document.getElementById("invite-avas");
    if (avas) {
      avas.innerHTML = "";
      const here = [...(this.room?.state.players as any ?? [])].map(([, p]: any) => p.name || "Guest");
      for (const name of here.slice(0, 4)) {
        const { initial, color } = this.chipParts(name);
        const sp = document.createElement("span");
        sp.style.background = color;
        sp.textContent = initial;
        sp.title = name;
        avas.appendChild(sp);
      }
      if (here.length > 4) {
        const more = document.createElement("span");
        more.className = "more";
        more.textContent = "+" + (here.length - 4);
        avas.appendChild(more);
      }
    }

    const list = document.getElementById("people");
    if (!list || !this.room) return;
    const q = (document.getElementById("sb-search") as HTMLInputElement | null)?.value.toLowerCase() ?? "";
    const rows: { name: string; self: boolean; status: string; userId: string; sessionId: string; map: string; here: boolean }[] = [];
    this.room.state.players.forEach((p: any, id: string) => {
      const self = id === this.mySessionId;
      if (self) this.myUserId = p.userId || this.myUserId;
      rows.push({
        name: p.name || "Guest", self, status: self ? this.myStatus : (p.status || "online"),
        userId: p.userId || "", sessionId: id,
        map: p.map || "", here: self || this.onMyMap(p),
      });
    });
    // People on this map first, then the other floors. Somebody two rooms away
    // is still in the space and still worth messaging, but they are not who you
    // are looking at when you glance at the list.
    rows.sort((a, b) => Number(b.self) - Number(a.self)
      || Number(b.here) - Number(a.here)
      || a.name.localeCompare(b.name));
    list.innerHTML = "";
    for (const r of rows) {
      if (q && !r.name.toLowerCase().includes(q)) continue;
      const { initial, color } = this.chipParts(r.name);
      const row = document.createElement("div"); row.className = "person";
      const chip = document.createElement("span"); chip.className = "p-chip";
      chip.style.background = color; chip.textContent = initial;
      const meta = statusMeta(r.status);
      const dot = document.createElement("i"); dot.className = "p-dot";
      dot.style.background = meta.css; chip.appendChild(dot);
      const info = document.createElement("span"); info.className = "p-info";
      const nm = document.createElement("b"); nm.textContent = r.name + (r.self ? " " + t("(คุณ)") : "");
      const st = document.createElement("small");
      // Where somebody is beats how they are when they are somewhere else: you
      // cannot walk over to an "online" that is on another floor.
      st.textContent = r.here ? t(meta.label) : `${t(meta.label)} · ${this.mapLabel(r.map)}`;
      if (!r.here) row.classList.add("elsewhere");
      info.append(nm, st); row.append(chip, info);
      row.style.cursor = "pointer";
      row.addEventListener("click", (e) => {
        // the buttons on this row have their own jobs
        if ((e.target as HTMLElement).closest(".p-act")) return;
        this.openPersonCard(r.sessionId, row);
      });
      if (!r.self) {
        const acts = document.createElement("span");
        acts.className = "p-acts";
        const act = (tip: string, svg: string, go: () => void) => {
          const b = document.createElement("button");
          b.className = "p-act";
          b.type = "button";
          b.dataset.tip = tip;
          b.setAttribute("aria-label", tip);   // the tooltip is decoration, not a label
          b.innerHTML = svg;
          b.addEventListener("click", (e) => { e.stopPropagation(); go(); });
          acts.appendChild(b);
        };

        // Waving first, because it is the smallest thing to do and the one
        // people reach for; the message is last because it is the one that
        // takes them away from the list.
        act(t("โบกมือ"),
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3.5a1.4 1.4 0 0 1 2.8 0V11"/><path d="M8.2 6a1.4 1.4 0 0 1 2.8 0v5"/><path d="M13.8 6.6a1.4 1.4 0 0 1 2.8 0V12"/><path d="M16.6 9.2a1.4 1.4 0 0 1 2.8 0v4.3a7 7 0 0 1-7 7h-.7a6 6 0 0 1-4.3-1.8L4 16.8a1.5 1.5 0 0 1 2.1-2.1L8.2 16"/></svg>',
          () => this.room?.send("wave", { to: r.sessionId }));

        act(t("ไปที่"),
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M8 12h7"/><path d="M12 8.5l3.5 3.5L12 15.5"/></svg>',
          () => {
            // On another floor there is nothing here to walk to: change floors,
            // landing where they are standing.
            if (!r.here) {
              const p: any = this.room?.state.players.get(r.sessionId);
              if (p) gotoMap(r.map, { x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) });
              return;
            }
            const them = this.remotes.get(r.sessionId)?.sprite;
            if (them) this.goTo(them.x, them.y);
            else this.toast(t("หาไม่เจอ — เขาอาจออกไปแล้ว"), "warn");
          });

        // A private thread needs an account at both ends, so this one is only
        // there when there is somewhere for a reply to arrive.
        //
        // It stays on a row that turns out to be your own second window too.
        // Hiding it there was correct and unhelpful: the row looks like anybody
        // else's, so a button that vanishes from it reads as the feature
        // breaking. openDmThread says what is going on instead.
        if (r.userId && this.myUserId) {
          act(t("ส่งข้อความ"),
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 1 1-3.6-6.9"/><path d="M4.2 19.8l1.1-3.3"/><path d="M20.5 4.5v4h-4"/></svg>',
            () => this.openDm(r.userId, r.name));
        }
        row.appendChild(acts);
      }
      list.appendChild(row);
    }
  }

  private showView?: (v: string) => void;

  /** who is in this space right now, by account — for names in a thread list */
  private nameOf(userId: string) {
    if (!this.room) return "";
    for (const [, p] of this.room.state.players as any) if (p.userId === userId) return p.name as string;
    return "";
  }

  /**
   * The list of conversations, and how much of each is new.
   *
   * Fetched rather than remembered: the unread count belongs to the account, not
   * to this tab, so someone who read a thread on their phone should not come back
   * to a badge here saying otherwise.
   */
  private async showDmList() {
    this.dmOpen = "";
    const list = document.getElementById("dm-list");
    const thread = document.getElementById("dm-thread") as HTMLElement | null;
    if (!list || !thread) return;
    thread.hidden = true;
    list.hidden = false;

    const d = await this.dmFetch<{ threads?: { peerId: string; name: string; text: string; at: string; unread: number }[] }>("");
    const threads = d?.threads ?? [];
    this.dmUnread = threads.reduce((n, t2) => n + t2.unread, 0);
    this.refreshDmBadge();

    list.innerHTML = "";
    if (!threads.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = t("ยังไม่มีข้อความส่วนตัว — เริ่มได้จากรายชื่อคน");
      list.appendChild(empty);
      return;
    }
    for (const th of threads) {
      const name = th.name || this.nameOf(th.peerId) || t("สมาชิก");
      const { initial, color } = this.chipParts(name);
      const row = document.createElement("button"); row.className = "dm-row";
      const chip = document.createElement("span"); chip.className = "p-chip";
      chip.style.background = color; chip.textContent = initial;
      const meta = document.createElement("span"); meta.className = "dm-meta";
      const b = document.createElement("b"); b.textContent = name;
      const small = document.createElement("small"); small.textContent = th.text;
      meta.append(b, small);
      row.append(chip, meta);
      if (th.unread) {
        const n = document.createElement("span"); n.className = "dm-new";
        n.textContent = th.unread > 9 ? "9+" : String(th.unread);
        row.appendChild(n);
      }
      row.addEventListener("click", () => void this.openDmThread(th.peerId, name));
      list.appendChild(row);
    }
  }

  /** one conversation, and opening it is what clears its badge */
  /**
   * Open a thread with somebody, or say why not.
   *
   * Two windows of one account list each other, so "message" on a row can point
   * at yourself. The check belongs here rather than inside the panel: switching
   * to the messages view and only then refusing takes somebody somewhere for
   * nothing.
   */
  private openDm(peerId: string, name: string) {
    if (!peerId) return;
    if (peerId === this.myUserId) {
      this.toast(t("นี่คือบัญชีของคุณเอง — ส่งข้อความหาตัวเองไม่ได้"), "warn");
      return;
    }
    this.showView?.("dm");
    void this.openDmThread(peerId, name);
  }

  private async openDmThread(peerId: string, name: string) {
    this.dmOpen = peerId;
    const list = document.getElementById("dm-list");
    const thread = document.getElementById("dm-thread") as HTMLElement | null;
    const log = document.getElementById("dm-log");
    const withWho = document.getElementById("dm-with");
    if (!list || !thread || !log) return;
    list.hidden = true;
    thread.hidden = false;
    if (withWho) withWho.textContent = name;
    log.innerHTML = "";

    const d = await this.dmFetch<{
      messages?: { name: string; text: string; mine: boolean; attach?: Attach }[];
    }>(`/${encodeURIComponent(peerId)}`);
    for (const m of d?.messages ?? []) log.appendChild(this.chatLine(m.mine, m.name, m.text, m.attach));
    if (!(d?.messages ?? []).length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = t("ยังไม่มีข้อความในนี้");
      log.appendChild(empty);
    }
    log.scrollTop = log.scrollHeight;
    (document.getElementById("dm-input") as HTMLInputElement | null)?.focus();
    // the badge was cleared on the server by that read; reflect it here
    void this.refreshDmCount();
  }

  /** a line arriving while we are looking somewhere else */
  private onDm(msg: { from: string; to: string; name: string; text: string; attach?: Attach }) {
    const mine = msg.from === this.myUserId;
    const peer = mine ? msg.to : msg.from;
    if (this.dmOpen === peer) {
      const log = document.getElementById("dm-log");
      if (log) {
        log.querySelector(".chat-empty")?.remove();
        log.appendChild(this.chatLine(mine, msg.name, msg.text, msg.attach));
        log.scrollTop = log.scrollHeight;
      }
      // reading it as it lands still counts as reading it
      if (!mine) void this.dmFetch(`/${encodeURIComponent(peer)}`);
      return;
    }
    if (!mine) {
      this.dmUnread++;
      this.refreshDmBadge();
      // a file with no words still has to say something in the bell
      const said = msg.text || (msg.attach ? "\u{1F4CE} " + msg.attach.name : "");
      this.notify("✉", t("ข้อความจาก {name}").replace("{name}", msg.name), said, () => {
        this.showView?.("dm");
        void this.openDmThread(msg.from, msg.name);
      });
    }
    // the list, if it is the thing on screen, should reorder
    const list = document.getElementById("dm-list");
    if (list && !list.hidden && !document.getElementById("view-dm")?.hidden) void this.showDmList();
  }

  private async refreshDmCount() {
    const d = await this.dmFetch<{ threads?: { unread: number }[] }>("");
    this.dmUnread = (d?.threads ?? []).reduce((n, t2) => n + t2.unread, 0);
    this.refreshDmBadge();
  }

  private refreshDmBadge() {
    const badge = document.getElementById("dm-unread");
    if (!badge) return;
    badge.textContent = this.dmUnread > 9 ? "9+" : String(this.dmUnread);
    badge.hidden = this.dmUnread === 0;
  }

  private async dmFetch<T>(path: string): Promise<T | null> {
    const token = localStorage.getItem("nexspace-token") ?? "";
    if (!token) return null;                       // a guest has no threads to read
    try {
      const r = await fetch(`${AUTH_API}/workspaces/${encodeURIComponent(WORKSPACE)}/dm${path}`,
        { headers: { authorization: `Bearer ${token}` } });
      return r.ok ? ((await r.json()) as T) : null;
    } catch (e) {
      console.warn("[dm] request failed:", e);
      return null;
    }
  }

  // ---- one person, and what you can do about them ---------------------------

  /**
   * The card for whoever was clicked, anchored beside their row.
   *
   * Their own card is the edit form: a profile is a thing you keep up to date
   * about yourself, and putting it behind a settings dialog is how it stays
   * empty. Everyone else gets the read-only side, plus the three things one
   * actually wants from a colleague standing somewhere on the map.
   */
  private isRemoteSprite(o: unknown) {
    for (const r of this.remotes.values()) if (r.sprite === o) return true;
    return false;
  }

  /** leaving the sprite or the card closes it, unless the pointer went to the other */
  private scheduleCardClose() {
    window.clearTimeout(this.cardTimer);
    this.cardTimer = window.setTimeout(() => this.closePersonCard(), 220);
  }

  /**
   * Where on the page a player is standing.
   *
   * World to camera to game pixels to CSS pixels: the last step is the one
   * that is easy to forget, and on a high-density display it is a factor of
   * two — the card would sit half a screen away from the person it is about.
   */
  private screenPosOf(sprite: Phaser.GameObjects.Sprite) {
    const cam = this.cameras.main;
    const box = this.game.canvas.getBoundingClientRect();
    const k = box.width / (this.scale.gameSize.width || box.width);
    return {
      x: box.left + (sprite.x - cam.worldView.x) * cam.zoom * k,
      y: box.top + (sprite.y - cam.worldView.y) * cam.zoom * k,
    };
  }

  private async openPersonCard(sessionId: string, anchor?: HTMLElement) {
    const card = document.getElementById("person-card") as HTMLElement | null;
    const player: any = this.room?.state.players.get(sessionId);
    if (!card || !player) return;
    this.cardFor = sessionId;

    const me = sessionId === this.mySessionId;
    const name = player.name || "Guest";
    const { initial, color } = this.chipParts(name);
    // their own colour tints the card, so it reads as theirs rather than as a form
    card.style.setProperty("--pc-tint", color);

    const portrait = document.getElementById("pc-portrait");
    const png = this.portraitOf(me ? this.myAvatar : (player.avatar || "1"), player.dir || "down");
    if (portrait) {
      portrait.innerHTML = "";
      if (png) {
        const img = document.createElement("img");
        img.src = png;
        img.alt = name;
        portrait.appendChild(img);
      } else {
        const chip = document.createElement("span");
        chip.className = "p-chip";
        chip.style.background = color;
        chip.textContent = initial;
        portrait.appendChild(chip);
      }
    }
    const nameEl = document.getElementById("pc-name");
    // "(you)" is worth saying on somebody else's card for contrast; on your own,
    // where the very next thing is a field holding that name, it is clutter.
    if (nameEl) nameEl.textContent = name;

    const bio = document.getElementById("pc-bio");
    const facts = document.getElementById("pc-facts");
    const sub = document.getElementById("pc-line");
    const actions = document.getElementById("pc-actions") as HTMLElement | null;
    const edit = document.getElementById("pc-edit") as HTMLElement | null;
    if (bio) bio.textContent = "";
    if (facts) facts.innerHTML = "";
    const st = statusMeta(me ? this.myStatus : (player.status || "online"));
    document.getElementById("pc-dot")?.style.setProperty("--pc-dot", st.css);
    // one caption line: what they are doing, and their clock once we know it
    if (sub) sub.textContent = t(st.label);
    const role = document.getElementById("pc-role") as HTMLElement | null;
    if (role) role.hidden = true;
    if (actions) actions.hidden = me;
    if (edit) edit.hidden = !me;

    card.hidden = false;
    const size = card.getBoundingClientRect();
    let left: number, top: number;

    if (anchor) {
      // opened from the list: beside the row, or the other side when there is
      // no room, and never past the edge
      const box = anchor.getBoundingClientRect();
      const right = box.right + 10;
      left = right + size.width <= window.innerWidth - 8
        ? right
        : Math.max(8, Math.min(box.left - size.width - 10, window.innerWidth - size.width - 8));
      top = Math.min(Math.max(8, box.top - 8), window.innerHeight - size.height - 8);
    } else {
      // opened by pointing at them: centred under their feet, flipped above
      // when they are standing near the bottom of the window
      const at = this.screenPosOf(this.remotes.get(sessionId)?.sprite ?? this.player);
      left = Math.max(8, Math.min(at.x - size.width / 2, window.innerWidth - size.width - 8));
      const below = at.y + 26;
      top = below + size.height <= window.innerHeight - 8 ? below : Math.max(8, at.y - size.height - 30);
    }
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";

    if (!me) {
      const dmBtn = document.getElementById("pc-dm") as HTMLElement | null;
      const findBtn = document.getElementById("pc-find") as HTMLElement | null;
      const pingBtn = document.getElementById("pc-ping") as HTMLElement | null;
      // a guest has no account, so there is nowhere to send a message that lasts
      if (dmBtn) dmBtn.hidden = !player.userId || !this.myUserId;
      if (dmBtn) dmBtn.onclick = () => { this.closePersonCard(); this.openDm(player.userId, name); };
      if (findBtn) findBtn.onclick = () => { this.closePersonCard(); this.followPerson(sessionId, name); };
      if (pingBtn) pingBtn.onclick = () => { this.closePersonCard(); this.room?.send("ping", { to: sessionId }); };

      // Staff only, and never against staff: the server applies the same rule,
      // so hiding the button only saves somebody a refusal.
      const kickBtn = document.getElementById("pc-kick") as HTMLButtonElement | null;
      if (kickBtn) {
        const staff = this.myRole === "owner" || this.myRole === "admin";
        kickBtn.hidden = !staff;
        kickBtn.onclick = () => {
          this.closePersonCard();
          if (!confirm(t("เชิญ {name} ออกจากพื้นที่นี้?").replace("{name}", name))) return;
          this.room?.send("kick", { to: sessionId });
          this.toast(t("เชิญ {name} ออกแล้ว — เขากลับเข้ามาได้ถ้ายังมีสิทธิ์เข้า").replace("{name}", name), "info");
        };
      }
      // the other half of "come over": go to them instead of asking them to move
      const gotoBtn = document.getElementById("pc-goto") as HTMLElement | null;
      if (gotoBtn) gotoBtn.onclick = () => {
        const them = this.remotes.get(sessionId)?.sprite;
        this.closePersonCard();
        if (them) this.goTo(them.x, them.y);
      };
    }

    // the parts that live in the database rather than in the room
    if (player.userId) void this.fillProfile(player.userId, me);
  }

  private async fillProfile(userId: string, mine: boolean) {
    const token = localStorage.getItem("nexspace-token") ?? "";
    if (!token) return;
    try {
      const r = await fetch(
        AUTH_API + "/workspaces/" + encodeURIComponent(WORKSPACE) + "/members/" + encodeURIComponent(userId),
        { headers: { authorization: "Bearer " + token } },
      );
      if (!r.ok) return;
      const { profile } = (await r.json()) as { profile: any };
      if (this.cardFor && this.room?.state.players.get(this.cardFor)?.userId !== userId) return;  // they clicked elsewhere

      if (mine) {
        const set = (id: string, v: string) => {
          const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
          if (el) el.value = v;
        };
        set("pc-f-name", profile.name ?? "");
        set("pc-f-team", profile.team ?? "");
        set("pc-f-tz", profile.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
        set("pc-f-bio", profile.bio ?? "");
        return;
      }

      const bio = document.getElementById("pc-bio");
      if (bio) bio.textContent = profile.bio ?? "";
      const facts = document.getElementById("pc-facts");
      if (!facts) return;
      const ICONS: Record<string, string> = {
        role: '<path d="M20 7h-4V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z"/><path d="M10 7V5h4v2"/>',
        team: '<path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1"/><circle cx="9.5" cy="7" r="3"/><path d="M21 19v-1a4 4 0 0 0-3-3.9"/><path d="M15.5 4.1a4 4 0 0 1 0 5.8"/>',
        zone: '<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
      };
      const line = (icon: string, value: string) => {
        const row = document.createElement("div");
        row.className = "pc-fact";
        row.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ICONS[icon] + "</svg>";
        const span = document.createElement("span");
        span.textContent = value;
        row.appendChild(span);
        facts.appendChild(row);
      };
      // the workspace role, in the corner, in its own colour
      const roleEl = document.getElementById("pc-role") as HTMLElement | null;
      if (roleEl && profile.memberRole) {
        const TONE: Record<string, [string, string]> = {
          owner: ["#f0b42926", "#f4c65f"],
          admin: ["#8b7bf026", "#b3a7ff"],
          member: ["#ffffff14", "#cfd4dc"],
          guest: ["#2bb3a326", "#68d6c6"],
        };
        const [bg, fg] = TONE[profile.memberRole] ?? TONE.member;
        roleEl.textContent = roleLabel(profile.memberRole);
        roleEl.style.setProperty("--pc-role-bg", bg);
        roleEl.style.setProperty("--pc-role-fg", fg);
        roleEl.hidden = false;
      }
      if (profile.role) line("role", profile.role);
      if (profile.team) line("team", profile.team);
      if (profile.timezone) {
        // The clock goes in the band rather than the list: "half past four for
        // them" is the thing you actually wanted, and the zone name is the
        // footnote under it.
        const subEl = document.getElementById("pc-line");
        try {
          const parts = new Intl.DateTimeFormat(locale(), {
            hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset", timeZone: profile.timezone,
          }).format(new Date());
          // "กำลังใช้งาน · 09:35 GMT+7" — the state, then the clock, one line
          if (subEl) subEl.textContent = subEl.textContent + " · " + parts;
        } catch { /* an invalid zone: the caption keeps just the status */ }
        line("zone", profile.timezone);
      }
    } catch (e) {
      console.warn("[profile] could not load:", e);
    }
  }

  private async saveMyProfile() {
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";
    const token = localStorage.getItem("nexspace-token") ?? "";
    if (!token) return;
    try {
      const r = await fetch(AUTH_API + "/me/profile", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ name: val("pc-f-name"), team: val("pc-f-team"), timezone: val("pc-f-tz"), bio: val("pc-f-bio") }),
      });
      if (!r.ok) { this.toast(t("บันทึกไม่สำเร็จ"), "warn"); return; }
      const { user } = (await r.json()) as { user: { name: string } };
      // the name is on the map as well as in the database
      if (user?.name && user.name !== this.myName) {
        this.myName = user.name;
        this.room?.send("name", user.name);
        this.setAvatarChip(user.name);
      }
      this.closePersonCard();
      this.toast(t("บันทึกโปรไฟล์แล้ว"));
      this.refreshRoster();
    } catch (e) {
      console.warn("[profile] save failed:", e);
      this.toast(t("บันทึกไม่สำเร็จ"), "warn");
    }
  }

  /**
   * Stop hearing the room without leaving it.
   *
   * Three things at once, because they are one intention: the people around
   * you go quiet, notifications stop making a sound, and anyone who tries to
   * call you over is told you are busy rather than left wondering. What it
   * deliberately does NOT do is touch your microphone — changing that behind
   * somebody's back is how a person ends up talking to nobody.
   */
  private setDnd(on: boolean) {
    this.dnd = on;
    document.getElementById("btn-dnd")?.classList.toggle("dnd", on);
    // silence what is already playing rather than waiting for the next frame
    if (this.room) {
      for (const [id] of this.room.state.players as any) {
        if (id !== this.mySessionId && on) this.webrtc?.setPeerVolume(id, 0);
      }
    }
    this.statusCheckAt = 0;            // re-evaluate now, not on the next tick
    this.toast(on ? t("ห้ามรบกวน — ไม่ได้ยินเสียงรอบตัวและไม่มีเสียงแจ้งเตือน") : t("กลับมารับเสียงตามปกติแล้ว"),
      on ? "warn" : "success");
  }

  /**
   * Their character, cut out of the sheet it is already drawn from.
   *
   * The texture is in memory because the person is on screen, so this costs a
   * copy of one 64px frame and no network at all. Works for both kinds of
   * avatar: a composed LPC canvas and a preset spritesheet differ in where the
   * frame sits, and the frame object knows that either way.
   *
   * Returns null when the texture has not finished composing, and the caller
   * falls back to the initial — a card that waits for a picture is worse than
   * one that shows a letter.
   */
  private portraitOf(avatarRaw: string, dir = "down"): string | null {
    try {
      const av = isLpc(avatarRaw) ? avatarRaw : (AVATARS[avatarRaw] ? avatarRaw : "1");
      const key = this.texKeyFor(av);
      if (!this.textures.exists(key)) return null;
      const tex = this.textures.get(key);
      const frame = tex.get(this.idleFrameFor(av, dir));
      if (!frame?.cutWidth) return null;
      const canvas = document.createElement("canvas");
      canvas.width = frame.cutWidth;
      canvas.height = frame.cutHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = false;   // it is pixel art; keep the edges
      ctx.drawImage(
        tex.getSourceImage() as CanvasImageSource,
        frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight,
        0, 0, frame.cutWidth, frame.cutHeight,
      );
      return canvas.toDataURL();
    } catch {
      return null;    // an odd texture is not worth failing a card over
    }
  }

  private closePersonCard() {
    this.cardFor = "";
    const card = document.getElementById("person-card") as HTMLElement | null;
    if (card) card.hidden = true;
  }

  // ---- finding people -------------------------------------------------------

  /**
   * Send the camera to somebody and let it trail them.
   *
   * The same state the map drag uses: the camera has let go of you, and the
   * first step you take takes it back. Watching a colleague cross the office is
   * a thing you do for a moment, not a mode to be exited.
   */
  private followPerson(sessionId: string, name: string) {
    const sprite = this.remotes.get(sessionId)?.sprite;
    if (!sprite) { this.toast(t("หาไม่เจอ — เขาอาจออกไปแล้ว"), "warn"); return; }
    this.following = sessionId;
    this.cameraFree = true;
    this.cameras.main.startFollow(sprite, true, 0.12, 0.12);
    this.toast(t("กำลังตามดู {name} — เดินเมื่อไหร่กล้องกลับมาเอง").replace("{name}", name), "info");
  }

  private onWave(msg: { from: string; name: string }) {
    // The panel is easy to miss when the person testing is looking at the window
    // that SENT the wave, so leave a trace of the arrival in the console.
    console.debug("[wave] from", msg.name, msg.from);
    const WAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3.5a1.4 1.4 0 0 1 2.8 0V11"/><path d="M8.2 6a1.4 1.4 0 0 1 2.8 0v5"/><path d="M13.8 6.6a1.4 1.4 0 0 1 2.8 0V12"/><path d="M16.6 9.2a1.4 1.4 0 0 1 2.8 0v4.3a7 7 0 0 1-7 7h-.7a6 6 0 0 1-4.3-1.8L4 16.8a1.5 1.5 0 0 1 2.1-2.1L8.2 16"/></svg>';
    const GO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M8 12h7"/><path d="M12 8.5l3.5 3.5L12 15.5"/></svg>';

    this.showNudge({
      from: msg.from,
      title: t("{name} โบกมือให้คุณ").replace("{name}", msg.name),
      sub: this.whereabouts(msg.from),
      actions: [
        { label: t("โบกมือตอบ"), icon: WAVE, go: () => this.room?.send("wave", { to: msg.from }) },
        { label: t("เดินไปหา"), icon: GO, primary: true, go: () => {
          const them = this.remotes.get(msg.from)?.sprite;
          if (them) this.walkOrJump(them.x, them.y);
          else this.toast(t("หาไม่เจอ — เขาอาจออกไปแล้ว"), "warn");
        } },
      ],
    });

    // and it stays in the bell, so dismissing the panel does not lose it
    this.notify("👋", t("{name} โบกมือให้คุณ").replace("{name}", msg.name), this.whereabouts(msg.from),
      () => { this.showView?.("people"); this.followPerson(msg.from, msg.name); });
  }

  /**
   * Somebody is at the door.
   *
   * Answered from the same panel a wave arrives in, because it is the same kind
   * of thing: a person asking for a moment of yours. "Not now" is offered as
   * plainly as "come in" — a door you can only open is not a door.
   */
  private onKnock(msg: { from: string; name: string; area: string; label: string }) {
    const IN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M4 12h10"/><path d="M10.5 8.5 14 12l-3.5 3.5"/></svg>';
    const NO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M9 15l6-6"/></svg>';

    this.showNudge({
      from: msg.from,
      title: t("{name} เคาะประตู {area}").replace("{name}", msg.name).replace("{area}", t(msg.label)),
      sub: t("ตอนนี้"),
      actions: [
        { label: t("ยังไม่สะดวก"), icon: NO, go: () => this.room?.send("admit", { to: msg.from, ok: false }) },
        { label: t("เปิดให้เข้า"), icon: IN, primary: true, go: () => this.room?.send("admit", { to: msg.from, ok: true }) },
      ],
    });
    this.notify("🚪", t("{name} เคาะประตู {area}").replace("{name}", msg.name).replace("{area}", t(msg.label)),
      t("เปิดให้เข้าได้จากการ์ดนี้"), () => this.onKnock(msg));
  }

  // ---- gestures and stickers -----------------------------------------------

  /** what each gesture looks like: the mark shown, and how the body moves */
  private static readonly EMOTES: Record<string, { icon: string; move: "swing" | "hop" | "none" }> = {
    wave: { icon: "\ud83d\udc4b", move: "swing" },
    dance: { icon: "\ud83d\udd7a", move: "hop" },
    clap: { icon: "\ud83d\udc4f", move: "swing" },
    thumbs: { icon: "\ud83d\udc4d", move: "none" },
    party: { icon: "\ud83c\udf89", move: "hop" },
    think: { icon: "\ud83e\udd14", move: "none" },
  };

  /**
   * Play a gesture on somebody's avatar.
   *
   * The mark rises and fades over a couple of seconds. The body moves too,
   * because a symbol floating over a motionless figure reads as a notification
   * rather than as that person doing something.
   */
  private playEmote(sessionId: string, kind: string) {
    const spec = OfficeScene.EMOTES[kind];
    if (!spec) return;
    const sprite = sessionId === this.mySessionId ? this.player : this.remotes.get(sessionId)?.sprite;
    if (!sprite) return;

    const mark = this.add.text(sprite.x, sprite.y - 40, spec.icon, { fontSize: "20px" })
      .setOrigin(0.5).setDepth(100000).setResolution(3);
    this.tweens.add({
      targets: mark, y: sprite.y - 62, alpha: 0, duration: 2000, ease: "Sine.easeOut",
      onComplete: () => mark.destroy(),
    });

    if (spec.move === "hop") {
      this.tweens.add({ targets: sprite, y: sprite.y - 7, duration: 160, yoyo: true, repeat: 3, ease: "Sine.easeInOut" });
    } else if (spec.move === "swing") {
      this.tweens.add({ targets: sprite, angle: 9, duration: 130, yoyo: true, repeat: 3, ease: "Sine.easeInOut",
        onComplete: () => sprite.setAngle(0) });
    }
  }

  /**
   * Draw one sticker, or move it if it changed.
   *
   * Only the ones on the map this tab is showing: a space may hold several, and
   * a doodle from the second floor drawn over the ground floor would be a ghost.
   * Clicking your own picks it back up; the server decides whether it is yours.
   */
  private drawSticker(id: string, st: { emoji: string; x: number; y: number; map: string; by: string }) {
    // THEME.id is this tab's map: for a stored map the API holds its id and its
    // name in the space to the same value, and for a built-in it is the theme's
    // own id, which is what the room server names too. A sticker with no map at
    // all predates the field and belongs wherever it is found.
    const here = !st.map || st.map === THEME.id;
    if (!here) { this.stickerArt.get(id)?.destroy(); this.stickerArt.delete(id); return; }

    let art = this.stickerArt.get(id);
    if (!art) {
      art = this.add.text(st.x, st.y, st.emoji, { fontSize: "18px" })
        .setOrigin(0.5).setDepth(-880).setResolution(3).setAlpha(0.95);
      art.setInteractive({ useHandCursor: true });
      art.on("pointerdown", (p: Phaser.Input.Pointer) => {
        p.event.stopPropagation();
        this.room?.send("unsticker", id);
      });
      this.stickerArt.set(id, art);
    }
    art.setText(st.emoji).setPosition(st.x, st.y);
    if (st.by) art.setData("by", st.by);
  }

  /** hold a sticker, ready to put it down; passing "" puts it away */
  private armSticker(emoji: string) {
    this.armedSticker = emoji;
    const pop = document.getElementById("emoji-pop");
    pop?.querySelectorAll<HTMLElement>("[data-sticker]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.sticker === emoji && !!emoji)));
    document.body.classList.toggle("placing", !!emoji);
    const hint = document.getElementById("place-hint");
    if (hint) hint.hidden = !emoji;
  }

  /** somebody would like us to come over */
  private onPing(msg: { from: string; name: string; x: number; y: number }) {
    const GO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M8 12h7"/><path d="M12 8.5l3.5 3.5L12 15.5"/></svg>';
    const LATER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4l2.5 2"/></svg>';

    this.showNudge({
      from: msg.from,
      title: t("{name} เรียกให้ไปหา").replace("{name}", msg.name),
      sub: this.whereabouts(msg.from),
      actions: [
        { label: t("ไว้ก่อน"), icon: LATER, go: () => { /* the panel closing is the answer */ } },
        { label: t("เดินไปหา"), icon: GO, primary: true, go: () => this.walkOrJump(msg.x, msg.y) },
      ],
    });

    this.notify("🖐", t("{name} เรียกให้ไปหา").replace("{name}", msg.name), this.whereabouts(msg.from),
      () => this.walkOrJump(msg.x, msg.y));
  }

  /**
   * Stand next to a point, not on it.
   *
   * Landing exactly where somebody is standing pushes them out of the way and
   * looks like a bug, so the nearest walkable tile around them is used instead —
   * and if every one of those is taken, the spot itself, which is still better
   * than refusing to move.
   */
  private goTo(x: number, y: number) {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const spots = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [0, 0]];
    let dest = { x, y };
    for (const [dx, dy] of spots) {
      const gx = tx + dx, gy = ty + dy;
      if (this.walkable[gy]?.[gx]) { dest = { x: gx * TILE + TILE / 2, y: gy * TILE + TILE / 2 }; break; }
    }
    const cam = this.cameras.main;
    this.clearPath();
    this.followMeAgain();
    cam.fadeOut(140);
    cam.once("camerafadeoutcomplete", () => {
      this.player.setPosition(dest.x, dest.y);
      this.player.body!.reset(dest.x, dest.y);
      cam.fadeIn(160);
    });
  }

  // ---- what was missed ------------------------------------------------------

  /** add something worth coming back to, and say so quietly */
  private notify(icon: string, title: string, body: string, go?: () => void) {
    this.notifs.unshift({ icon, title, body, at: Date.now(), seen: false, go });
    if (this.notifs.length > 50) this.notifs.length = 50;   // a list, not a log
    this.renderNotifs(false);
    this.blip();
  }

  private renderNotifs(markSeen: boolean) {
    const list = document.getElementById("nf-list");
    if (markSeen) for (const n of this.notifs) n.seen = true;

    const badge = document.getElementById("notif-unread");
    const unseen = this.notifs.filter((n) => !n.seen).length;
    if (badge) {
      badge.textContent = unseen > 9 ? "9+" : String(unseen);
      badge.hidden = unseen === 0;
    }
    if (!list) return;

    list.innerHTML = "";
    if (!this.notifs.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = t("ยังไม่มีอะไรพลาดไป");
      list.appendChild(empty);
      return;
    }
    for (const n of this.notifs) {
      const row = document.createElement("button");
      row.className = "nf-row" + (n.seen ? "" : " unseen");
      const ico = document.createElement("span"); ico.className = "nf-ico"; ico.textContent = n.icon;
      const body = document.createElement("span"); body.className = "nf-body";
      const b = document.createElement("b"); b.textContent = n.title;
      const sm = document.createElement("small"); sm.textContent = n.body;
      body.append(b, sm);
      const when = document.createElement("time");
      when.textContent = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(n.at);
      row.append(ico, body, when);
      if (n.go) row.addEventListener("click", () => { n.seen = true; n.go!(); this.renderNotifs(false); });
      list.appendChild(row);
    }
  }

  private refreshSoundButton() {
    const btn = document.getElementById("nf-sound");
    btn?.classList.toggle("off", localStorage.getItem("nexspace-sound") === "off");
  }

  /**
   * Two short notes, made rather than loaded.
   *
   * A notification sound is four kilobytes of asset, a fetch, and a licence to
   * keep track of; an oscillator is none of those and always arrives on time.
   */
  private blip() {
    // A notification while on do-not-disturb still belongs in the list — it is
    // the sound that was unwelcome, not the fact.
    if (this.dnd || localStorage.getItem("nexspace-sound") === "off") return;
    try {
      const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctor) return;
      const ac: AudioContext = ((this as any)._ac ??= new Ctor());
      if (ac.state === "suspended") void ac.resume();
      const now = ac.currentTime;
      for (const [at, hz] of [[0, 880], [0.12, 1174]] as [number, number][]) {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.frequency.value = hz;
        osc.type = "sine";
        // a shaped envelope, because a square-edged tone clicks
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.07, now + at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.11);
        osc.connect(gain).connect(ac.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.13);
      }
    } catch { /* audio is a nicety; never let it break the room */ }
  }

  // ---- somebody wants something ---------------------------------------------

  /**
   * A wave, or a call over: one line about who and where, and the answer right
   * underneath it.
   *
   * There is one panel, and the newest thing wins it. Stacking these would
   * turn a friendly room into a queue of demands, and the bell keeps the ones
   * that scroll past anyway — this is the copy that is worth interrupting for.
   *
   * It clears itself after a while, because an unanswered wave stops being
   * true. Not while the pointer is on it: taking a button away from under
   * somebody's hand is worse than leaving it up too long.
   */
  private showNudge(opts: {
    from: string; title: string; sub: string;
    actions: { label: string; icon: string; go: () => void; primary?: boolean }[];
  }) {
    const el = document.getElementById("nudge") as HTMLElement | null;
    const chip = document.getElementById("nudge-chip") as HTMLElement | null;
    const acts = document.getElementById("nudge-acts");
    if (!el || !chip || !acts) {
      // silently doing nothing is how a missing element becomes an afternoon
      console.warn("[nudge] the panel is not in the page — nothing will be shown");
      return;
    }

    const player: any = this.room?.state.players.get(opts.from);
    const name = player?.name || "?";
    const { initial, color } = this.chipParts(name);
    const st = statusMeta(player?.status || "online");
    chip.style.setProperty("--pc-tint", color);
    chip.style.setProperty("--pc-dot", st.css);

    // the same portrait the card uses, so the two agree about who this is
    const dot = document.getElementById("nudge-dot");
    chip.innerHTML = "";
    const png = this.portraitOf(player?.avatar || "1", player?.dir || "down");
    if (png) {
      const img = document.createElement("img");
      img.src = png; img.alt = name;
      chip.appendChild(img);
    } else {
      chip.appendChild(document.createTextNode(initial));
    }
    if (dot) chip.appendChild(dot);

    const titleEl = document.getElementById("nudge-title");
    const subEl = document.getElementById("nudge-sub");
    if (titleEl) titleEl.textContent = opts.title;
    if (subEl) subEl.textContent = opts.sub;

    acts.innerHTML = "";
    for (const a of opts.actions) {
      const b = document.createElement("button");
      b.type = "button";
      if (a.primary) b.className = "go";
      b.innerHTML = a.icon;
      const span = document.createElement("span");
      span.textContent = a.label;
      b.appendChild(span);
      b.addEventListener("click", () => { this.closeNudge(); a.go(); });
      acts.appendChild(b);
    }

    el.hidden = false;
  }

  /**
   * It waits.
   *
   * This used to close itself after twenty seconds, which is fine for something
   * you were already looking at and useless for anything else: somebody asked to
   * come over while you were reading, and by the time you looked up the ask was
   * gone. It now stays until answered, closed, or replaced by the next one —
   * and every one of them is in the bell regardless.
   */
  private closeNudge() {
    const el = document.getElementById("nudge") as HTMLElement | null;
    if (el) el.hidden = true;
  }

  /**
   * Where somebody is, in words: their desk if they have claimed one, and
   * otherwise nothing rather than a guess. "From their desk" tells you whether
   * this is a wave across the room or from somebody settled in.
   */
  private whereabouts(sessionId: string) {
    const player: any = this.room?.state.players.get(sessionId);
    const deskId: string = player?.desk || "";
    if (!deskId) return t("ตอนนี้");
    return t("ตอนนี้ • จากโต๊ะของ {name}").replace("{name}", player?.name || "");
  }

  /**
   * Walk there if there is a way, and fade across if there is not.
   *
   * The button says walk, so it walks — but a person on the far side of a wall
   * the pathfinder cannot get around would otherwise be a button that does
   * nothing, which is worse than arriving in an unexplained way.
   */
  private walkOrJump(x: number, y: number) {
    this.walkTo(x, y);
    if (!this.path.length) this.goTo(x, y);
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
        e.textContent = t("— อนุญาตอุปกรณ์ก่อน (เปิดไมค์/กล้อง) —");
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
      section(t("ไมโครโฟน"), dev.mics, w.selMic, (id) => void w.setMic(id), "Microphone");
      section(t("ลำโพง"), dev.speakers, w.selSpk, (id) => void w.setSpeaker(id), "Speaker");
    } else {
      section(t("กล้อง"), dev.cams, w.selCam, (id) => void w.setCam(id), "Camera");
    }

    const r = anchor.getBoundingClientRect();
    pop.style.display = "block";
    pop.dataset.open = kind;
    pop.style.left = Math.max(8, r.left - 95) + "px";
    pop.style.bottom = window.innerHeight - r.top + 8 + "px";
  }

  /**
   * `level` is a whole step, 1..4. The camera never gets a fractional zoom: at a
   * fractional one every source pixel lands on a fraction of a device pixel and
   * the art is resampled into mush, which is why Gather only zooms in whole steps.
   */
  private setZoom(level: number) {
    // Snap to the ladder instead of rounding: the ladder *is* the set of zooms
    // that keep the art crisp, and a plain round would allow 1.5.
    const target = Phaser.Math.Clamp(level, ZOOM_MIN, ZOOM_MAX);
    this.zoomLevel = ZOOM_STEPS.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    // No floor that forces the map to fill the window any more. Zooming out past
    // that point is the whole reason someone presses the button, and Phaser
    // centres the world on its bounds once the view is larger than the map, so
    // what they get is the floor plan centred rather than pinned to a corner.
    this.cameras.main.setZoom(cameraZoomFor(this.zoomLevel));
  }

  /** move along the ladder, so a step means the next crisp zoom either way */
  private zoomBy(steps: number) {
    const at = ZOOM_STEPS.indexOf(this.zoomLevel);
    const from = at >= 0 ? at : ZOOM_STEPS.indexOf(ZOOM_DEFAULT);
    this.setZoom(ZOOM_STEPS[Phaser.Math.Clamp(from + steps, 0, ZOOM_STEPS.length - 1)]);
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
    b("zb-in", icons.in, () => this.zoomBy(1));
    b("zb-out", icons.out, () => this.zoomBy(-1));
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
    // A portal naming another map is a different journey from one that moves
    // you across this one: the world itself changes, so the page does.
    if (it.type === "portal" && it.map && it.map !== MAP) {
      this.cameras.main.fadeOut(160);
      this.toast(t("กำลังไป {name}").replace("{name}", t(it.label)), "info");
      this.time.delayedCall(180, () => gotoMap(it.map!, it.target));
      return;
    }
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
    // the same switch, reachable from the map without hunting for the top bar
    document.getElementById("meet-enter")?.addEventListener("click", () => this.setViewMode("call"));

    document.getElementById("btn-fullscreen")?.addEventListener("click", () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else document.exitFullscreen().catch(() => {});
    });
  }

  private setViewMode(mode: "space" | "call") {
    this.viewMode = mode;
    const spaceBtn = document.getElementById("nav-tab-space");
    const callBtn = document.getElementById("nav-tab-call");
    const callOverlay = document.getElementById("call-view-overlay");
    const appContainer = document.getElementById("app");
    const zoomBar = document.getElementById("zoom-bar");

    spaceBtn?.classList.toggle("active", mode === "space");
    callBtn?.classList.toggle("active", mode === "call");

    if (callOverlay) {
      callOverlay.style.display = mode === "call" ? "grid" : "none";
      // marks the meeting view as showing, which is what reveals the button that
      // brings the chat panel back after it is closed
      callOverlay.classList.toggle("on", mode === "call");
      if (mode === "call" && !callOverlay.classList.contains("chat-open")) {
        callOverlay.classList.add("chat-open");   // open the first time, as the reference has it
      }
      if (mode === "call" && callOverlay.classList.contains("chat-open")) this.markChatSeen();
    }
    if (appContainer) appContainer.style.visibility = mode === "call" ? "hidden" : "visible";
    if (zoomBar) zoomBar.style.display = mode === "call" ? "none" : "flex";

    if (mode === "call") {
      this.meetGridKey = "";        // rebuild: what it holds may be stale
      this.updateCallStageUI();
      this.refreshMeetingGrid();
    }
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
    this.refreshMeetingGrid();
  }

  private refreshCallSidebarTiles() {
    const selfLabel = document.getElementById("call-self-label");
    if (selfLabel) selfLabel.textContent = this.myName + " " + t("(คุณ)");
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
    // status dot lives in its own object so it can be recoloured without rebuilding the tag
    const dot = this.add.circle(-w / 2 + PAD + DOT_R, 0, DOT_R, STATUS_META.online.color);

    t.setPosition(-w / 2 + PAD + DOT_R * 2 + GAP, 0);
    const c = this.add.container(x, y, [g, dot, t]).setDepth(100000);
    c.setData("dot", dot);
    return c;
  }

  /** recolour a tag's status dot (online / afk / muted / meeting) */
  private setTagStatus(tag: Phaser.GameObjects.Container | undefined, status: string) {
    const dot = tag?.getData("dot") as Phaser.GameObjects.Arc | undefined;
    dot?.setFillStyle(statusMeta(status).color);
  }

  /** any real input counts as presence — DOM level so chat/sidebar typing counts too */
  private setupPresence() {
    this.lastActiveAt = this.time.now;
    const seen = () => { this.lastActiveAt = this.time.now; };
    for (const ev of ["keydown", "pointerdown", "wheel"]) {
      document.addEventListener(ev, seen, { passive: true });
    }
  }

  /** the name a map goes by, falling back to its own id */
  private mapLabel(slug: string) {
    const m = mapList().find((x) => x.slug === slug);
    return t(m?.label ?? (slug || THEME.label));
  }

  /**
   * The floors of this space, as a row of pills above the people.
   *
   * Hidden entirely when there is one map, which is most spaces: a switcher
   * with a single option is a control that does nothing, and it would sit
   * there on every screen suggesting otherwise.
   */
  private async buildMapSwitcher() {
    const box = document.getElementById("sb-maps");
    if (!box) return;
    const maps = await loadMapList();
    box.hidden = maps.length < 2;
    if (box.hidden) return;
    box.innerHTML = "";
    for (const m of maps) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = t(m.label);
      b.title = t(m.label);
      const here = m.slug === MAP;
      if (here) b.setAttribute("aria-current", "true");
      else b.addEventListener("click", () => gotoMap(m.slug));
      box.appendChild(b);
    }
    // the roster's "on another floor" lines can only be written once this is in
    this.refreshRoster();
  }

  /**
   * Is this player on the same map as me?
   *
   * The room keeps everybody in one place so the roster, private messages and
   * "come over" still cross floors. What does not cross is the world: a person
   * on another map has no sprite here, and the server will not carry a word
   * between us either.
   */
  private onMyMap(player: { map?: string }) {
    return (player?.map ?? "") === MAP;
  }

  /** the private area a point falls in, if any */
  private areaOf(x: number, y: number): PrivateArea | undefined {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    for (const a of PRIVATE_AREAS) {
      if (tx >= a.x0 && tx <= a.x1 && ty >= a.y0 && ty <= a.y1) return a;
    }
    return undefined;
  }

  /**
   * A locked room you have not been let into.
   *
   * A soft wall rather than a solid one: the tiles stay walkable, and stepping
   * onto them puts you back where you were. Building real collision around a
   * rectangle with a doorway in it would fight the pathfinder and would leave
   * somebody who was admitted mid-walk stuck outside their own room.
   *
   * The knock prompt is what makes this legible — being nudged backwards with
   * no explanation is indistinguishable from a bug.
   */
  private holdTheDoor() {
    const here = this.areaOf(this.player.x, this.player.y);
    const barred = here?.locked && !this.admitted.has(here.id) ? here : undefined;

    if (!barred) {
      this.lastAllowed = { x: this.player.x, y: this.player.y };
      if (this.atDoor) { this.atDoor = undefined; this.closeNudge(); }
      return;
    }

    // put them back on the last tile they were entitled to
    if (this.lastAllowed) {
      this.player.setPosition(this.lastAllowed.x, this.lastAllowed.y);
      this.player.body?.reset(this.lastAllowed.x, this.lastAllowed.y);
      this.path.length = 0; // a walk that ends inside a locked room is over
    }
    if (this.atDoor?.id === barred.id) return;
    this.atDoor = barred;

    const KNOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>';
    this.showNudge({
      from: this.mySessionId,
      title: t("{area} ล็อกอยู่").replace("{area}", t(barred.label)),
      sub: t("เคาะประตูเพื่อขอเข้า"),
      actions: [
        { label: t("เคาะประตู"), icon: KNOCK, primary: true, go: () => this.room?.send("knock", {}) },
      ],
    });
  }

  /**
   * Walked into a private area, or out of one.
   *
   * Said once on the way in, because the rule it announces is one people cannot
   * see working: everyone here hears you, and nobody out there does.
   */
  private updateArea() {
    const now = this.areaOf(this.player.x, this.player.y);
    if (now?.id === this.myArea?.id) return;
    this.myArea = now;

    const chip = document.getElementById("area-chip");
    if (chip) {
      chip.hidden = !now;
      const label = document.getElementById("area-name");
      if (label && now) label.textContent = t(now.label);

      // Standing in a room is when somebody decides they want it, so the offer
      // follows them into it rather than waiting in a panel they would have to
      // think to open.
      const book = document.getElementById("area-book") as HTMLButtonElement | null;
      if (book) {
        book.hidden = !now || this.myRole === "guest";
        book.onclick = () => {
          if (!now) return;
          this.showView?.("cal");
          this.calPanel?.bookRoom(now.id);
        };
      }
    }
    if (now) this.toast(t("เข้า {area} — คุยกันเฉพาะคนในโซนนี้").replace("{area}", t(now.label)), "info");
  }

  /** the same test for anyone, so the panel and the status dot cannot disagree */
  private isInMeeting(x: number, y: number): boolean {
    const tx = x / TILE, ty = y / TILE;
    return tx >= MEETING_ROOM.x0 && tx <= MEETING_ROOM.x1 + 1
        && ty >= MEETING_ROOM.y0 && ty <= MEETING_ROOM.y1 + 1;
  }

  private inMeetingRoom(): boolean {
    return this.isInMeeting(this.player.x, this.player.y);
  }

  /**
   * The floating card naming everyone standing in the meeting room. Shown only
   * while you are in there yourself — it answers "who am I in here with", so
   * outside the room there is nothing to answer.
   */
  /** everyone standing in the meeting room, me first — the panel and the grid share it */
  private peopleInMeeting(): MeetingPerson[] {
    const here: MeetingPerson[] = [];
    this.room?.state.players.forEach((p: any, sid: string) => {
      const self = sid === this.mySessionId;
      // my own position is local truth; the server copy lags a frame behind
      const x = self ? this.player.x : p.x, y = self ? this.player.y : p.y;
      if (!this.isInMeeting(x, y)) return;
      here.push({
        id: sid, name: p.name || "Guest", self,
        status: self ? this.myStatus : (p.status || "online"),
        mic: self ? !!this.webrtc?.micOn : !!p.micOn,
        hand: self ? this.handUp : !!p.handUp,
      });
    });
    if (!this.room) {
      here.push({ id: "me", name: this.myName, self: true, status: this.myStatus, mic: !!this.webrtc?.micOn, hand: this.handUp });
    }
    here.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
    return here;
  }

  /**
   * The meeting view: one tile per person in the room, filling the screen.
   *
   * It is the same list the floating panel shows, at a size you can hold a
   * conversation in front of. A screen share still takes the stage — the tiles
   * move to the sidebar beside it, which is what the existing call layout does —
   * so this grid is only for when nobody is presenting.
   */
  private refreshMeetingGrid() {
    const grid = document.getElementById("call-grid");
    const overlay = document.getElementById("call-view-overlay");
    if (!grid || !overlay) return;
    const presenting = !!this.activeScreenStream;
    overlay.classList.toggle("grid-only", !presenting);
    if (presenting) return;

    const here = this.peopleInMeeting();
    const key = here.map((h) => `${h.id}:${h.name}:${h.status}:${h.mic}:${h.hand}`).join("|");
    if (key === this.meetGridKey) return;
    this.meetGridKey = key;

    // squarish: two across for a pair, three for up to nine, and so on
    const cols = Math.max(1, Math.ceil(Math.sqrt(here.length || 1)));
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, min(46vw, 760px)))`;
    grid.innerHTML = "";
    if (!here.length) {
      const empty = document.createElement("div");
      empty.className = "mt-empty";
      empty.textContent = t("ยังไม่มีใครอยู่ในห้องประชุม");
      grid.appendChild(empty);
      return;
    }

    for (const h of here) {
      const tile = document.createElement("div");
      tile.className = "mt-tile" + (h.self ? " self" : "");

      const video = document.createElement("video");
      video.autoplay = true; video.playsInline = true;
      video.muted = true;                      // the audio already plays through the mesh
      const stream = h.self ? this.webrtc?.cameraStream : this.webrtc?.getPeerStream(h.id);
      if (stream && stream.getVideoTracks().some((track: MediaStreamTrack) => track.readyState === "live" && !track.muted)) {
        video.srcObject = stream;
        tile.classList.add("has-video");
        video.play().catch(() => {});
      }

      const { initial, color } = this.chipParts(h.name);
      const face = document.createElement("div");
      face.className = "mt-face";
      face.style.background = color;
      face.textContent = initial;

      const name = document.createElement("div");
      name.className = "mt-name";
      if (!h.mic) {
        name.insertAdjacentHTML("beforeend",
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
          + ' stroke-linecap="round"><path d="M9 5a3 3 0 0 1 6 0v5"/><path d="M5 11a7 7 0 0 0 10.5 6"/>'
          + '<path d="M19 11a7 7 0 0 1-.6 2.8"/><path d="M12 19v3"/><path d="M3 3l18 18"/></svg>');
      }
      const label = document.createElement("span");
      label.textContent = h.name + (h.self ? " " + t("(คุณ)") : "");
      name.appendChild(label);

      if (h.hand) {
        const hand = document.createElement("div");
        hand.className = "mt-hand";
        hand.textContent = "✋";
        hand.title = t("ยกมือ");
        tile.appendChild(hand);
      }
      tile.append(video, face, name);
      grid.appendChild(tile);
    }
  }

  private refreshMeetingPanel() {
    if (this.time.now - this.meetPanelAt < 250) return; // polled, not per frame
    this.meetPanelAt = this.time.now;
    const panel = document.getElementById("meet-panel");
    if (!panel) return;
    const inside = this.inMeetingRoom();
    panel.classList.toggle("on", inside);
    // The switcher lives in the top bar, which until now only appeared while
    // someone was presenting. Being in the meeting room is the other time you
    // need it.
    document.body.classList.toggle("in-meeting", inside);
    if (!inside) {
      // walked out: the meeting view is about a room you are no longer in
      if (this.viewMode === "call" && !this.activeScreenStream) this.setViewMode("space");
      return;
    }
    if (this.viewMode === "call") this.refreshMeetingGrid();

    const here = this.peopleInMeeting();

    // rebuilding only when the contents change keeps this off the render path
    const key = here.map((h) => `${h.name}:${h.status}:${h.mic}:${h.hand}:${h.self}`).join("|");
    if (key === this.meetPanelKey) return;
    this.meetPanelKey = key;

    document.getElementById("meet-count")!.textContent = String(here.length);
    const list = document.getElementById("meet-people")!;
    list.innerHTML = "";
    if (here.length <= 1) {
      const alone = document.createElement("div");
      alone.className = "meet-empty";
      alone.textContent = t("ยังมีแค่คุณในห้องนี้ — ชวนเพื่อนร่วมงานเข้ามาได้เลย");
      list.appendChild(alone);
      return;
    }
    for (const h of here) {
      const { initial, color } = this.chipParts(h.name);
      // a call tile: dark card, the avatar in the middle, name over the corner
      const who = document.createElement("div");
      who.className = "meet-who" + (h.self ? " self" : "");
      const chip = document.createElement("span");
      chip.className = "mw-chip";
      chip.style.background = color;
      chip.textContent = initial;
      const dot = document.createElement("i");
      dot.className = "mw-dot";
      dot.style.background = statusMeta(h.status).css;
      chip.appendChild(dot);

      const label = document.createElement("div");
      label.className = "mw-label";
      if (!h.mic) {
        // a crossed mic reads faster than a colour for "cannot be heard"
        label.insertAdjacentHTML("beforeend",
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
          + ' stroke-linecap="round"><path d="M9 5a3 3 0 0 1 6 0v5"/><path d="M5 11a7 7 0 0 0 10.5 6"/>'
          + '<path d="M19 11a7 7 0 0 1-.6 2.8"/><path d="M12 19v3"/><path d="M3 3l18 18"/></svg>');
      }
      const nm = document.createElement("span");
      nm.textContent = h.name + (h.self ? " " + t("(คุณ)") : "");
      label.appendChild(nm);

      if (h.hand) {
        const hand = document.createElement("i");
        hand.className = "mw-hand";
        hand.textContent = "✋";
        who.appendChild(hand);
      }
      who.append(chip, label);
      who.title = h.mic
        ? t("{name} — {status}", { name: h.name, status: t(statusMeta(h.status).label) })
        : t("{name} — {status} · ปิดไมค์", { name: h.name, status: t(statusMeta(h.status).label) });
      list.appendChild(who);
    }
  }

  /** derive my presence and broadcast it when it changes (called from update, throttled) */
  private updateMyStatus() {
    if (this.time.now - this.statusCheckAt < 500) return;
    this.statusCheckAt = this.time.now;
    // The mic starts off, so treating "mic off" as muted painted everyone red the
    // moment they joined. Red now means you were talking and muted yourself;
    // being present and active reads green.
    if (this.webrtc?.micOn) this.micEverOn = true;
    // broadcast the mic separately from the status: peers need it to tell who can
    // be heard in a meeting, where every status collapses to "meeting"
    const mic = !!this.webrtc?.micOn;
    if (mic !== this.myMicOn) { this.myMicOn = mic; this.room?.send("mic", mic); }
    // away wins: if nobody is at the keyboard, the other states don't say much
    const next =
      // do-not-disturb first: it is the only one the person chose, and a
      // choice should not be overwritten by an observation about them
      this.dnd ? "busy"
      : this.time.now - this.lastActiveAt > AFK_MS ? "afk"
      : (this.myScreenId || this.inMeetingRoom()) ? "meeting"
      : this.micEverOn && this.webrtc && !this.webrtc.micOn ? "muted"
      : "online";
    if (next === this.myStatus) return;
    this.myStatus = next;
    this.setTagStatus(this.myLabel, next);
    this.refreshDeskPlates();
    this.refreshRoster();
    const chipDot = document.querySelector<HTMLElement>("#ava-chip .dot");
    if (chipDot) chipDot.style.background = statusMeta(next).css;
    this.room?.send("status", next);
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
    const status: string = player.status || "online";
    this.setTagStatus(label, status);
    this.remotes.set(sessionId, { sprite, label, name, status, tx: player.x, ty: player.y, dir: player.dir, moving: player.moving, avatar: av });

    // Point at somebody and their card comes up, which is the gesture people
    // already try. A short delay first, or sweeping the mouse across a busy
    // room flashes a card per person on the way past.
    sprite.setInteractive({ pixelPerfect: false });
    sprite.on("pointerover", () => {
      window.clearTimeout(this.cardTimer);
      this.cardTimer = window.setTimeout(() => void this.openPersonCard(sessionId), 140);
    });
    sprite.on("pointerout", () => this.scheduleCardClose());
    // and clicking is the impatient version of hovering
    sprite.on("pointerdown", () => {
      window.clearTimeout(this.cardTimer);
      void this.openPersonCard(sessionId);
    });
    if (isLpc(av)) void this.ensureLpc(av).then((key) => {
      const r = this.remotes.get(sessionId);
      if (key && r) r.sprite.setTexture(key, this.idleFrameFor(av, r.dir));
    });
  }

  private removeRemote(sessionId: string) {
    // watching an empty spot is worse than not watching: come home instead
    if (this.following === sessionId) { this.following = ""; this.cameraFree = true; this.followMeAgain(); }
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

  /** nearest chair to the player, within ~1.5 tiles (else undefined) */
  private chairNearPlayer(): Phaser.GameObjects.Image | undefined {
    let best: Phaser.GameObjects.Image | undefined, bd = (1.5 * TILE) ** 2;
    for (const c of this.chairs) {
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
      if (taken) { this.toast(t("โต๊ะนี้มีเจ้าของแล้ว"), "warn"); return; }
    }
    this.myDesk = next;
    this.deskClaimAt = this.time.now;
    this.room.send("claimDesk", next);
    this.saveDesk(next);
    this.refreshDeskPlates();
    if (next) this.toast(t("จองโต๊ะนี้เป็นโต๊ะของคุณแล้ว"), "success");
    else this.toast(t("ยกเลิกการจองโต๊ะแล้ว"), "info");
  }

  /** persist the chosen desk: member -> API, everyone -> localStorage */
  private saveDesk(deskId: string) {
    try { localStorage.setItem(wsKey("nexspace-desk"), deskId); } catch { /* ignore */ }
    const token = localStorage.getItem("nexspace-token");
    if (token) {
      fetch(`${AUTH_API}/me/desk`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ workspace: WORKSPACE, desk: deskId }),
      }).catch(() => {});
    }
  }

  /** redraw owner nameplates over every claimed desk (shared: reads room state) */
  private refreshDeskPlates() {
    for (const t of this.deskPlates.values()) t.destroy();
    this.deskPlates.clear();
    if (!this.room) return;
    const owners = new Map<string, { name: string; status: string }>();
    // peers come from room state; my own claim comes from local state because the
    // server round-trip lags the click (state still holds my previous desk here)
    this.room.state.players.forEach((p: any, sid: string) => {
      if (sid === this.mySessionId) return;
      if (p.desk) owners.set(p.desk, { name: p.name || "?", status: p.status || "online" });
    });
    if (this.myDesk) owners.set(this.myDesk, { name: this.myName, status: this.myStatus });
    for (const d of DESKS) {
      const owner = owners.get(d.id);
      if (!owner) continue;
      const mine = d.id === this.myDesk;
      const t = this.makeNameTag(d.x * TILE + TILE / 2, d.y * TILE - 12, owner.name, mine).setDepth(99000);
      this.setTagStatus(t, owner.status); // plate mirrors the owner's presence
      this.deskPlates.set(d.id, t);
    }
  }

  /** teleport to my desk's seat and sit down */
  private goToMyDesk() {
    if (!this.myDesk) { this.toast(t("ยังไม่ได้เลือกโต๊ะ — คลิกที่โต๊ะเพื่อจอง"), "info"); return; }
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
    // "info" was a chair back when the only thing worth saying was about a desk.
    // Seven of the nine info toasts have nothing to do with furniture.
    ico.textContent = kind === "success" ? "✓" : kind === "warn" ? "!" : "i";
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

  /**
   * Which way a chair faces, from its texture key.
   *
   * Still needed after chair-turning went away: sitting down faces you the way
   * the seat does, which is the whole reason the art has eight directions.
   */
  private getChairDirIndex(obj: Phaser.GameObjects.Image): number {
    const texKey = obj.texture.key;
    for (let i = 0; i < CHAIR_DIRS.length; i++) {
      if (texKey.endsWith(`-${CHAIR_DIRS[i]}`)) return i;
    }
    return 0; // default south
  }

  // ------------------------------------------------------------ click to move
  /** tiles with no wall and no solid prop body over them */
  private buildWalkable(walls: Set<string>, solids: Phaser.Physics.Arcade.StaticGroup) {
    const grid: boolean[][] = [];
    for (let y = 0; y < ROWS; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < COLS; x++) row.push(!walls.has(`${x},${y}`));
      grid.push(row);
    }
    for (const o of solids.getChildren()) {
      const b = (o as Phaser.Physics.Arcade.Sprite).body as Phaser.Physics.Arcade.StaticBody | null;
      if (!b) continue;
      // -1 on the far edges: a body ending exactly on a boundary does not occupy the next tile
      for (let y = Math.floor(b.top / TILE); y <= Math.floor((b.bottom - 1) / TILE); y++)
        for (let x = Math.floor(b.left / TILE); x <= Math.floor((b.right - 1) / TILE); x++)
          if (grid[y]?.[x] !== undefined) grid[y][x] = false;
    }
    return grid;
  }

  private canStand(x: number, y: number) {
    return !!this.walkable[y]?.[x];
  }

  /**
   * A* across the tile grid, eight directions. A diagonal is only allowed when
   * both of its orthogonal neighbours are clear, or routes would slip through
   * the corner between two walls that the physics body cannot actually pass.
   */
  private findPath(sx: number, sy: number, tx: number, ty: number) {
    if (!this.canStand(tx, ty) || (sx === tx && sy === ty)) return [];
    const key = (x: number, y: number) => y * COLS + x;
    const h = (x: number, y: number) => Math.hypot(x - tx, y - ty);
    const came = new Map<number, number>();
    const g = new Map<number, number>([[key(sx, sy), 0]]);
    const open: { x: number; y: number; f: number }[] = [{ x: sx, y: sy, f: h(sx, sy) }];
    const done = new Set<number>();

    while (open.length) {
      // the grid is under a thousand tiles, so scanning for the best node is
      // cheaper than maintaining a heap
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      const ck = key(cur.x, cur.y);
      if (done.has(ck)) continue;
      done.add(ck);

      if (cur.x === tx && cur.y === ty) {
        const out: { x: number; y: number }[] = [];
        for (let k: number | undefined = ck; k !== undefined; k = came.get(k)) {
          out.push({ x: k % COLS, y: Math.floor(k / COLS) });
        }
        out.reverse();
        return out.slice(1); // drop the tile we are already standing on
      }

      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (!this.canStand(nx, ny)) continue;
        if (dx && dy && (!this.canStand(cur.x + dx, cur.y) || !this.canStand(cur.x, cur.y + dy))) continue;
        const nk = key(nx, ny);
        if (done.has(nk)) continue;
        const step = dx && dy ? Math.SQRT2 : 1;
        const ng = (g.get(ck) ?? Infinity) + step;
        if (ng >= (g.get(nk) ?? Infinity)) continue;
        g.set(nk, ng);
        came.set(nk, ck);
        open.push({ x: nx, y: ny, f: ng + h(nx, ny) });
      }
    }
    return [];
  }

  /** the clicked tile, or the closest standable one to it if that is blocked */
  private nearestStandable(tx: number, ty: number) {
    if (this.canStand(tx, ty)) return { x: tx, y: ty };
    for (let r = 1; r <= 4; r++) {
      let best: { x: number; y: number } | null = null, bestD = Infinity;
      for (let y = ty - r; y <= ty + r; y++) {
        for (let x = tx - r; x <= tx + r; x++) {
          if (Math.max(Math.abs(x - tx), Math.abs(y - ty)) !== r || !this.canStand(x, y)) continue;
          const d = Math.hypot(x - tx, y - ty);
          if (d < bestD) { bestD = d; best = { x, y }; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  private clearPath() {
    this.path = [];
    this.moveMarker?.destroy();
    this.moveMarker = undefined;
  }

  /** walk to a world position, routing around walls and furniture */
  /**
   * Take the camera back to the player after a drag left it somewhere else.
   *
   * Moving is the signal: someone who walks after looking around wants to see
   * where they are going, and the alternative is walking off the edge of a view
   * that never follows.
   */
  private followMeAgain() {
    if (!this.cameraFree || this.panning) return;
    this.following = "";
    this.cameraFree = false;
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
  }

  private walkTo(worldX: number, worldY: number) {
    this.followMeAgain();
    const goal = this.nearestStandable(Math.floor(worldX / TILE), Math.floor(worldY / TILE));
    if (!goal) return;
    const from = { x: Math.floor(this.player.x / TILE), y: Math.floor(this.player.y / TILE) };
    const tiles = this.findPath(from.x, from.y, goal.x, goal.y);
    if (!tiles.length) return;

    this.clearPath();
    if (this.sitting) this.standUp();
    this.path = tiles.map((t) => ({ x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE / 2 }));

    const last = this.path[this.path.length - 1];
    this.moveMarker = this.add.circle(last.x, last.y, 9).setStrokeStyle(2, 0x2bb3a3, 0.9).setDepth(99998);
    this.tweens.add({ targets: this.moveMarker, scale: 0.5, alpha: 0.35, duration: 420, yoyo: true, repeat: -1 });
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

    // the keys always win: pressing one drops whatever route was running
    if (vx !== 0 || vy !== 0) { this.clearPath(); this.followMeAgain(); }
    else if (this.path.length) {
      const wp = this.path[0];
      const dx = wp.x - this.player.x, dy = wp.y - this.player.y;
      if (Math.hypot(dx, dy) < 4) {
        this.path.shift();
        if (!this.path.length) this.clearPath(); // arrived
      } else {
        // step in one of the eight directions, exactly as the keys would, so the
        // walk animation and facing come out the same as manual movement
        vx = Math.abs(dx) > 2 ? Math.sign(dx) : 0;
        vy = Math.abs(dy) > 2 ? Math.sign(dy) : 0;
      }
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
    this.updateMyStatus();
    this.refreshMeetingPanel();

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
    // a connection already open is kept until they are clearly out of range
    const keep2 = (this.NEAR * 1.4) * (this.NEAR * 1.4);
    const FULL = 2 * TILE; // distance for full audio volume
    this.holdTheDoor();
    this.updateArea();
    const mine = this.myArea;
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
      const theirs = this.areaOf(r.sprite.x, r.sprite.y);
      // Inside an area, distance stops counting in both directions. Outside, it
      // is the radius — and anyone standing in an area is out of earshot of it.
      const near = canHear(mine, theirs, d2 <= near2);
      if (near) { anyNear = true; }
      // Whoever cannot hear you is drawn faded, so "who is in this conversation"
      // is answered by looking rather than by trying and getting no reply.
      const dim = !!mine && theirs?.id !== mine.id ? 0.4 : 1;
      r.sprite.setAlpha(dim);
      r.label.setAlpha(dim);
      // Hysteresis on the media connection only — the ring and the volume still
      // follow the real radius. syncPeers runs every frame, so a single radius
      // meant standing on the line rebuilt the peer connection frame after
      // frame, and audio spends the first seconds of a connection catching up.
      //
      // "Already connected" is asked of the media manager, not remembered here. A
      // connection can also begin with the other side's offer, and one this pass
      // had not asked for would be dropped on the very next frame — which is a
      // connection built and destroyed forever, in the band between the two radii.
      // The hysteresis is for the radius only. An area boundary is a hard edge,
      // and softening it would leak the room for the seconds a connection takes
      // to wind down.
      const onFloor = !mine && !theirs;
      if (near || (onFloor && d2 <= keep2 && !!this.webrtc?.hasPeer(id))) nearbyIds.add(id);
      if (near && !r.ring) r.ring = this.add.circle(0, 0, 15).setStrokeStyle(2, 0x2bb3a3, 0.9).setDepth(1);
      if (r.ring) r.ring.setVisible(near).setPosition(r.sprite.x, r.sprite.y + 18);

      // Spatial audio: loudest close by, fading to silence at the proximity edge.
      // Applied to anyone we hold a connection to, not only those inside the
      // radius — a peer kept open by the hysteresis above would otherwise still be
      // playing at whatever volume they had when they crossed the line.
      if (near || this.webrtc?.hasPeer(id)) {
        const dist = Math.sqrt(d2);
        // The connection stays up while silenced, so turning it off is instant
        // and the other person is never told they were muted — which is a
        // thing about them, not about us.
        // Sharing an area is a conversation, not a soundscape: the far end of the
        // meeting room is as loud as the near end, which is the whole point of
        // standing in one.
        const vol = this.dnd ? 0
          : (near && mine) ? 1
          : dist <= FULL ? 1 : 1 - (dist - FULL) / (this.NEAR - FULL);
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
      if (near) { const l = document.getElementById("interact-label"); if (l) l.textContent = t(near.label); }
    }
  }
}
