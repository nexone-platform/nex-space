/**
 * Files people put in the chat.
 *
 * Three decisions worth stating, because each has a cheaper wrong answer:
 *
 * **The bytes go on disk, not in the row.** SQLite would take them, and then
 * every listing that renders a filename would drag megabytes through Prisma to
 * do it. The row is the catalogue card; the volume is the shelf.
 *
 * **What we serve is decided at upload, not at download.** The browser's
 * declared content-type is a suggestion from whoever is uploading; the type we
 * write into the row comes from an allowlist, and that is the only thing ever
 * sent back. Anything not on the list is refused rather than downgraded to
 * octet-stream, because a file we cannot name is a file nobody asked for.
 *
 * **A link is signed and expires.** A space can be private, and a file shared
 * in one must not become a public URL — but an <img> tag cannot carry an
 * Authorization header, so the capability has to live in the link. It is a
 * per-file HMAC with a few hours on it, minted fresh every time the history is
 * read: leaking one leaks one file for one afternoon, not the space.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { unlink, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** where the bytes live. Inside the data volume, beside the database. */
export const UPLOAD_DIR = process.env.UPLOAD_DIR || resolve(HERE, "../data/uploads");

/**
 * The ceiling on one file.
 *
 * Ten megabytes is a screenshot, a slide deck, or a short screen recording that
 * has been through a compressor — the things people actually drop into a work
 * chat. It is not a video, and that is deliberate: a chat that accepts videos
 * becomes the place videos are stored, and this one has a single disk behind it.
 */
export const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 10_000_000);

/** how long a minted link stays good */
const LINK_TTL_MS = Number(process.env.UPLOAD_LINK_TTL_MS || 6 * 60 * 60 * 1000);

/**
 * What may be uploaded, and what it is served as.
 *
 * Two absences are the point of the list. **No SVG**: it is an image everywhere
 * in a user interface and a script host in a browser, and serving one from our
 * own origin hands the author the session of everyone who clicks it. **No HTML**
 * for the same reason. Everything here is either inert or rendered by a viewer
 * that treats it as data.
 */
const ALLOWED: Record<string, { ext: string; image?: true }> = {
  "image/png": { ext: "png", image: true },
  "image/jpeg": { ext: "jpg", image: true },
  "image/gif": { ext: "gif", image: true },
  "image/webp": { ext: "webp", image: true },
  "application/pdf": { ext: "pdf" },
  "text/plain": { ext: "txt" },
  "text/csv": { ext: "csv" },
  "application/zip": { ext: "zip" },
  "application/json": { ext: "json" },
  "application/msword": { ext: "doc" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { ext: "docx" },
  "application/vnd.ms-excel": { ext: "xls" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { ext: "xlsx" },
  "application/vnd.ms-powerpoint": { ext: "ppt" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { ext: "pptx" },
};

export const allowedTypes = () => Object.keys(ALLOWED);
export const isImage = (mime: string) => !!ALLOWED[mime]?.image;
export const extFor = (mime: string) => ALLOWED[mime]?.ext ?? "";
export const accepts = (mime: string) => !!ALLOWED[mime];

/**
 * The key that signs links.
 *
 * Read from the environment when set. Otherwise generated once and kept in the
 * data volume, so links survive a restart without anybody having to configure
 * anything — a secret that changes on every deploy would break every image in
 * the history at the moment of the deploy, which is the sort of thing that gets
 * blamed on the upload code rather than on the missing setting.
 */
function loadSecret(): Buffer {
  const fromEnv = process.env.UPLOAD_SECRET;
  if (fromEnv) return Buffer.from(fromEnv, "utf8");

  const file = join(UPLOAD_DIR, ".link-secret");
  try {
    if (existsSync(file)) {
      const kept = readFileSync(file);
      if (kept.length >= 32) return kept;
    }
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const fresh = randomBytes(32);
    writeFileSync(file, fresh, { mode: 0o600 });
    return fresh;
  } catch {
    // A read-only volume, most likely. Links still work; they stop working at
    // the next restart, and saying so beats discovering it from a broken image.
    console.warn("[uploads] could not keep a link secret on disk — file links will break on restart");
    return randomBytes(32);
  }
}

const SECRET = loadSecret();

const mac = (id: string, exp: number) =>
  createHmac("sha256", SECRET).update(`${id}.${exp}`).digest("base64url");

/** a link to one file, good for a few hours */
export function signedPath(id: string, now = Date.now()): string {
  const exp = now + LINK_TTL_MS;
  return `/uploads/${encodeURIComponent(id)}?exp=${exp}&sig=${mac(id, exp)}`;
}

/** does this link open this file, right now? */
export function linkOk(id: string, exp: unknown, sig: unknown): boolean {
  const at = Number(exp);
  if (!Number.isFinite(at) || at < Date.now()) return false;
  const want = Buffer.from(mac(id, at));
  const got = Buffer.from(String(sig ?? ""));
  // lengths differ far more often than contents do, and timingSafeEqual throws
  // on a mismatch rather than returning false
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * A filename that is only a filename.
 *
 * Everything that could make it a path, a hidden file, or a surprise on another
 * operating system comes out. What is left is only ever shown to a reader and
 * offered as a download name — the bytes are stored under a generated id — but
 * "only ever shown" is exactly the assumption that stops being true later.
 */
export function safeName(raw: string): string {
  const base = String(raw || "").split(/[/\\]/).pop() || "";
  const clean = base
    .replace(/\p{Cc}/gu, "")            // control bytes, including a newline aimed at a header
    .replace(/[<>:"|?*]/g, "")           // reserved on Windows, confusing everywhere else
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return clean || "file";
}

/** where one attachment's bytes sit, relative to the uploads root */
export const relPathFor = (id: string, mime: string, at: Date) => {
  const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
  const ext = extFor(mime);
  return `${month}/${id}${ext ? "." + ext : ""}`;
};

export const absPathFor = (rel: string) => join(UPLOAD_DIR, rel);

/** write the bytes, making the month folder on the way */
export async function putBytes(rel: string, data: Buffer) {
  const abs = absPathFor(rel);
  mkdirSync(dirname(abs), { recursive: true });
  await writeFile(abs, data);
}

/** remove one file, and do not care if it was already gone */
export async function dropBytes(rel: string) {
  try { await unlink(absPathFor(rel)); } catch { /* already gone, which is the goal */ }
}
