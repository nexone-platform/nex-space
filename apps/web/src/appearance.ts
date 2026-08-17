// Colour mode — one of the two personal settings under "ทั่วไป" (the other,
// display language, lives in i18n.ts).
//
// Per device, not per account: "ตรงกับระบบ" only means anything on the device
// asking, and someone who wants dark on their laptop has not said anything about
// their phone.
//
// The palette itself lives in index.html; all this does is decide which of the
// two <html data-theme> values is in force. The same rule runs in a small inline
// script in <head> so the first paint is already the right colour — a module
// import would land after it and flash white.

export type ColorMode = "light" | "dark" | "system";

const MODE_KEY = "nexspace-color-mode";

const MODES: ColorMode[] = ["light", "dark", "system"];

export const colorMode = (): ColorMode => {
  try {
    const v = localStorage.getItem(MODE_KEY) as ColorMode | null;
    return v && MODES.includes(v) ? v : "system";
  } catch { return "system"; }
};

const systemDark = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** stamp the resolved palette on <html>; "system" is resolved, never stored as a third theme */
export const applyColorMode = (mode: ColorMode = colorMode()) => {
  const dark = mode === "dark" || (mode === "system" && systemDark());
  document.documentElement.dataset.theme = dark ? "dark" : "light";
};

export const setColorMode = (mode: ColorMode) => {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode: this visit only */ }
  applyColorMode(mode);
};

/** follow the OS while the choice is "ตรงกับระบบ" — it can change under us */
export const watchSystemColorMode = () => {
  if (typeof matchMedia !== "function") return;
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (colorMode() === "system") applyColorMode("system");
  });
};
