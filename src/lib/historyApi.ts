// Bindings for the change history (src-tauri/src/history, a private git repo
// per project in .texo/history). The History panel and the status bar use
// these; the agents runtime writes AI commits from Rust, not through here.
//
// Snapshots of your own edits are automatic (Rust side): 30 s after the last
// save, before every compile, before an AI run, and when the project closes.
import { invoke } from "@tauri-apps/api/core";

export interface HistoryStatus {
  /** The on/off switch for this project. */
  enabled: boolean;
  /** History is on and working. */
  active: boolean;
  /** The folder can't be written to; history is off (show a banner). */
  readOnly: boolean;
  /** Why history isn't working, in plain words. */
  error: string | null;
  /** A one-time message (e.g. a damaged history was replaced). Shown once. */
  notice: string | null;
  sizeBytes: number;
  /** Number of versions on the timeline. */
  count: number;
  /** A git repo without `.texo/` in `.git/info/exclude`: ask once, answer with `historyGitExclude`. */
  offerGitExclude: boolean;
}

export type HistoryAuthorFilter = "you" | "ai" | "all";

export interface HistoryLogFilter {
  author?: HistoryAuthorFilter;
  runId?: string | null;
  /** Only versions that changed this file (`/`-separated, relative). */
  path?: string | null;
  /** A commit id: list versions older than it (paging). */
  before?: string | null;
  /** Default 200, at most 1000. */
  limit?: number | null;
}

export type HistoryReason =
  | "idle"
  | "before-compile"
  | "before-run"
  | "close"
  | "manual"
  | "agent-apply"
  | "restore"
  | "undo"
  | "start";

export interface HistoryLabel {
  name: string;
  /** True for the automatic "Compiled OK" labels. */
  auto: boolean;
}

export interface HistoryEntry {
  id: string;
  shortId: string;
  /** Seconds since 1970 (UTC). */
  time: number;
  summary: string;
  reason: HistoryReason | null;
  author: "you" | "ai";
  /** "You", or "Texo AI · <profile> (<model>)". */
  authorName: string;
  runId: string | null;
  step: number | null;
  agent: string | null;
  model: string | null;
  kind: string | null;
  /** Set on the commit that undid an AI run. */
  undoOf: string | null;
  parentId: string | null;
  labels: HistoryLabel[];
  /**
   * The git note, when there is one. AI commits: `{runId, prompt, toolCalls[], accepted[], rejected[], conflicts[], journal}`.
   * Snapshots may carry `{untrackedLarge[], skippedNames[], cloudOnly[]}`.
   */
  note: Record<string, unknown> | null;
}

export interface HistoryFileChange {
  file: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface HistoryDiff {
  file: string;
  /** null when the file doesn't exist on that side (or `binary`). */
  oldText: string | null;
  newText: string | null;
  binary: boolean;
}

export interface HistoryRestoreResult {
  /** The new version, or null when the files already matched. */
  commit: string | null;
  written: string[];
  deleted: string[];
  /** Files that couldn't be written (open in another app, read-only). */
  failed: string[];
}

export interface HistoryUndoResult {
  ok: boolean;
  commit: string | null;
  written: string[];
  deleted: string[];
  /** Files you changed after the AI did; they were left as they are. */
  conflicts: string[];
  failed: string[];
}

/** Pass as `to` in `historyDiff` to compare with the files on disk now. */
export const HISTORY_DISK = "disk";

export const historyApi = {
  status: (project: string) => invoke<HistoryStatus>("history_status", { project }),
  log: (project: string, filter?: HistoryLogFilter) =>
    invoke<HistoryEntry[]>("history_log", { project, filter: filter ?? null }),
  changes: (project: string, commit: string) => invoke<HistoryFileChange[]>("history_changes", { project, commit }),
  /** `from` null: the parent of `to` (for `to = HISTORY_DISK`: the latest version). */
  diff: (project: string, from: string | null, to: string, file: string) =>
    invoke<HistoryDiff>("history_diff", { project, from, to, file }),
  /** Ask the user first: this overwrites the file on disk (the current text is saved in history). */
  restoreFile: (project: string, commit: string, file: string) =>
    invoke<HistoryRestoreResult>("history_restore_file", { project, commit, file }),
  /** Ask the user first: files added since that version are removed (they stay in history). */
  restoreAll: (project: string, commit: string) =>
    invoke<HistoryRestoreResult>("history_restore_all", { project, commit }),
  /** Ask the user first. Rejects with a plain message when already undone or nothing to undo. */
  undoRun: (project: string, runId: string) => invoke<HistoryUndoResult>("history_undo_run", { project, runId }),
  label: (project: string, commit: string, name: string) => invoke<void>("history_label", { project, commit, name }),
  /**
   * Saves a version now; resolves to the new commit id, or null when nothing changed.
   * `reason` is the version's title in the timeline (default "Saved a version").
   */
  snapshot: (project: string, reason?: string) =>
    invoke<string | null>("history_snapshot", { project, reason: reason ?? null }),
  setEnabled: (project: string, enabled: boolean) => invoke<HistoryStatus>("history_set_enabled", { project, enabled }),
  /** The answer to the one-time "add .texo/ to .git/info/exclude?" offer. */
  gitExclude: (project: string, add: boolean) => invoke<HistoryStatus>("history_git_exclude", { project, add }),
};

/** Status bar text, e.g. "History on · 42 versions". */
export function historyStatusText(s: HistoryStatus | null | undefined): string {
  if (!s) return "";
  if (!s.enabled) return "History off";
  if (s.readOnly) return "History off (read-only folder)";
  if (!s.active) return "History unavailable";
  return `History on · ${s.count} ${s.count === 1 ? "version" : "versions"}`;
}
