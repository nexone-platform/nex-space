// Who you can hear, how loudly, and who your browser therefore has to hold a
// connection to.
//
// Pulled out of the scene's update loop, where it had grown into the most
// consequential rule in the app and the only one with no test against it. It
// cost a broadcast: announcing opened a connection from every listener to the
// speaker, and the speaker's own next frame closed every one of them again,
// because nothing on the speaker's side said those people should be reachable.
// The rule was right in one direction and absent in the other, which is a thing
// a diagram would have shown and a running room did not — the bar appeared, the
// countdown ran, and nobody heard anything.
//
// Two ideas live here and they are not the same idea:
//
//   · WHO YOU HEAR is canHear, in areas.ts, and this file never widens it.
//     A broadcast is added on top as a separate one-way permission.
//   · WHO YOU CONNECT TO is bigger than who you hear. A screen-share presenter
//     and a broadcaster both need a connection to people who cannot hear them.
//     That asymmetry is the whole reason connect and volume are answered
//     separately below, and why a connection held open for sending must never
//     become a way to listen into a room the rule just closed.
import { canHear, type PrivateArea } from "./areas";

const TILE = 32;
/** how far a voice carries out on the open floor */
export const NEAR = 5 * TILE;
/** and how close it has to be to arrive at full volume */
export const FULL = 2 * TILE;
/**
 * A connection already open is kept a little past the radius.
 *
 * syncPeers runs every frame, so a single radius meant standing on the line
 * rebuilt the peer connection frame after frame — and audio spends the first
 * seconds of a connection catching up. The slack is for distance only. An area
 * boundary is a hard edge, and softening it would leak the room for as long as
 * a connection takes to wind down.
 */
export const KEEP = NEAR * 1.4;
/** how far the conversation around you steps back under an announcement */
export const DUCK = 0.25;

export interface Listener {
  /** the private area I am standing in, if any */
  area?: PrivateArea;
  /** do-not-disturb: I have chosen to hear nobody */
  dnd: boolean;
  /** I have silenced the announcement that is running */
  muted: boolean;
}

export interface Speaker {
  /** the private area they are standing in, if any */
  area?: PrivateArea;
  /** pixels between us */
  dist: number;
  /** they hold the floor: speaking to the whole map */
  onAir: boolean;
  /** a media connection to them is open right now */
  connected: boolean;
}

export interface Hearing {
  /** the plain rule: same room, or close enough */
  near: boolean;
  /** hold a media connection to them */
  connect: boolean;
  /** subscribe to their voice whatever the distance and whatever the walls */
  hearAnyway: boolean;
  /** 0..1, before any ducking */
  volume: number;
  /** they are part of the conversation I am standing in */
  inConversation: boolean;
}

export function hearing(me: Listener, them: Speaker): Hearing {
  const near = canHear(me.area, them.area, them.dist <= NEAR);
  // Silencing an announcement silences it here rather than refusing the
  // subscription, so that unmuting is instant and the speaker is never told.
  const onAir = them.onAir && !me.muted;
  const onFloor = !me.area && !them.area;

  return {
    near,
    connect: near || (onFloor && them.dist <= KEEP && them.connected),
    hearAnyway: onAir,
    // A broadcaster is not in your conversation however loudly you hear them.
    // Counting them would draw a ring round the pair of you and tell you both
    // you were talking.
    inConversation: near && !them.onAir,
    volume:
      // Full volume from anywhere, and not silenced by do-not-disturb: that
      // switch means "do not start a conversation with me", and an announcement
      // to the whole office that quietly did not arrive is worse than one you
      // can turn off — which muting it does, for that one announcement.
      onAir ? 1
      // canHear has already answered this. A connection held open for another
      // reason — presenting, or announcing — exists to SEND, and must never
      // become a way to listen into a room the rule just closed.
      : !near ? 0
      : me.dnd ? 0
      // Sharing a room is a conversation, not a soundscape: the far end of the
      // meeting room is as loud as the near end, which is the point of being in
      // one.
      : me.area ? 1
      : them.dist <= FULL ? 1
      : Math.max(0, 1 - (them.dist - FULL) / (NEAR - FULL)),
  };
}

/**
 * Whether I must hold a connection to everybody on the map, however far away
 * and whatever room they are in.
 *
 * Both cases are one shape: something of mine has to reach people who cannot
 * hear me. Presenting was already here. Announcing was not, and its absence is
 * what made the first broadcast silent — a mesh connection needs both ends, and
 * only the listening end was asking for it.
 */
export const mustReachEveryone = (me: { onAir: boolean; presenting: boolean }): boolean =>
  me.onAir || me.presenting;
