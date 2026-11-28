// The pure parts of the Project settings dialog: its sections, which files
// can be the main document, which .bib files the project uses, and the short
// summaries the sections show. No stores and no Tauri calls, so it runs in tests.
import type { Engine, FileEntry } from "../lib/api";
import type { HistoryStatus } from "../lib/historyApi";
import type { BibSyncReport, LibraryStatus } from "../lib/libraryApi";
import { blankComments } from "../lib/texScan";

export type ProjectSection = "general" | "compile" | "history" | "references" | "ai";

export const PROJECT_SECTIONS: [ProjectSection, string][] = [
  ["general", "General"],
  ["compile", "Compile"],
  ["history", "History"],
  ["references", "References"],
  ["ai", "AI"],
];

export const ENGINES: [Engine, string][] = [
  ["pdflatex", "pdfLaTeX"],
  ["xelatex", "XeLaTeX"],
  ["lualatex", "LuaLaTeX"],
];

/** Most `.tex` files read when looking for main document candidates. */
export const MAX_TEX_SCAN = 200;
/** Larger `.tex` files are skipped: a main document is rarely this big. */
export const MAX_TEX_BYTES = 2 * 1024 * 1024;
/** Most `.bib` files listed when the main document names none (as the backend's scan). */
const MAX_BIB_FILES = 50;
/** How deep the fallback `.bib` listing goes (as the backend's scan). */
const MAX_BIB_DEPTH = 4;
/** Folders the fallback `.bib` listing leaves out, besides hidden ones (as the backend's scan). */
const SKIP_DIRS = ["node_modules", "target", "build", "dist", "out", "venv", "env", "__pycache__", "data", "datasets"];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type FileLike = FileEntry | string;
const pathOf = (f: FileLike) => (typeof f === "string" ? f : f.path);
const isFile = (f: FileLike) => typeof f === "string" || !f.isDir;

/** A path inside a hidden or build folder, which no section lists. */
function inSkippedDir(path: string): boolean {
  const parts = path.split("/").slice(0, -1);
  return parts.some((p) => p.startsWith(".") || SKIP_DIRS.some((d) => d.toLowerCase() === p.toLowerCase()));
}

/** Root files first, then by path. */
function byPath(a: string, b: string): number {
  const da = a.split("/").length;
  const db = b.split("/").length;
  return da !== db ? da - db : collator.compare(a, b);
}

/** The `.tex` files worth reading for `\documentclass`, smallest set first. */
export function texFilesToScan(files: FileEntry[]): string[] {
  return files
    .filter((f) => !f.isDir && /\.tex$/i.test(f.path) && f.size <= MAX_TEX_BYTES && !inSkippedDir(f.path))
    .map((f) => f.path)
    .sort(byPath)
    .slice(0, MAX_TEX_SCAN);
}

const DOCUMENTCLASS = /\\documentclass\s*[[{]/;

/** True when the text (outside comments) starts a document. */
export function hasDocumentClass(text: string): boolean {
  return DOCUMENTCLASS.test(blankComments(text));
}

/**
 * The files that can be the main document: `.tex` files whose text has a
 * `\documentclass` outside comments. Files with no text in `contents` (not
 * read, or not text) are left out. Root files come first.
 */
export function mainDocCandidates(files: FileLike[], contents: Record<string, string | undefined>): string[] {
  return files
    .filter(isFile)
    .map(pathOf)
    .filter((p) => /\.tex$/i.test(p))
    .filter((p) => {
      const text = contents[p];
      return typeof text === "string" && hasDocumentClass(text);
    })
    .sort(byPath);
}

/** The main document picker's options: the candidates, with the current main document kept even if it no longer qualifies. */
export function mainDocOptions(candidates: string[], current: string | null): string[] {
  if (!current || candidates.includes(current)) return candidates;
  return [current, ...candidates];
}

/** Resolves `a/../b` and `./` in a project-relative path; null when it leaves the project. */
export function normalizeRel(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.length ? out.join("/") : null;
}

/** The names in `\bibliography{a,b}` and `\addbibresource[...]{c.bib}`, in order, outside comments. */
export function bibNames(text: string): string[] {
  const names: string[] = [];
  const re = /\\(?:bibliography|addbibresource|addglobalbib)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;
  for (const m of blankComments(text).matchAll(re)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The project's `.bib` files, as the library scan finds them: the ones the
 * main document names (looked up beside it, then at the project root), or,
 * when it names none that exist, every `.bib` file outside hidden and build
 * folders.
 */
export function linkedBibFiles(files: FileLike[], main: string | null, mainText: string | null): string[] {
  const present = new Set(files.filter(isFile).map(pathOf));
  const named: string[] = [];
  if (main && mainText) {
    const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/")) : "";
    for (const name of bibNames(mainText)) {
      const file = /\.bib$/i.test(name) ? name : `${name}.bib`;
      const tries = [dir ? `${dir}/${file}` : file, file].map(normalizeRel);
      const hit = tries.find((p): p is string => p !== null && present.has(p));
      if (hit && !named.includes(hit)) named.push(hit);
    }
  }
  if (named.length) return named;
  return [...present]
    .filter((p) => /\.bib$/i.test(p) && p.split("/").length <= MAX_BIB_DEPTH && !inSkippedDir(p))
    .sort((a, b) => collator.compare(a, b))
    .slice(0, MAX_BIB_FILES);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1.2 MB" style sizes. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return plural(bytes, "byte");
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} ${units[u]}`;
}

/** The History section's status line. `error` is why the status couldn't be read, if it failed. */
export function historyLine(s: HistoryStatus | null, error: string | null = null): { text: string; tone: "muted" | "warning" } {
  if (!s) return error ? { text: error, tone: "warning" } : { text: "Checking history…", tone: "muted" };
  if (!s.enabled) return { text: "History is off. Versions saved earlier are kept.", tone: "muted" };
  if (s.readOnly) return { text: "History is off because this folder can't be written to.", tone: "warning" };
  if (!s.active) return { text: s.error ?? "History isn't working right now.", tone: "warning" };
  return { text: `${plural(s.count, "version")} saved · ${sizeText(s.sizeBytes)}`, tone: "muted" };
}

/** What the References section can do with the paper library. */
export function libraryState(status: LibraryStatus | null | "error"): { ready: boolean; note: string | null } {
  if (status === null) return { ready: false, note: null };
  if (status === "error" || !status.available) {
    const why = status === "error" ? null : status.warning;
    return {
      ready: false,
      note: `The paper library is unavailable${why ? `: ${why.replace(/\.$/, "")}` : ""}. Your .bib files still work as usual.`,
    };
  }
  return { ready: true, note: status.warning };
}

/** The line shown after a re-scan, e.g. "Read 2 files: 40 entries, 31 already in the library, 9 added." */
export function bibScanSummary(r: BibSyncReport): string {
  if (r.files.length === 0) return "No .bib files found.";
  const parts = [plural(r.entries, "entry", "entries")];
  if (r.matched) parts.push(`${r.matched} already in the library`);
  if (r.added) parts.push(`${r.added} added`);
  if (r.removed) parts.push(`${r.removed} no longer cited`);
  return `Read ${plural(r.files.length, "file")}: ${parts.join(", ")}.`;
}

/**
 * Settings > AI remembers its last page under this key (see
 * `AiSettingsSection.tsx`); the AI section's links set it before opening Settings.
 */
export const AI_SETTINGS_PAGE_KEY = "texo.aiSettingsPage";
export type AiSettingsPage = "provider" | "agents" | "web" | "memory";
