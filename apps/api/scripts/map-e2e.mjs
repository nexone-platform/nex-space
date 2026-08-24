#!/usr/bin/env node
/**
 * A map a space can store, instead of one only we can compile.
 *
 * The thing worth pinning down is the door and the validator, in that order. A
 * stored map is handed to every browser that opens the space and to the room
 * server that decides who hears whom, so a bad one is not a bad record — it is
 * a room nobody can walk into, for everybody, at once. Which means: only owners
 * and admins may write one, and nothing that is not a map may be written at all.
 *
 * The map here is hand-written rather than baked from one of the built-in
 * themes on purpose. If the test used the same code the app uses to produce a
 * map, it could only ever prove that code agrees with itself.
 *
 *   npm run dev                       # API on 3001, game server on 2567
 *   node apps/api/scripts/map-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { Client } from "colyseus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3989;
const API = `http://127.0.0.1:${PORT}`;
const GAME = "ws://localhost:2567";
const TILE = 32;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, path, { body, token, base = API } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const get = (p, o) => call("GET", p, o);
const post = (p, body, token) => call("POST", p, { body, token });
const put = (p, body, o) => call("PUT", p, { body, ...o });
const del = (p, o) => call("DELETE", p, o);

// ---- a map, written by hand ---------------------------------------------------

// Deliberately bigger than the five-tile proximity radius. A boardroom small
// enough to fit inside the radius would "carry across" whether the stored map's
// areas reached the room server or not, and the test would prove nothing.
const COLS = 20, ROWS = 16;
/** a walled room from 1,1 to 15,10 with one doorway at 8,10 */
const WALLS = [];
for (let x = 1; x <= 15; x++) { WALLS.push(`${x},1`); WALLS.push(`${x},10`); }
for (let y = 1; y <= 10; y++) { WALLS.push(`1,${y}`); WALLS.push(`15,${y}`); }
const walls = WALLS.filter((w) => w !== "8,10");

const aMap = (over = {}) => ({
  v: 1,
  id: "handmade",
  label: "แผนที่ทดสอบ",
  cols: COLS,
  rows: ROWS,
  spawn: { x: 17, y: 13 },
  meetingRoom: { x0: 2, x1: 14, y0: 2, y1: 9 },
  floors: Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 0)),
  walls,
  furniture: [["desk", 3, 2, true]],
  outdoor: [],
  decals: [],
  decor: [],
  desks: [{ id: "hand-1", x: 3, y: 2, sx: 3, sy: 3 }],
  interactives: [{ type: "whiteboard", x: 2, y: 2, label: "กระดาน", icon: "W" }],
  areas: [{ id: "boardroom", label: "ห้องบอร์ด", x0: 2, y0: 2, x1: 14, y1: 9 }],
  ...over,
});

// ---- servers ------------------------------------------------------------------

for (const port of [PORT, PORT + 1]) {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
    console.error(`! something is already listening on ${port} — stop it first`);
    process.exit(1);
  } catch { /* free, as it should be */ }
}

const serve = (port, env) => spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR, env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"],
});
const waitFor = async (base) => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/health")).ok) return true; } catch { /* not yet */ }
    await settle(500);
  }
  return false;
};

const api = serve(PORT);
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
api.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[api] ${d}`));
const kids = [api];
const stop = () => { for (const k of kids) { try { k.kill(); } catch { /* gone */ } } };
process.on("exit", stop);

console.log("\nstored maps\n");
if (!(await waitFor(API))) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast ---------------------------------------------------------------------

const stamp = Date.now();
const person = async (who) => {
  const d = await post("/auth/register", { email: `map-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });
  return { name: who, token: d.token, id: d.user?.id };
};

const owner = await person("owner");
const admin = await person("admin");
const member = await person("member");
const outsider = await person("outsider");

const ws = (await post("/workspaces", { name: `map-${stamp}`, theme: "office" }, owner.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, admin.token);
await post("/workspaces/join", { code: ws.inviteCode }, member.token);
await call("PATCH", `/workspaces/${ws.slug}/members/${admin.id}`, { body: { role: "admin" }, token: owner.token });

if (!ws?.slug) { console.error("! the fixture space did not come back"); stop(); process.exit(1); }

// ---- with no stored map, the space names its stock layout ---------------------

{
  const r = await get(`/workspaces/${ws.slug}/map`);
  ok("a space with no stored map names its built-in", r.status === 200 && r.builtin === "office",
    `status ${r.status}, builtin ${r.builtin}`);
  ok("  · and hands back no map", r.map === undefined);
}
{
  const r = await get(`/workspaces/nope-${stamp}/map`);
  ok("an unknown space is a 404, not an empty map", r.status === 404, `status ${r.status}`);
}

// ---- the door -----------------------------------------------------------------

{
  const r = await put(`/workspaces/${ws.slug}/map`, { map: aMap() });
  ok("a stranger with no token cannot store a map", r.status === 401, `status ${r.status}`);
}
{
  const r = await put(`/workspaces/${ws.slug}/map`, { map: aMap() }, { token: outsider.token });
  ok("an account that is not in the space cannot", r.status === 403, `status ${r.status}`);
}
{
  const r = await put(`/workspaces/${ws.slug}/map`, { map: aMap() }, { token: member.token });
  ok("a plain member cannot — the map is everyone's", r.status === 403, `status ${r.status}`);
}
{
  const r = await del(`/workspaces/${ws.slug}/map`, { token: member.token });
  ok("  · nor delete one", r.status === 403, `status ${r.status}`);
}

// ---- the validator ------------------------------------------------------------
//
// Each case changes exactly one thing about a map that is otherwise known good,
// so a pass means that field was the reason — not that the whole document was
// rejected for some other fault.

const refused = async (what, map, expect) => {
  const r = await put(`/workspaces/${ws.slug}/map`, { map }, { token: owner.token });
  const said = String(r.problem || "");
  ok(what, r.status === 400 && said.includes(expect), `status ${r.status}, problem "${said}"`);
};

await refused("a map from a future format is refused", aMap({ v: 2 }), "format version");
await refused("  · a missing floors row", aMap({ floors: Array.from({ length: ROWS - 1 }, () => Array(COLS).fill(0)) }), `exactly ${ROWS} rows`);
await refused("  · a short floors row", aMap({ floors: [Array(COLS - 1).fill(0), ...Array.from({ length: ROWS - 1 }, () => Array(COLS).fill(0))] }), `exactly ${COLS} tiles`);
await refused("  · a floor tile with no art behind it", aMap({ floors: [[9, ...Array(COLS - 1).fill(0)], ...Array.from({ length: ROWS - 1 }, () => Array(COLS).fill(0))] }), "outside 0-8");
await refused("  · a wall key that is not a coordinate", aMap({ walls: ["over there"] }), "walls must be strings");
await refused("  · a spawn inside a wall", aMap({ spawn: { x: 1, y: 1 } }), "spawn is inside a wall");
await refused("  · two desks with the same id", aMap({ desks: [{ id: "d", x: 1, y: 1, sx: 1, sy: 2 }, { id: "d", x: 2, y: 1, sx: 2, sy: 2 }] }), "share the id");
await refused("  · two areas with the same id", aMap({ areas: [{ id: "a", label: "x", x0: 1, y0: 1, x1: 2, y1: 2 }, { id: "a", label: "y", x0: 3, y0: 3, x1: 4, y1: 4 }] }), "share the id");
await refused("  · a map with no name", aMap({ label: "  " }), "label must be");
await refused("  · a world too big for one browser", aMap({ cols: 500 }), "between 4 and 200");
// the one that is a security hole rather than a broken room
await refused("an embed pointed at javascript: is refused", aMap({
  interactives: [{ type: "embed", x: 1, y: 1, label: "x", icon: "E", url: "javascript:alert(document.cookie)" }],
}), "url must be https");
await refused("  · and so is a plain http one", aMap({
  interactives: [{ type: "embed", x: 1, y: 1, label: "x", icon: "E", url: "http://example.com" }],
}), "url must be https");
{
  const r = await put(`/workspaces/${ws.slug}/map`, { map: "not a map at all" }, { token: owner.token });
  ok("  · and a string is not a map", r.status === 400, `status ${r.status}`);
}

// nothing above should have got through the door
{
  const r = await get(`/workspaces/${ws.slug}/map`);
  ok("after all of that the space is still on its built-in", r.builtin === "office" && !r.map, JSON.stringify(r).slice(0, 80));
}

// ---- storing one that is a map ------------------------------------------------

{
  const r = await put(`/workspaces/${ws.slug}/map`, { map: aMap() }, { token: owner.token });
  ok("the owner can store a map", r.status === 200, `status ${r.status} ${r.problem ?? ""}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/map`);
  ok("  · and it comes back instead of the built-in", !!r.map && r.builtin === undefined);
  ok("  · unchanged, down to the walls", r.map?.walls?.length === walls.length && r.map?.id === "handmade",
    `${r.map?.walls?.length} walls`);
  ok("  · with the areas the room server reads", r.map?.areas?.[0]?.id === "boardroom");
}
{
  // reading is as open as the space's own record, because every browser in the
  // room is handed the map anyway
  const r = await get(`/workspaces/${ws.slug}/map`, { token: outsider.token });
  ok("anyone who can see the space can read its map", !!r.map);
}
{
  const two = aMap({ label: "รอบสอง", furniture: [] });
  await put(`/workspaces/${ws.slug}/map`, { map: two }, { token: admin.token });
  const r = await get(`/workspaces/${ws.slug}/map`);
  ok("an admin can replace it", r.map?.label === "รอบสอง" && r.map?.furniture?.length === 0, r.map?.label);
}

// ---- a map bigger than a page load -------------------------------------------

{
  // The ceiling is set to the exact size of the known-good map, so the two
  // assertions sit either side of one byte. A blanket "everything is refused"
  // would pass the first of them and prove nothing.
  const exact = JSON.stringify(aMap()).length;
  const small = serve(PORT + 1, { MAP_MAX_BYTES: String(exact) });
  kids.push(small);
  const base = `http://127.0.0.1:${PORT + 1}`;
  const up = await waitFor(base);

  const fits = await put(`/workspaces/${ws.slug}/map`, { map: aMap() }, { token: owner.token, base });
  ok(`a map exactly at the ceiling is stored (${exact} bytes)`, up && fits.status === 200,
    up ? `status ${fits.status}` : "the second API never came up");

  const over = await put(`/workspaces/${ws.slug}/map`, { map: aMap({ label: "แผนที่ทดสอบ!" }) }, { token: owner.token, base });
  ok("  · one byte over it is refused", over.status === 413, `status ${over.status}`);

  small.kill();
  kids.pop();
}

// ---- the room server reads the same endpoint ---------------------------------
//
// The areas on a stored map have to reach the game server, or a custom map is
// private in the browser and public in the chat — the exact split the private
// area work exists to prevent.

const room = { open: [] };
const join = async (name, map) => {
  const r = await new Client(GAME).joinOrCreate("office", { workspace: ws.slug, token: owner.token, name });
  const heard = [];
  r.onMessage("chat", (m) => heard.push(m));
  r.onMessage("roomchat", () => {});
  r.send("map", map);
  room.open.push(r);
  return { name, room: r, heard };
};

/**
 * A second floor, deliberately carrying an area with the SAME id as the first.
 *
 * Two rooms called "boardroom" on different floors are two rooms. If the only
 * thing keeping them apart were the area ids, the cases below would pass on a
 * server that had never heard of maps — which is exactly what the first
 * version of them did.
 */
const second = () => aMap({
  id: "second", label: "ชั้นสอง", cols: 14, rows: 12,
  floors: Array.from({ length: 12 }, () => Array.from({ length: 14 }, () => 2)),
  walls: [], spawn: { x: 12, y: 10 }, meetingRoom: { x0: 2, x1: 10, y0: 2, y1: 8 },
  furniture: [], desks: [], interactives: [],
  areas: [{ id: "boardroom", label: "ห้องบอร์ดชั้นสอง", x0: 2, y0: 2, x1: 10, y1: 8 }],
});

// put both floors in place, then let the room see them for the first time
await put(`/workspaces/${ws.slug}/map/handmade`, { map: aMap() }, { token: owner.token });
await put(`/workspaces/${ws.slug}/map/second`, { map: second() }, { token: owner.token });

let gameUp = true, a, b, upstairs;
try {
  a = await join("a", "handmade");
  b = await join("b", "handmade");
  upstairs = await join("upstairs", "second");
} catch (e) {
  gameUp = false;
  console.log(`  skip  the game server is not running on 2567 — start it with npm run dev  (${e.message})`);
}

if (gameUp) {
  await settle(900);
  const at = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2, dir: "down", moving: false });
  const speak = async (place, from, text) => {
    for (const [who, t] of place) who.room.send("move", at(t[0], t[1]));
    await settle(450);
    for (const [who] of place) who.heard.length = 0;
    from.room.send("chat", { text });
    await settle(650);
    return place.filter(([w]) => w !== from && w.heard.some((m) => m.text === text)).map(([w]) => w.name);
  };

  // "boardroom" is tiles 2-14 x 2-9, and its doorway is at 8,10
  {
    // 13.9 tiles apart: well past the radius, so hearing this means the stored
    // map's areas reached the room server
    const got = await speak([[a, [2, 2]], [b, [14, 9]]], a, `ในบอร์ด-${stamp}`);
    ok("an area from the stored map carries across it", got.includes("b"),
      got.length ? "" : "the room server did not pick up the stored map's areas");
  }
  {
    const got = await speak([[a, [8, 9]], [b, [8, 10]]], a, `นอกบอร์ด-${stamp}`);
    ok("  · and stops at its edge, one tile away", !got.includes("b"), `heard by ${got}`);
  }

  // ---- and the thing a second floor has to be -----------------------------
  //
  // Standing on the same tile as somebody is the strongest case there is for
  // hearing them. On another map it has to count for nothing, or a floor is
  // decoration rather than a place.
  {
    // The SAME tile, outside every area on both floors. Nothing but the floor
    // rule can be keeping these two apart — not distance, not an area.
    const got = await speak([[a, [12, 10]], [upstairs, [12, 10]]], a, `คนละชั้น-${stamp}`);
    ok("the same tile on another map is not the same room", !got.includes("upstairs"), `heard by ${got}`);
  }
  {
    const got = await speak([[upstairs, [12, 10]], [a, [12, 10]]], upstairs, `ขึ้นมาบ้าง-${stamp}`);
    ok("  · in the other direction either", !got.includes("a"), `heard by ${got}`);
  }
  {
    // Both floors have an area called "boardroom". Standing in each of them is
    // the case that would merge if a map were only a picture.
    const got = await speak([[a, [2, 2]], [b, [14, 9]], [upstairs, [5, 5]]], a, `บอร์ดชั้นล่าง-${stamp}`);
    ok("  · two areas with the same id on two floors are two rooms",
      got.includes("b") && !got.includes("upstairs"), `heard by ${got}`);
  }
  {
    // moving between floors is a live change, not something fixed at join
    upstairs.room.send("map", "handmade");
    await settle(500);
    const got = await speak([[a, [17, 13]], [upstairs, [17, 12]]], a, `ลงมาแล้ว-${stamp}`);
    ok("coming downstairs puts you back in earshot", got.includes("upstairs"), `heard by ${got}`);
  }

  for (const r of room.open) { try { await r.leave(); } catch { /* going anyway */ } }
}

// ---- a space with more than one map ------------------------------------------

{
  const r = await put(`/workspaces/${ws.slug}/map/second`, { map: second() }, { token: owner.token });
  ok("a second map can be stored beside the first", r.status === 200, `status ${r.status} ${r.problem ?? ""}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/maps`);
  ok("both are listed", r.maps?.length === 2, JSON.stringify(r.maps?.map((m) => m.slug)));
  ok("  · in the order they were made, and the first is where people land",
    r.maps?.[0]?.slug === "handmade" && r.landing === "handmade", `landing ${r.landing}`);
  ok("  · each carrying its own name", r.maps?.[1]?.label === "ชั้นสอง", r.maps?.[1]?.label);
}
{
  const r = await get(`/workspaces/${ws.slug}/map/second`);
  ok("a map can be fetched by name", r.map?.id === "second" && r.map?.cols === 14, `${r.map?.id} ${r.map?.cols}`);
  const landing = await get(`/workspaces/${ws.slug}/map`);
  ok("  · and the unnamed path is still the landing one", landing.map?.id === "handmade", landing.map?.id);
}
{
  const r = await put(`/workspaces/${ws.slug}/map/second`, { map: aMap({ id: "third" }) }, { token: owner.token });
  ok("a map whose id disagrees with its name is refused", r.status === 400, `status ${r.status} ${r.error ?? ""}`);
}
{
  const r = await put(`/workspaces/${ws.slug}/map/second`, { map: second() }, { token: member.token });
  ok("a plain member still cannot write one", r.status === 403, `status ${r.status}`);
}
{
  const r = await get(`/workspaces/${ws.slug}/map/nowhere`);
  ok("asking for a map that is not there is a 404", r.status === 404, `status ${r.status}`);
}

// ---- a portal that names another map -----------------------------------------

{
  const withPortal = aMap({ interactives: [
    { type: "portal", x: 4, y: 4, label: "ขึ้นชั้นสอง", icon: "🚪", map: "second", target: { x: 3, y: 3 } },
  ] });
  const r = await put(`/workspaces/${ws.slug}/map/handmade`, { map: withPortal }, { token: owner.token });
  ok("a portal may name another map", r.status === 200, `status ${r.status} ${r.problem ?? ""}`);
  const back = await get(`/workspaces/${ws.slug}/map/handmade`);
  ok("  · and it survives the round trip", back.map?.interactives?.[0]?.map === "second");
}
await refused("  · but not a map name that could not be a map name", aMap({ interactives: [
  { type: "portal", x: 4, y: 4, label: "x", icon: "🚪", map: "../other space" },
] }), "interactives has a bad entry");

// ---- the order people meet them in --------------------------------------------

{
  const r = await call("PUT", `/workspaces/${ws.slug}/maps/order`, { body: { order: ["second", "handmade"] }, token: owner.token });
  ok("the maps can be reordered", r.status === 200 && r.landing === "second", `status ${r.status}, landing ${r.landing}`);
  const landing = await get(`/workspaces/${ws.slug}/map`);
  ok("  · which moves where people land", landing.map?.id === "second", landing.map?.id);
  await call("PUT", `/workspaces/${ws.slug}/maps/order`, { body: { order: ["handmade", "second"] }, token: owner.token });
}
{
  const r = await call("PUT", `/workspaces/${ws.slug}/maps/order`, { body: { order: ["handmade"] }, token: owner.token });
  ok("an order that leaves a map out is refused", r.status === 400, `status ${r.status}`);
}
{
  const r = await call("PUT", `/workspaces/${ws.slug}/maps/order`, { body: { order: ["handmade", "handmade"] }, token: owner.token });
  ok("  · and so is one that names a map twice", r.status === 400, `status ${r.status}`);
}

// ---- deleting one, and deleting all -------------------------------------------

{
  const r = await del(`/workspaces/${ws.slug}/map/second`, { token: owner.token });
  ok("one map can be deleted without taking the space with it",
    r.status === 200 && r.landing === "handmade", `status ${r.status}, landing ${r.landing}`);
  const list = await get(`/workspaces/${ws.slug}/maps`);
  ok("  · leaving the other", list.maps?.length === 1 && list.maps[0].slug === "handmade");
}

// ---- back to the built-in -----------------------------------------------------

{
  const r = await del(`/workspaces/${ws.slug}/map`, { token: owner.token });
  ok("deleting puts the space back on its built-in", r.status === 200 && r.builtin === "office", `status ${r.status}`);
  const after = await get(`/workspaces/${ws.slug}/map`);
  ok("  · and the stored one is gone", after.builtin === "office" && !after.map);
  const again = await del(`/workspaces/${ws.slug}/map`, { token: owner.token });
  ok("  · deleting nothing still succeeds", again.status === 200, `status ${again.status}`);
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
