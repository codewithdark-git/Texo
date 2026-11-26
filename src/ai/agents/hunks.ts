// The changeset review's pure parts: which hunks of a file are picked, the
// text that picking gives (mirrors `apply_hunks` in
// src-tauri/src/agents/changeset.rs, so the preview is exactly what Rust
// writes), and the decisions sent to `agent_apply`.
//
// Hunks come from Rust (libgit2, no context lines): `oldStart` is 1-based;
// for a pure insertion (`oldLines` 0) it is the line after which the new
// lines go (0 = top). The same rule holds for `newStart` when `newLines` is 0.

import type { Changeset, ChangesetFile, Decision, Hunk, RunSummary } from "../../lib/agentsApi";

/** Lines with their line breaks kept (Rust's `split_inclusive('\n')`). */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** `base` with only the `accepted` hunks of `base → next` applied. */
export function applyHunks(base: string, next: string, hunks: Hunk[], accepted: Iterable<number>): string {
  const old = splitLines(base);
  const neu = splitLines(next);
  const take = new Set(accepted);
  let out = "";
  let pos = 0;
  for (const h of [...hunks].sort((a, b) => a.index - b.index)) {
    let start = h.oldLines === 0 ? h.oldStart : Math.max(0, h.oldStart - 1);
    start = Math.max(pos, Math.min(start, old.length));
    out += old.slice(pos, start).join("");
    const end = Math.min(start + h.oldLines, old.length);
    if (take.has(h.index)) {
      if (h.newLines > 0) {
        const ns = Math.min(Math.max(0, h.newStart - 1), neu.length);
        out += neu.slice(ns, Math.min(ns + h.newLines, neu.length)).join("");
      }
    } else {
      out += old.slice(start, end).join("");
    }
    pos = end;
  }
  return out + old.slice(Math.min(pos, old.length)).join("");
}

/** "Lines 12–14" / "After line 7" for the hunk list (in the agent's version where lines were added). */
export function hunkLabel(h: Hunk): string {
  const range = (start: number, n: number) => (n <= 1 ? `line ${start}` : `lines ${start}–${start + n - 1}`);
  if (h.oldLines === 0) return h.oldStart === 0 ? `Adds ${h.newLines} line${h.newLines === 1 ? "" : "s"} at the top` : `Adds ${h.newLines} line${h.newLines === 1 ? "" : "s"} after line ${h.oldStart}`;
  if (h.newLines === 0) return `Removes ${range(h.oldStart, h.oldLines)}`;
  return `Changes ${range(h.oldStart, h.oldLines)}`;
}

/**
 * The 1-based line to show for a hunk on the diff's right side. That side
 * shows the picked text (unchecked hunks reverted), so each earlier unchecked
 * hunk shifts the line by its old minus new line count (FE-6). Without
 * `picked`, the agent's full version is assumed.
 */
export function hunkRevealLine(h: Hunk, hunks: Hunk[] = [], picked: Iterable<number> | null = null): number {
  let line = h.newStart;
  if (picked) {
    const take = new Set(picked);
    for (const o of hunks) {
      if (o.index < h.index && !take.has(o.index)) line += o.oldLines - o.newLines;
    }
  }
  return Math.max(1, line);
}

/** True when text still has conflict markers from a three-way merge. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})( |$)/m.test(text);
}

/** What the user picked for one file in the review dialog. */
export interface FilePick {
  /** Include this file (the checkbox in the file list). */
  include: boolean;
  /** Picked hunk indices (modified files). */
  hunks: number[];
  /** The user's own text (edited diff or conflict resolution); wins over hunks. */
  edited: string | null;
  /** Why it was left out (offered as a memory note). */
  reason: string;
}

/** Still waiting for a decision. */
export function isOpen(f: Pick<ChangesetFile, "state">): boolean {
  return f.state === "pending" || f.state === "conflict";
}

/** Per-hunk picking makes sense only for files changed in place. */
export function hunkPicking(f: Pick<ChangesetFile, "status" | "state" | "hunks">): boolean {
  return f.status === "modified" && f.state === "pending" && f.hunks.length > 1;
}

/**
 * The starting pick: every open file in with all its hunks. A conflict
 * starts "in" but unresolved, so it has no decision until the user picks a
 * version or edits the merged text (leaving it out keeps their version).
 */
export function initialPick(f: ChangesetFile): FilePick {
  return { include: isOpen(f), hunks: f.hunks.map((h) => h.index), edited: null, reason: "" };
}

/**
 * Picks for a (re)loaded changeset: a file keeps the user's pick only while
 * it is the same change (same state and the same texts); a file the agent
 * wrote again, or a new one, starts fresh so old hunk picks never land on
 * new hunks (FE-1).
 */
export function carryPicks(next: Changeset, before: Record<string, FilePick>, prev: Changeset | null): Record<string, FilePick> {
  const out: Record<string, FilePick> = {};
  for (const f of next.files) {
    const old = prev?.files.find((x) => x.file === f.file);
    const same = !!old && old.state === f.state && old.newText === f.newText && old.baseText === f.baseText && old.status === f.status;
    out[f.file] = same && before[f.file] ? before[f.file] : initialPick(f);
  }
  return out;
}

/** True when a run update can change what the review shows (refetch the changeset then). */
export function changesetStale(
  before: Pick<RunSummary, "status" | "stepCount" | "pendingFiles" | "changedFiles" | "conflictFiles"> | undefined,
  after: Pick<RunSummary, "status" | "stepCount" | "pendingFiles" | "changedFiles" | "conflictFiles"> | undefined,
): boolean {
  if (!before || !after) return false;
  return (
    before.status !== after.status ||
    before.stepCount !== after.stepCount ||
    before.pendingFiles !== after.pendingFiles ||
    before.changedFiles !== after.changedFiles ||
    before.conflictFiles !== after.conflictFiles
  );
}

/** The text a pick gives for a file (null: the file is deleted). */
export function pickedText(f: ChangesetFile, p: FilePick): string | null {
  if (p.edited !== null) return p.edited;
  if (f.status === "deleted") return null;
  if (f.status === "added" || !hunkPicking(f)) return f.newText;
  return applyHunks(f.baseText ?? "", f.newText ?? "", f.hunks, p.hunks);
}

/** Why a file can't be applied as picked, or null when it can. */
export function pickProblem(f: ChangesetFile, p: FilePick): string | null {
  if (!p.include || !isOpen(f)) return null;
  if (f.state === "conflict" && p.edited === null) return "Pick a version or edit the merged text first.";
  if (p.edited !== null && hasConflictMarkers(p.edited)) return "The text still has conflict markers (<<<<<<<, =======, >>>>>>>). Remove them first.";
  return null;
}

/**
 * The decision for one file, or null when it has none yet: decided files,
 * and conflicts the user hasn't resolved, stay as they are.
 */
export function decisionFor(f: ChangesetFile, p: FilePick): Decision | null {
  if (!isOpen(f)) return null;
  const reason = p.reason.trim() || null;
  if (!p.include) {
    // Leaving a conflict out keeps your version: the agent's change is rejected.
    return { file: f.file, accept: false, ...(reason ? { reason } : {}) };
  }
  if (pickProblem(f, p)) return null;
  if (p.edited !== null) return { file: f.file, accept: true, editedText: p.edited };
  if (hunkPicking(f)) {
    const picked = f.hunks.map((h) => h.index).filter((i) => p.hunks.includes(i));
    if (picked.length === 0) return { file: f.file, accept: false, ...(reason ? { reason } : {}) };
    if (picked.length < f.hunks.length) return { file: f.file, accept: true, hunks: picked };
  }
  return { file: f.file, accept: true };
}

/** Decisions for "Apply selected". */
export function selectedDecisions(files: ChangesetFile[], picks: Record<string, FilePick>): Decision[] {
  return files.flatMap((f) => {
    const d = decisionFor(f, picks[f.file] ?? initialPick(f));
    return d ? [d] : [];
  });
}

/** Rejection reasons typed in this review, as memory notes ("Remember this for next time?"). */
export function reasonNotes(files: ChangesetFile[], decisions: Decision[]): string[] {
  return decisions
    .filter((d) => !d.accept && d.reason && d.reason.trim())
    .map((d) => {
      const f = files.find((x) => x.file === d.file);
      const what = f?.reason ? ` (${f.reason.trim().replace(/\s+/g, " ").slice(0, 120)})` : "";
      return `Rejected a change to ${d.file}${what}: ${d.reason!.trim()}`;
    });
}

/** "+3 −1" for the file list. */
export function lineCounts(f: Pick<ChangesetFile, "hunks">): { added: number; removed: number } {
  return f.hunks.reduce((acc, h) => ({ added: acc.added + h.newLines, removed: acc.removed + h.oldLines }), { added: 0, removed: 0 });
}
