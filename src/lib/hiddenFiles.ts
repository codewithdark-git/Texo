// Which project files the file tree, Quick Open and search leave out by
// default: dotfiles, LaTeX build artifacts, Texo's temporary files and the
// clutter operating systems leave behind. Settings > Files can show them.
import { useSyncExternalStore } from "react";

/** Dotfiles that are part of the project and stay visible. */
const VISIBLE_DOTFILES = new Set([".latexmkrc"]);

/** Files the operating system creates in folders. */
const SYSTEM_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/** Extensions of files a LaTeX compile leaves behind. */
const BUILD_ARTIFACT =
  /\.(aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex\.gz|bcf|run\.xml|blg|nav|snm|vrb|xdv|idx|ilg|ind|glo|gls|glg|ist)$/i;

/** Where the "show hidden files" choice is stored. */
export const SHOW_HIDDEN_KEY = "texo.files.showHidden";

/** Window event sent when the choice changes, so lists can re-filter. */
export const FILES_PREF_EVENT = "texo:files-pref";

/** True for a project-relative path (`a/b/c.tex`) hidden by default. */
export function isHiddenPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  // A dot anywhere in the path hides everything under it (`.git/x`).
  if (parts.some((part) => part.startsWith(".") && !VISIBLE_DOTFILES.has(part))) return true;
  if (SYSTEM_FILES.has(name.toLowerCase())) return true;
  if (name.toLowerCase().endsWith(".texo-tmp")) return true;
  return BUILD_ARTIFACT.test(name);
}

export function getShowHidden(): boolean {
  try {
    return localStorage.getItem(SHOW_HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
}

/** The current choice, re-rendering when Settings changes it. */
export function useShowHidden(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(FILES_PREF_EVENT, onChange);
      return () => window.removeEventListener(FILES_PREF_EVENT, onChange);
    },
    getShowHidden,
  );
}

export function setShowHidden(show: boolean) {
  try {
    if (show) localStorage.setItem(SHOW_HIDDEN_KEY, "true");
    else localStorage.removeItem(SHOW_HIDDEN_KEY);
  } catch {
    // Applies for this session only.
  }
  window.dispatchEvent(new Event(FILES_PREF_EVENT));
}
