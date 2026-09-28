// Who may speak to the whole map at once, who holds that floor right now, and
// when they lose it.
//
// Kept apart from the room for the same reason the cabinet rule is kept apart
// from its routes: it is the part worth testing, and a rule that can only be
// exercised by opening a socket and talking into a microphone is a rule that
// never gets exercised. The clock is injected for the same reason — the five
// minute cut-off is the most important line in this file and the hardest thing
// to sit and wait for.
//
// Nothing here knows about audio. Broadcasting is not a change to who can hear
// whom — `canHear` in areas.ts is untouched, and stays the only answer to that
// question. This decides one thing: whether this person may take the floor.
// What the browsers then do about it is a separate layer, and deliberately so:
// it is what keeps a meeting room from becoming listenable. Everybody
// subscribes to the broadcaster; the broadcaster subscribes to nobody.

/** how long a broadcast may run before the room takes the floor back */
export const MAX_ON_AIR_MS = 5 * 60 * 1000;

/**
 * Why not, or "no" for no reason not to.
 *
 * Phrased as the refusal rather than a boolean because the browser says
 * something different for each: one is "this is not yours to do", the other is
 * "somebody else is talking", and a person reads them differently.
 */
export type Refusal = "no" | "not-allowed" | "someone-else";

/** how a broadcast ended, for the line the listeners are shown */
export type Why = "stopped" | "timeout" | "gone";

/**
 * A broadcast is a privilege, so it is owner and admin only.
 *
 * Not members: a voice that reaches the whole floor and cannot be walked away
 * from is the one thing in this space nobody can ignore, and that is not a
 * button everybody should have. Not guests either, which the role check covers
 * without naming them.
 *
 * This also means nobody can broadcast in the shared public space, where the
 * room hands every arrival the "member" role. That is the right outcome for a
 * lobby anybody can walk into.
 */
export function refuseOnAir(
  role: string | undefined,
  /** whoever holds the floor on this map, or null if it is free */
  heldBy: string | null,
  me: string,
): Refusal {
  if (role !== "owner" && role !== "admin") return "not-allowed";
  // Asking again while you already hold it is not a refusal — it is a no-op,
  // and answering "somebody else is talking" with their own name would be a
  // strange thing to read.
  if (heldBy && heldBy !== me) return "someone-else";
  return "no";
}

/** enough of Colyseus's clock to set a timer and take it back */
export interface Timers {
  setTimeout(run: () => void, ms: number): { clear(): void };
}

/** what the room does when a floor changes hands: set the flag, tell the room */
export type Said = (e: { map: string; by: string; on: boolean; why?: Why; until?: number }) => void;

/**
 * The floors of a space, and who is speaking on each.
 *
 * One floor per map, not one per room: a space can be several storeys of a
 * building, and an announcement on the third floor is not an announcement on
 * the first. Keyed by the map the speaker stood on when they started — which
 * is also why walking through a portal ends it.
 *
 * Every way out goes through `drop`, because an ending that forgot to cancel
 * the timer would take the floor back off whoever holds it next. That is the
 * whole reason this is a class and not three lines in the room.
 */
export class Floors {
  private held = new Map<string, { by: string; at: number; timer: { clear(): void } }>();
  private timers: Timers;
  private said: Said;
  private now: () => number;

  /**
   * Written out rather than as constructor parameter properties, which is the
   * shorter way to say the same thing. Node runs this file directly, stripping
   * the types without compiling, and a parameter property is not a type — it is
   * syntax that has to generate code. The end-to-end suite imports MAX_ON_AIR_MS
   * from here so its "five minutes" is the same five minutes the server uses,
   * and that import is what this keeps working.
   */
  constructor(timers: Timers, said: Said, now: () => number = () => Date.now()) {
    this.timers = timers;
    this.said = said;
    this.now = now;
  }

  heldBy(map: string): string | null {
    return this.held.get(map)?.by ?? null;
  }

  /**
   * Give this person the floor, and say when it will be taken back.
   *
   * Returns null when they already have it: asking twice is not an event, and
   * announcing it again would chime at everybody for nothing.
   */
  take(map: string, who: string): { until: number } | null {
    const already = this.held.get(map);
    if (already?.by === who) return null;
    if (already) this.drop(map, "stopped");   // only reachable if a caller skipped refuseOnAir
    const at = this.now();
    const until = at + MAX_ON_AIR_MS;
    this.held.set(map, {
      by: who, at,
      timer: this.timers.setTimeout(() => this.drop(map, "timeout"), MAX_ON_AIR_MS),
    });
    this.said({ map, by: who, on: true, until });
    return { until };
  }

  drop(map: string, why: Why): void {
    const held = this.held.get(map);
    if (!held) return;
    held.timer.clear();
    this.held.delete(map);
    this.said({ map, by: held.by, on: false, why });
  }

  /** whatever floor this person holds, wherever they hold it */
  dropAnyOf(who: string, why: Why): void {
    for (const [map, held] of [...this.held]) if (held.by === who) this.drop(map, why);
  }
}
