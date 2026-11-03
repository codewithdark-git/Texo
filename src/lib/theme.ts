// The app's colour theme: follow the system, or force light or dark. The
// choice is stored per machine and applied to the page (`data-theme` on
// <html>), the editor, and the native window frame.
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "texo.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<(theme: Theme) => void>();

export function getThemePref(): ThemePref {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function resolvedTheme(pref: ThemePref = getThemePref()): Theme {
  if (pref === "system") return media.matches ? "dark" : "light";
  return pref;
}

export function applyTheme() {
  const pref = getThemePref();
  const theme = resolvedTheme(pref);
  document.documentElement.dataset.theme = theme;
  listeners.forEach((fn) => fn(theme));
  // Match the title bar too; null hands it back to the system setting.
  void getCurrentWindow()
    .setTheme(pref === "system" ? null : theme)
    .catch(() => {});
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Applies for this session only.
  }
  applyTheme();
}

export function onThemeChange(fn: (theme: Theme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

media.addEventListener("change", () => {
  if (getThemePref() === "system") applyTheme();
});
