// Pure helpers for the History panel: grouping the timeline by day, folding
// the commits of one AI run into a group, and plain words for each version.

import type { HistoryEntry, HistoryReason } from "../lib/historyApi";

/** One AI run's commits (newest first), shown as a collapsible group. */
export interface RunGroup {
  type: "run";
  runId: string;
  /** "Fix compile errors" etc.: the profile name from the author. */
  agent: string;
  model: string | null;
  entries: HistoryEntry[];
  /** Steps of the run: the highest `Texo-Step` trailer, else the tool calls in its note. */
  steps: number | null;
}

export interface SingleItem {
  type: "entry";
  entry: HistoryEntry;
}

export type TimelineItem = RunGroup | SingleItem;

export interface DayGroup {
  /** "2026-11-25" in local time; stable React key. */
  key: string;
  /** "Today", "Yesterday", or "Mon 23 Nov 2026". */
  label: string;
  items: TimelineItem[];
}

/** Local calendar day of a time in seconds, as YYYY-MM-DD. */
export function dayKey(seconds: number): string {
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dayLabel(seconds: number, now: Date = new Date()): string {
  const key = dayKey(seconds);
  const today = dayKey(now.getTime() / 1000);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === today) return "Today";
  if (key === dayKey(yesterday.getTime() / 1000)) return "Yesterday";
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "14:05" in local time. */
export function timeText(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The profile name from "Texo AI · <profile> (<model>)", else the author name. */
export function agentName(e: Pick<HistoryEntry, "agent" | "authorName">): string {
  if (e.agent) return e.agent;
  const m = /^Texo AI · (.+?)(?: \((.*)\))?$/.exec(e.authorName);
  return m?.[1] ?? e.authorName;
}

/** Steps recorded for one AI commit: its `Texo-Step` trailer, else the tool calls listed in its note. */
export function entrySteps(e: Pick<HistoryEntry, "step" | "note">): number | null {
  if (e.step != null) return e.step;
  const n = e.note;
  if (!n) return null;
  if (typeof n.steps === "number") return n.steps;
  if (Array.isArray(n.toolCalls) && n.toolCalls.length) return n.toolCalls.length;
  return null;
}

const maxSteps = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

/** The model from "Texo AI · <profile> (<model>)", or null. */
export function modelFromAuthor(authorName: string): string | null {
  return /^Texo AI · .+? \((.+)\)$/.exec(authorName)?.[1] ?? null;
}

/**
 * Groups entries (newest first, as `history_log` returns them) by day, and
 * folds consecutive AI commits of the same run into one group.
 */
export function groupTimeline(entries: HistoryEntry[], now: Date = new Date()): DayGroup[] {
  const days: DayGroup[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.time);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(entry.time, now), items: [] };
      days.push(day);
    }
    const last = day.items[day.items.length - 1];
    if (entry.author === "ai" && entry.runId) {
      if (last?.type === "run" && last.runId === entry.runId) {
        last.entries.push(entry);
        last.steps = maxSteps(last.steps, entrySteps(entry));
        if (!last.model && entry.model) last.model = entry.model;
        continue;
      }
      day.items.push({
        type: "run",
        runId: entry.runId,
        agent: agentName(entry),
        model: entry.model ?? modelFromAuthor(entry.authorName),
        entries: [entry],
        steps: entrySteps(entry),
      });
    } else {
      day.items.push({ type: "entry", entry });
    }
  }
  return days;
}

const REASONS: Record<HistoryReason, string> = {
  idle: "Your edits",
  "before-compile": "Before compiling",
  "before-run": "Before an AI run",
  close: "When the project closed",
  manual: "Saved by you",
  "agent-apply": "AI changes you accepted",
  restore: "Restored an earlier version",
  undo: "Undid an AI run",
  start: "First version",
};

/** A short title for a version: its summary (Rust writes plain words), else the reason. */
export function entryTitle(e: Pick<HistoryEntry, "reason" | "summary" | "undoOf">): string {
  const first = e.summary.split("\n")[0].trim();
  if (first) return first;
  if (e.undoOf) return REASONS.undo;
  return e.reason ? REASONS[e.reason] : "A version";
}

/** The reason in plain words ("Before compiling"), or null. */
export function reasonText(reason: HistoryReason | null): string | null {
  return reason ? REASONS[reason] : null;
}

/** Whether "Undo this AI run" makes sense for this group (not already an undo). */
export function canUndoRun(group: RunGroup, all: HistoryEntry[]): boolean {
  return !all.some((e) => e.undoOf === group.runId);
}

/** "3 files changed" for a toast. */
export function filesText(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** Plain summary after a restore or undo. */
export function restoreSummary(r: { commit: string | null; written: string[]; deleted: string[]; failed: string[] }): string {
  if (!r.commit && r.written.length === 0 && r.deleted.length === 0) return "Nothing to change: the files already match that version.";
  const parts: string[] = [];
  if (r.written.length) parts.push(`${filesText(r.written.length)} restored`);
  if (r.deleted.length) parts.push(`${filesText(r.deleted.length)} removed (still in history)`);
  let text = parts.join(", ") + ".";
  if (r.failed.length) text += ` ${filesText(r.failed.length)} couldn't be written and kept their current text (open in another app, read-only, or too big for history): ${r.failed.slice(0, 3).join(", ")}.`;
  return text;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** What the user sees after "Undo this AI run": a headline, and the files to call out. */
export interface UndoOutcome {
  /** "success" when everything was undone; "partial" when files were left alone or failed. */
  tone: "success" | "partial";
  text: string;
  /** Files you changed after the AI did; they were left as they are. */
  conflicts: string[];
  failed: string[];
}

export function undoOutcome(r: { commit: string | null; written: string[]; deleted: string[]; conflicts: string[]; failed: string[] }): UndoOutcome {
  const changed = r.written.length + r.deleted.length;
  let text = changed ? `Undid the AI run (${restoreSummary({ ...r, failed: [] }).replace(/\.$/, "")}).` : "Nothing was undone: the files already match.";
  const c = r.conflicts.length;
  if (c)
    text += ` You changed ${plural(c, "1 of its files", `${c} of its files`)} afterwards, so ${plural(c, "it was", "they were")} left as ${plural(c, "it is", "they are")}.`;
  if (r.failed.length) text += ` ${filesText(r.failed.length)} couldn't be written and kept their current text (open in another app, read-only, or too big for history).`;
  return { tone: c || r.failed.length ? "partial" : "success", text, conflicts: r.conflicts, failed: r.failed };
}

/** The file name at the end of a project path ("chapters/intro.tex" → "intro.tex"). */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
