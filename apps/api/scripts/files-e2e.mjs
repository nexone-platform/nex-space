#!/usr/bin/env node
/**
 * Files in the chat.
 *
 * Most of what is checked here is refusal, because the interesting half of
 * accepting a file is everything you decline to accept: a type that runs in a
 * browser, a size that fills a disk, a link that never expires, an id borrowed
 * from another space.
 *
 * The uploads go to a scratch directory, not the repo's data volume — a test
 * that leaves files behind is a test nobody runs twice.
 *
 *   node apps/api/scripts/files-e2e.mjs
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..");
const TSX = resolve(API_DIR, "../../node_modules/tsx/dist/cli.mjs");

const PORT = 3994;
const API = `http://127.0.0.1:${PORT}`;
const SCRATCH = mkdtempSync(join(tmpdir(), "nexspace-uploads-"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  PASS" : "! FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, path, { body, token, headers } = {}) => {
  const r = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const post = (p, body, token) => call("POST", p, { body, token });
const get = (p, token) => call("GET", p, { token });

/** upload raw bytes the way the browser does: the file IS the body */
const send = async (slug, buf, mime, name, { token, guest, extra } = {}) => {
  const qs = guest ? `?guest=${encodeURIComponent(guest)}` : "";
  const r = await fetch(`${API}/workspaces/${slug}/uploads${qs}`, {
    method: "POST",
    headers: {
      "content-type": mime,
      "x-filename": encodeURIComponent(name),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: buf,
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

try {
  await fetch(`${API}/health`, { signal: AbortSignal.timeout(700) });
  console.error(`! something is already listening on ${PORT} — stop it first`);
  process.exit(1);
} catch { /* free */ }

const api = spawn(process.execPath, [TSX, "src/index.ts"], {
  cwd: API_DIR,
  env: { ...process.env, PORT: String(PORT), UPLOAD_DIR: SCRATCH, UPLOAD_MAX_BYTES: "200000" },
  stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[api] ${d}`));
api.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[api] ${d}`));
const stop = () => {
  try { api.kill(); } catch { /* gone */ }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fine */ }
};
process.on("exit", stop);

console.log("\nfiles in the chat\n");
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(API + "/health")).ok; } catch { await settle(500); }
}
if (!up) { console.error("! the test API never came up"); stop(); process.exit(1); }

// ---- cast --------------------------------------------------------------------

const stamp = Date.now();
const person = async (who) => {
  const d = await post("/auth/register", { email: `f-${who}-${stamp}@test.local`, name: who, password: "hunter2pw" });
  return { name: who, token: d.token, id: d.user?.id };
};

const owner = await person("owner");
const mate = await person("mate");
const stranger = await person("stranger");

const ws = (await post("/workspaces", { name: `files-${stamp}` }, owner.token)).workspace;
await post("/workspaces/join", { code: ws.inviteCode }, mate.token);
const guestPass = (await post(`/workspaces/${ws.slug}/guests`, { name: "visitor" }, owner.token)).guest;

// a second space, to prove an id from one cannot be quoted into the other
const other = (await post("/workspaces", { name: `files-other-${stamp}` }, stranger.token)).workspace;

// Closed, so "stranger" is genuinely outside it. With guests allowed, any
// account may speak in this space and therefore may upload — which is the
// existing rule for talking, and a picture is talking.
await call("PATCH", `/workspaces/${ws.slug}`, { body: { allowGuests: false }, token: owner.token });

// a real one-pixel PNG, so a browser would actually render what comes back
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const TEXT = Buffer.from("a plain note\n", "utf8");

// ---- taking a file -----------------------------------------------------------

let png;
{
  const r = await send(ws.slug, PNG, "image/png", "shot.png", {
    token: owner.token, extra: { "x-width": "1", "x-height": "1" },
  });
  png = r.attachment;
  ok("an owner can upload a picture", r.status === 200 && !!png?.id, `status ${r.status}`);
  ok("  · which comes back knowing it is one", png?.image === true, JSON.stringify(png?.image));
  ok("  · with its name and size", png?.name === "shot.png" && png?.bytes === PNG.length,
    `${png?.name} ${png?.bytes}`);
  ok("  · and a link to open it", typeof png?.url === "string" && png.url.includes("sig="), png?.url);
}
{
  const r = await send(ws.slug, TEXT, "text/plain", "note.txt", { token: mate.token });
  ok("a plain member can upload too", r.status === 200 && !!r.attachment?.id, `status ${r.status}`);
  ok("  · and a text file is not called a picture", r.attachment?.image === false,
    JSON.stringify(r.attachment?.image));
}
{
  const r = await send(ws.slug, PNG, "image/png", "visit.png", { guest: guestPass.code });
  ok("a guest holding a live pass can upload", r.status === 200 && !!r.attachment?.id, `status ${r.status}`);
}
{
  const r = await send(ws.slug, PNG, "image/png", "nope.png", { token: stranger.token });
  ok("somebody outside a closed space cannot", r.status === 401, `status ${r.status}`);

  // and the pass still works, because a pass is not the same door as "open"
  const still = await send(ws.slug, PNG, "image/png", "pass.png", { guest: guestPass.code });
  ok("  · while a named pass still opens it", still.status === 200, `status ${still.status}`);
}

// ---- what is refused ---------------------------------------------------------

{
  const r = await send(ws.slug, Buffer.from("<svg onload=alert(1)>"), "image/svg+xml", "x.svg", { token: owner.token });
  ok("an SVG is refused — it is a script host wearing a picture's name", r.status === 415, `status ${r.status}`);
}
{
  const r = await send(ws.slug, Buffer.from("<h1>hi"), "text/html", "x.html", { token: owner.token });
  ok("so is HTML, for the same reason", r.status === 415, `status ${r.status}`);
}
{
  const r = await send(ws.slug, PNG, "application/octet-stream", "x.bin", { token: owner.token });
  ok("a type we cannot name is refused rather than guessed at", r.status === 415, `status ${r.status}`);
}
{
  const big = Buffer.alloc(250_000, 7);          // over the 200k this run allows
  const r = await send(ws.slug, big, "image/png", "big.png", { token: owner.token });
  ok("a file over the limit is refused", r.status === 413, `status ${r.status}`);
}
{
  const r = await send(ws.slug, Buffer.alloc(0), "image/png", "empty.png", { token: owner.token });
  ok("nothing at all is not a file", r.status === 400, `status ${r.status}`);
}
{
  const r = await send(ws.slug, TEXT, "text/plain", "../../escape.txt", { token: owner.token });
  ok("a path in the filename is just a name by the time it lands",
    r.status === 200 && r.attachment?.name === "escape.txt", JSON.stringify(r.attachment?.name));
  ok("  · and nothing was written outside the uploads directory",
    !existsSync(join(SCRATCH, "../escape.txt")) && !existsSync(join(SCRATCH, "../../escape.txt")));
}

// ---- the link ----------------------------------------------------------------

{
  const r = await fetch(API + png.url);
  const body = Buffer.from(await r.arrayBuffer());
  ok("the link hands the file back", r.status === 200, `status ${r.status}`);
  ok("  · byte for byte", body.equals(PNG), `${body.length} vs ${PNG.length}`);
  ok("  · as the type we chose, not the one that was claimed",
    r.headers.get("content-type") === "image/png", r.headers.get("content-type"));
  ok("  · with sniffing turned off", r.headers.get("x-content-type-options") === "nosniff",
    r.headers.get("x-content-type-options"));
  ok("  · shown inline, because it is a picture",
    (r.headers.get("content-disposition") || "").startsWith("inline"), r.headers.get("content-disposition"));
}
{
  const r = await fetch(API + png.url + "&dl=1");
  ok("asking for it as a download gets a download",
    (r.headers.get("content-disposition") || "").startsWith("attachment"), r.headers.get("content-disposition"));
}
{
  const note = (await send(ws.slug, TEXT, "text/plain", "note.txt", { token: owner.token })).attachment;
  const r = await fetch(API + note.url);
  ok("anything that is not a picture is a download, never inline",
    (r.headers.get("content-disposition") || "").startsWith("attachment"), r.headers.get("content-disposition"));
}
{
  const tampered = png.url.replace(/sig=./, "sig=A");
  const r = await fetch(API + tampered);
  ok("a link with the signature changed opens nothing", r.status === 403, `status ${r.status}`);
}
{
  const noSig = png.url.split("&sig=")[0];
  const r = await fetch(API + noSig);
  ok("a link with no signature at all opens nothing", r.status === 403, `status ${r.status}`);
}
{
  const past = png.url.replace(/exp=\d+/, `exp=${Date.now() - 1000}`);
  const r = await fetch(API + past);
  ok("an expired link opens nothing", r.status === 403, `status ${r.status}`);
}
{
  // the expiry is inside the signature, so moving it forward invalidates it
  const later = png.url.replace(/exp=\d+/, `exp=${Date.now() + 999_000_000}`);
  const r = await fetch(API + later);
  ok("  · and the expiry cannot simply be edited later", r.status === 403, `status ${r.status}`);
}

// ---- saying something with it ------------------------------------------------

{
  const r = await post(`/workspaces/${ws.slug}/messages`, { text: "look at this", attach: png.id }, owner.token);
  ok("a message can carry a file", r.status === 200 && r.message?.attach?.id === png.id, `status ${r.status}`);
}
{
  const r = await post(`/workspaces/${ws.slug}/messages`, { attach: png.id }, owner.token);
  ok("a file with nothing said about it is still a message", r.status === 200, `status ${r.status}`);
  ok("  · and its text is empty rather than invented", r.message?.text === "", JSON.stringify(r.message?.text));
}
{
  const r = await post(`/workspaces/${ws.slug}/messages`, { text: "   " }, owner.token);
  ok("no words and no file is not a message", r.status === 400, `status ${r.status}`);
}
{
  const mine = (await send(other.slug, PNG, "image/png", "theirs.png", { token: stranger.token })).attachment;
  const r = await post(`/workspaces/${ws.slug}/messages`, { text: "borrowed", attach: mine.id }, owner.token);
  ok("a file from another space cannot be quoted into this one",
    r.status === 200 && r.message?.attach === undefined, JSON.stringify(r.message?.attach ?? null));
}
{
  const r = await get(`/workspaces/${ws.slug}/messages?limit=20`, owner.token);
  const withFile = (r.messages ?? []).filter((m) => m.attach);
  ok("the history hands the file back with the line", withFile.length >= 2, `${withFile.length} of ${(r.messages ?? []).length}`);
  ok("  · with a link minted fresh, not one stored months ago",
    withFile.every((m) => m.attach.url.includes("sig=")), JSON.stringify(withFile[0]?.attach?.url));
}

// ---- privately ---------------------------------------------------------------

{
  const f = (await send(ws.slug, TEXT, "text/plain", "just-for-you.txt", { token: owner.token })).attachment;
  const r = await post(`/workspaces/${ws.slug}/dm/${mate.id}`, { attach: f.id }, owner.token);
  ok("a private message can be a file on its own", r.status === 200 && r.message?.attach?.id === f.id,
    `status ${r.status}`);

  const thread = await get(`/workspaces/${ws.slug}/dm/${owner.id}`, mate.token);
  const last = (thread.messages ?? []).at(-1);
  ok("  · and the other side reads it back", last?.attach?.name === "just-for-you.txt",
    JSON.stringify(last?.attach?.name));

  const list = await get(`/workspaces/${ws.slug}/dm`, mate.token);
  const row = (list.threads ?? []).find((th) => th.peerId === owner.id);
  ok("  · the thread list shows the filename rather than a blank line",
    (row?.text || "").includes("just-for-you.txt"), JSON.stringify(row?.text));
}

// ---- the disk ----------------------------------------------------------------

{
  const months = readdirSync(SCRATCH).filter((n) => /^\d{4}-\d{2}$/.test(n));
  ok("the bytes are on disk, filed by month", months.length === 1, months.join(","));
  const files = readdirSync(join(SCRATCH, months[0]));
  ok("  · one file per upload, named by id rather than by what it was called",
    files.length >= 6 && files.every((f) => !f.includes("shot")), `${files.length} files`);
}

stop();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
