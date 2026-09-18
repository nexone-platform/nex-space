// Which typeface the interface is drawn in, and how big.
//
// Per device, like colour mode and for the same reason: a size that suits a
// 27-inch monitor says nothing about the laptop the same person opens at home.
//
// Neither value is applied from here at load time. Both are stamped on <html>
// by a small script in <head> — see the note there — because a module import
// lands after the first paint, and text that resizes a moment after it appears
// is worse than text that was the wrong size all along.

/** the size the interface was drawn at; every other size in index.html is a multiple of it */
export const DRAWN_AT = 13;

export type FaceId = "sarabun" | "noto" | "plex" | "prompt" | "kanit";

/**
 * Five faces, every one of them drawing Thai and English in the same voice.
 *
 * A face that has only Latin is not an option here, whatever it looks like:
 * the browser would quietly fetch a second font for the Thai and the screen
 * would be set in two typefaces that were never meant to meet.
 *
 * `note` is what the face is like, not what it is called — the name tells
 * somebody choosing nothing at all.
 */
export const FACES: { id: FaceId; name: string; note: string }[] = [
  { id: "sarabun", name: "Sarabun", note: "แบบมีหัว อ่านง่าย เหมือนเอกสารราชการ" },
  { id: "noto", name: "Noto Sans Thai", note: "แบบไม่มีหัว เรียบ กลางๆ" },
  { id: "plex", name: "IBM Plex Sans Thai", note: "แบบไม่มีหัว ทันสมัย ตัวโปร่ง" },
  { id: "prompt", name: "Prompt", note: "แบบไม่มีหัว ทรงกลม อ่านสบาย" },
  { id: "kanit", name: "Kanit", note: "แบบไม่มีหัว หนาชัด เหมาะกับหัวข้อ" },
];

const IDS = FACES.map((f) => f.id);

/** the sizes on offer, in pixels of body text */
export const SIZES = [13, 15, 17, 20, 24];

const FACE_KEY = "nexspace-face";
const SIZE_KEY = "nexspace-text-size";

export const face = (): FaceId => {
  try {
    const v = localStorage.getItem(FACE_KEY) as FaceId | null;
    return v && IDS.includes(v) ? v : "sarabun";
  } catch { return "sarabun"; }
};

/**
 * Clamped rather than checked against the list, so a number typed into
 * localStorage by hand still gives a readable screen instead of a blank one.
 */
export const textSize = (): number => {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return n >= 11 && n <= 28 ? n : 20;
  } catch { return 20; }
};

export const applyTypeface = (id: FaceId = face(), size: number = textSize()) => {
  const html = document.documentElement;
  html.dataset.face = id;
  html.style.setProperty("--ui", String(Math.round((size / DRAWN_AT) * 1000) / 1000));
};

export const setFace = (id: FaceId) => {
  try { localStorage.setItem(FACE_KEY, id); } catch { /* private mode: this visit only */ }
  applyTypeface(id);
};

export const setTextSize = (size: number) => {
  try { localStorage.setItem(SIZE_KEY, String(size)); } catch { /* private mode: this visit only */ }
  applyTypeface(undefined, size);
};

/**
 * The same list, for the places that cannot read a CSS variable.
 *
 * Canvas text — the name tags over people's heads — is drawn with a font
 * string, not a stylesheet, so it has to be told the family by name. Read at
 * the moment of drawing rather than kept in a constant, so a tag made after
 * somebody changes the setting is made in the face they chose.
 */
export const canvasStack = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue("--sans").trim()
  || `"Sarabun", system-ui, sans-serif`;
