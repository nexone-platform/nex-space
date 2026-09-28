/**
 * The floor: who may take it, who may not, and every way it is given back.
 *
 * Worth checking because the failures here are all quiet ones. A refusal that
 * does not refuse is a member talking over the whole office. A timer that does
 * not fire is a microphone left open to every room in the building by somebody
 * who walked away from their desk believing they had stopped. Neither throws,
 * neither shows up in a log, and both need a second person in a second browser
 * to notice at all.
 *
 * The clock is a fake, so the five-minute cut-off is tested in a millisecond
 * rather than trusted because the number looks right.
 *
 *   npm run check:onair -w @nexspace/game-server
 */
import { Floors, refuseOnAir, MAX_ON_AIR_MS, type Why } from "../src/onair.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x = "") => {
  c ? pass++ : fail++;
  console.log(`${c ? "  PASS" : "! FAIL"}  ${n}${x ? "  " + x : ""}`);
};

console.log("\nspeaking to the whole map\n");

// ---- who may ----------------------------------------------------------------------
ok("the owner may take the floor", refuseOnAir("owner", null, "a") === "no");
ok("  · and an admin", refuseOnAir("admin", null, "a") === "no");
ok("  · a member may not", refuseOnAir("member", null, "a") === "not-allowed");
ok("  · nor a guest", refuseOnAir("guest", null, "a") === "not-allowed");
ok("  · nor a client that sends no role at all",
  refuseOnAir(undefined, null, "a") === "not-allowed",
  "a socket that talks to the room directly has whatever role the API gave it, or none");

ok("one at a time", refuseOnAir("admin", "b", "a") === "someone-else");
ok("  · and rank does not jump the queue", refuseOnAir("owner", "b", "a") === "someone-else",
  "an owner cutting across an admin mid-sentence is worse than waiting");
ok("  · asking again while already holding it is not a refusal",
  refuseOnAir("admin", "a", "a") === "no");
ok("  · a member is refused before the floor is even looked at",
  refuseOnAir("member", null, "a") === "not-allowed" && refuseOnAir("member", "b", "a") === "not-allowed");

// ---- the clock, and every way back off the floor -----------------------------------
type Event = { map: string; by: string; on: boolean; why?: Why; until?: number };

/** a clock that only moves when this test moves it */
const fakeTimers = () => {
  let at = 0;
  const due: { fire: () => void; when: number; dead: boolean }[] = [];
  return {
    now: () => at,
    timers: {
      setTimeout(run: () => void, ms: number) {
        const e = { fire: run, when: at + ms, dead: false };
        due.push(e);
        return { clear() { e.dead = true; } };
      },
    },
    tick(ms: number) {
      at += ms;
      for (const e of [...due]) if (!e.dead && e.when <= at) { e.dead = true; e.fire(); }
    },
    pending: () => due.filter((e) => !e.dead).length,
  };
};

const bench = () => {
  const clock = fakeTimers();
  const said: Event[] = [];
  const floors = new Floors(clock.timers, (e) => said.push(e as Event), clock.now);
  return { clock, said, floors };
};

{
  const { floors, said } = bench();
  const got = floors.take("main", "a");
  ok("taking it is announced", said.length === 1 && said[0].on && said[0].by === "a");
  ok("  · with the moment it will end on it",
    got?.until === MAX_ON_AIR_MS && said[0].until === MAX_ON_AIR_MS,
    "the countdown in front of the speaker is the reason they remember to stop");
  ok("  · and taking it twice says nothing the second time",
    floors.take("main", "a") === null && said.length === 1);
}

{
  const { floors, said } = bench();
  floors.take("main", "a");
  floors.drop("main", "stopped");
  ok("stopping gives it back", floors.heldBy("main") === null);
  ok("  · and is announced with a reason", said[1]?.on === false && said[1]?.why === "stopped");
  ok("  · stopping again says nothing", (floors.drop("main", "stopped"), said.length === 2));
  ok("  · and the next person can have it", floors.take("main", "b") !== null);
}

{
  const { floors, clock, said } = bench();
  floors.take("main", "a");
  clock.tick(MAX_ON_AIR_MS - 1);
  ok("it is still theirs a millisecond before the limit", floors.heldBy("main") === "a");
  clock.tick(1);
  ok("  · and the room takes it back on the limit", floors.heldBy("main") === null,
    `${MAX_ON_AIR_MS / 60000} minutes`);
  ok("  · saying so, and why", said[1]?.on === false && said[1]?.why === "timeout");
}

{
  // The two broadcasts are deliberately staggered. Started at the same instant
  // they would expire at the same instant too, and the bug this is here to
  // catch — a's timer still running and cutting b off — would look exactly like
  // b's own timer doing its job.
  const { floors, clock } = bench();
  floors.take("main", "a");
  floors.drop("main", "stopped");
  clock.tick(MAX_ON_AIR_MS / 2);
  floors.take("main", "b");
  clock.tick(MAX_ON_AIR_MS / 2);            // a's original deadline; b is halfway through
  ok("a finished broadcast's timer cannot cut off the next one",
    floors.heldBy("main") === "b",
    "left running, it would take the floor off b mid-sentence at a's five minutes");
  clock.tick(MAX_ON_AIR_MS / 2);            // b's own deadline
  ok("  · and b still gets the whole five minutes", floors.heldBy("main") === null);
}

{
  const { floors, clock } = bench();
  floors.take("main", "a");
  floors.drop("main", "stopped");
  ok("  · and nothing is left ticking", clock.pending() === 0);
}

{
  const { floors, said } = bench();
  floors.take("main", "a");
  floors.dropAnyOf("a", "gone");
  ok("leaving the room ends it", floors.heldBy("main") === null && said[1]?.why === "gone",
    "a closed tab is the likeliest ending and the one with nothing left to end it");
  ok("  · and someone else leaving ends nothing",
    (floors.take("main", "b"), floors.dropAnyOf("c", "gone"), floors.heldBy("main") === "b"));
}

// ---- floors are floors -------------------------------------------------------------
{
  const { floors } = bench();
  floors.take("main", "a");
  ok("an announcement upstairs is not one downstairs",
    refuseOnAir("admin", floors.heldBy("second"), "b") === "no",
    "one space, several maps — b may speak on the second floor while a speaks on the first");
  floors.take("second", "b");
  ok("  · and both hold their own", floors.heldBy("main") === "a" && floors.heldBy("second") === "b");
  floors.dropAnyOf("a", "gone");
  ok("  · a leaving frees only the floor a was on",
    floors.heldBy("main") === null && floors.heldBy("second") === "b");
}

{
  const { floors, said } = bench();
  floors.take("main", "a");
  floors.take("second", "a");
  floors.dropAnyOf("a", "gone");
  ok("walking through a portal drops the floor behind you",
    floors.heldBy("main") === null && floors.heldBy("second") === null,
    "held on a map its speaker is not standing on, it could never be taken back");
  ok("  · both endings announced", said.filter((e) => !e.on).length === 2);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
