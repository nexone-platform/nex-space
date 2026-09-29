/**
 * Who hears whom, how loudly, and who has to stay connected.
 *
 * This is the rule the whole product rests on and it had no test until it broke
 * one. A broadcast reached nobody: every listener opened a connection to the
 * speaker, and the speaker's own next frame closed every one of them, because
 * the speaker's side of the loop had no reason to keep them. Nothing threw. The
 * bar appeared, the countdown ran, and the room was silent.
 *
 * What makes that shape of bug invisible is that hearing and connecting are two
 * different questions and look like one. So both are asked here, from both
 * ends, for every case — and the pair of cases marked "both ends" is the whole
 * reason the file exists.
 *
 *   npm run check:earshot -w @nexspace/web
 */
import { hearing, mustReachEveryone, NEAR, FULL, KEEP, DUCK } from "../src/scenes/earshot.js";
import type { PrivateArea } from "../src/scenes/areas.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};
const near = (v: number, want: number) => Math.abs(v - want) < 0.001;

const MEETING: PrivateArea = { id: "meeting", label: "ห้องประชุม", x0: 21, y0: 4, x1: 26, y1: 9 };
const LOUNGE: PrivateArea = { id: "lounge", label: "โซนพักผ่อน", x0: 5, y0: 4, x1: 10, y1: 9 };

/** somebody standing on the open floor, hearing normally */
const floor = { dnd: false, muted: false };
/** and somebody to be heard, saying nothing special */
const plain = { dist: 0, onAir: false, connected: false };

console.log("\nwho hears whom\n");

// ---- the plain rule, unchanged ------------------------------------------------------
{
  const close = hearing(floor, { ...plain, dist: FULL });
  ok("close by on the open floor is full volume", close.near && near(close.volume, 1));
  ok("  · and in the conversation", close.inConversation);

  const edge = hearing(floor, { ...plain, dist: NEAR });
  ok("at the edge of the radius it has faded to nothing", near(edge.volume, 0), `${edge.volume}`);

  const half = hearing(floor, { ...plain, dist: (FULL + NEAR) / 2 });
  ok("  · and halfway there, to half", near(half.volume, 0.5), `${half.volume}`);

  const away = hearing(floor, { ...plain, dist: NEAR + 1 });
  ok("past it, nothing at all", !away.near && !away.connect && near(away.volume, 0));
}

{
  const inside = hearing({ ...floor, area: MEETING }, { ...plain, area: MEETING, dist: NEAR * 3 });
  ok("the far corner of a room is as loud as the near end", inside.near && near(inside.volume, 1),
    "a room is a conversation, not a soundscape");

  const outside = hearing({ ...floor, area: MEETING }, { ...plain, area: undefined, dist: 8 });
  ok("somebody a step outside the door is not heard", !outside.near && near(outside.volume, 0));

  const other = hearing({ ...floor, area: MEETING }, { ...plain, area: LOUNGE, dist: 8 });
  ok("  · nor somebody in a different room", !other.near && near(other.volume, 0));

  const fromOutside = hearing(floor, { ...plain, area: MEETING, dist: 8 });
  ok("  · and standing outside, the room is not overheard", !fromOutside.near);
}

{
  const held = hearing(floor, { ...plain, dist: KEEP - 1, connected: true });
  ok("a connection already open is kept a little past the radius", held.connect && !held.near);
  ok("  · but silent while it is", near(held.volume, 0),
    "the slack is so the connection is not rebuilt every frame, not so you hear further");
  const fresh = hearing(floor, { ...plain, dist: KEEP - 1, connected: false });
  ok("  · and one not yet open is not opened out there", !fresh.connect);
  const acrossAWall = hearing({ ...floor, area: MEETING }, { ...plain, area: undefined, dist: 8, connected: true });
  ok("  · the slack never applies across a room's edge", !acrossAWall.connect,
    "softening a wall would leak the room for as long as a connection takes to close");
}

{
  const dnd = hearing({ ...floor, dnd: true }, { ...plain, dist: 8 });
  ok("do-not-disturb silences the room", near(dnd.volume, 0));
  ok("  · without dropping the connection", dnd.connect,
    "so turning it off is instant, and nobody is told they were muted");
}

// ---- a broadcast, from both ends ----------------------------------------------------
console.log("\nand a broadcast\n");

{
  const far = hearing(floor, { dist: NEAR * 10, onAir: true, connected: false });
  ok("a broadcast is heard from the other end of the map", far.hearAnyway && near(far.volume, 1));
  const walled = hearing({ ...floor, area: MEETING }, { area: LOUNGE, dist: NEAR * 4, onAir: true, connected: false });
  ok("  · and through the wall of a room you are sitting in", walled.hearAnyway && near(walled.volume, 1),
    "the case this was reported broken on");
  ok("  · while canHear still says no", !walled.near,
    "the broadcast is laid over the rule, never folded into it");
  ok("  · so it is not your conversation", !walled.inConversation);
}

{
  // The other direction of the same moment: what the ROOM sends is not opened up
  // by somebody announcing at it.
  const back = hearing(floor, { area: MEETING, dist: 8, onAir: false, connected: true });
  ok("the room is still sealed the other way", near(back.volume, 0),
    "everybody subscribes to the speaker; the speaker subscribes to nobody");
}

{
  const dnd = hearing({ ...floor, dnd: true }, { dist: NEAR * 10, onAir: true, connected: false });
  ok("do-not-disturb does not silence an announcement", near(dnd.volume, 1),
    "it means do not start a conversation with me — flip this one line to change that");
  const muted = hearing({ ...floor, muted: true }, { dist: NEAR * 10, onAir: true, connected: false });
  ok("  · but muting that one announcement does", !muted.hearAnyway && near(muted.volume, 0));
}

// ---- both ends: the bug itself ------------------------------------------------------
{
  ok("somebody announcing must reach everybody",
    mustReachEveryone({ onAir: true, presenting: false }),
    "a mesh connection needs both ends to want it — this is the end that was missing");
  ok("  · as must somebody presenting", mustReachEveryone({ onAir: false, presenting: true }));
  ok("  · and somebody doing neither reaches only who they can hear",
    !mustReachEveryone({ onAir: false, presenting: false }));
}

{
  // The full round trip, written out, because reading it in two places is how it
  // was wrong in the first place.
  const listenerSide = hearing({ ...floor, area: MEETING }, { area: undefined, dist: NEAR * 6, onAir: true, connected: false });
  const speakerReaches = mustReachEveryone({ onAir: true, presenting: false });
  ok("a speaker in the hall and a listener in a meeting: both ends agree",
    listenerSide.hearAnyway && speakerReaches,
    "listener subscribes, speaker holds the connection open — one without the other is silence");
}

// ---- ducking ------------------------------------------------------------------------
{
  const other = hearing(floor, { ...plain, dist: FULL });
  ok("the conversation around you ducks under an announcement",
    near(other.volume * DUCK, 0.25), `${other.volume * DUCK}`);
  const air = hearing(floor, { dist: NEAR * 10, onAir: true, connected: false });
  ok("  · and the announcement does not duck under itself",
    near(air.volume * (air.hearAnyway ? 1 : DUCK), 1));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
