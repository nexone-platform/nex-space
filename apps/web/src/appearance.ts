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
// ---- microphone treatment ----
// Echo cancellation, noise suppression and gain control. Asked for explicitly
// rather than left to the browser's defaults, because "the default" is not the
// same on every browser and is not something anybody can turn off when it is
// doing the wrong thing — a guitar through a suppressor comes out as gargling.

const MIC_KEY = "nexspace-mic-clean";

export const micClean = () => {
  try { return localStorage.getItem(MIC_KEY) !== "off"; } catch { return true; }
};

export const setMicClean = (on: boolean) => {
  try { localStorage.setItem(MIC_KEY, on ? "on" : "off"); } catch { /* private mode: this visit only */ }
};

/** the constraints a microphone track is opened with */
export const micTreatment = (): MediaTrackConstraints => {
  const on = micClean();
  return { echoCancellation: on, noiseSuppression: on, autoGainControl: on };
};

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
