#!/usr/bin/env node
/**
 * Make a generated sprite fit the map.
 *
 * Art that comes back from an image generator arrives on whatever canvas the
 * generator felt like, at whatever zoom, with transparent margin around it. Two
 * sprites of the same object made in two goes are not the same size — the desk
 * cabinet came back with its body 39px wide, its locked twin 32px and its full
 * twin 29px, which on screen is a filing cabinet that changes width by a third
 * when somebody puts a document in it.
 *
 * So: trim the margin, scale every one of them to the same drawn height, and
 * set them down on a common canvas, standing on the same floor line.
 *
 *   node apps/web/scripts/fit-sprite.mjs --height 36 --canvas 32x40 a.png b.png
 *
 * The scale is a box filter, not nearest-neighbour. These are not hand-pixelled
 * tilesets — they arrive anti-aliased, with no clean block structure (checked:
 * none of them is an integer upscale of anything), so nearest-neighbour would
 * drop edge pixels unevenly and look worse, not more faithful. Genuine pixel-art
 * tilesets in this repo are never resampled at all; see the note in
 * public/assets/office/CREDITS.md.
 *
 * Writes <name>.png in place and prints what it did, because a silent image
 * rewrite is the kind of change nobody can review.
 */
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const HEIGHT = Number(opt("height", 36));
const [CW, CH] = String(opt("canvas", "32x40")).split("x").map(Number);
const files = args.filter((a) => a.endsWith(".png"));

if (!files.length || !HEIGHT || !CW || !CH) {
  console.error("usage: fit-sprite.mjs --height 36 --canvas 32x40 <file.png…>");
  process.exit(1);
}

/** the box the drawn pixels actually occupy, ignoring the transparent margin */
function drawnBox(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("nothing drawn in it");
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Average the source pixels that fall under each destination pixel.
 *
 * Premultiplied by alpha, which matters: averaging colour and alpha separately
 * pulls the colour of fully transparent pixels into the edge and leaves a halo
 * of whatever the generator left in the margin.
 */
function boxScale(img, box, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx0 = box.x0 + (x * box.w) / w, sx1 = box.x0 + ((x + 1) * box.w) / w;
      const sy0 = box.y0 + (y * box.h) / h, sy1 = box.y0 + ((y + 1) * box.h) / h;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const i = (sy * img.width + sx) * 4;
          const al = img.data[i + 3] / 255;
          r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al;
          a += img.data[i + 3];
          n++;
        }
      }
      const i = (y * w + x) * 4;
      const alpha = a / n;
      const un = alpha > 0 ? 255 / alpha : 0;
      out.data[i] = Math.round((r / n) * un);
      out.data[i + 1] = Math.round((g / n) * un);
      out.data[i + 2] = Math.round((b / n) * un);
      out.data[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

for (const file of files) {
  const img = PNG.sync.read(readFileSync(file));
  const box = drawnBox(img);
  const h = HEIGHT;
  const w = Math.max(1, Math.round((box.w * h) / box.h));
  if (w > CW) {
    console.error(`! ${basename(file)} would be ${w}px wide on a ${CW}px canvas`);
    process.exit(1);
  }
  const small = boxScale(img, box, w, h);

  // Standing on the floor, centred: every state of one object has to sit on the
  // same line, or swapping between them makes the furniture hop.
  const out = new PNG({ width: CW, height: CH, fill: true });
  const ox = Math.round((CW - w) / 2), oy = CH - h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = (y * w + x) * 4, to = ((y + oy) * CW + (x + ox)) * 4;
      for (let c = 0; c < 4; c++) out.data[to + c] = small.data[from + c];
    }
  }
  writeFileSync(file, PNG.sync.write(out));
  console.log(`${basename(file).padEnd(20)} drawn ${box.w}x${box.h} -> ${w}x${h} on ${CW}x${CH}`);
}
