// What the Command Center pill says and what its popover lists, as pure
// functions over run summaries and chat summaries (tested without a DOM).
// The pill shows the one state that matters most right now; the popover
// groups runs into Needs attention / Running / Recent tasks and the chats
// into Today / Yesterday / Earlier, filtered by a fuzzy search.

import { isRebuttalPlan, runProgress, runStatusText, type RunStatus, type RunSummary } from "../../lib/agentsApi";
import type { ChatSummary } from "../../lib/chatApi";
import { fuzzyMatch } from "../../lib/fuzzy";
import { kindLabel } from "../agents/runsStore";

/** Runs still working (the agent has the next move). */
const WORKING: RunStatus[] = ["queued", "running"];
/** Finishes worth telling the user about once (stopping a run yourself isn't news). */
const NEWS: RunStatus[] = ["done", "failed", "interrupted"];
/** Runs that need nothing more from anyone. */
const SETTLED: RunStatus[] = ["done", "failed", "interrupted", "cancelled"];

export const isWorking = (s: RunStatus) => WORKING.includes(s);
export const isFailed = (s: RunStatus) => s === "failed" || s === "interrupted";

/** How many settled runs the popover lists under Recent tasks. */
export const RECENT_RUNS = 5;
/** How many chats the popover lists before "Show all chats". */
export const MAX_CHATS = 8;

// ---------------------------------------------------------------------------
// Unseen finishes
// ---------------------------------------------------------------------------

/** Run statuses as last observed, and the runs that finished while nobody was looking. */
export interface SeenState {
  last: Record<string, RunStatus>;
  unseen: Record<string, true>;
}

export const EMPTY_SEEN: SeenState = { last: {}, unseen: {} };

/**
 * Feeds the current runs. A run that goes from working to done, failed or
 * interrupted while `watching` is false (the Agents tab isn't in view) is
 * marked unseen; a run first observed already settled is not news. A run
 * that works again (retried) or disappears (deleted) is no longer unseen.
 */
export function trackUnseen(
  state: SeenState,
  runs: Pick<RunSummary, "id" | "status">[],
  watching: boolean | ((runId: string) => boolean),
): SeenState {
  const sees = typeof watching === "function" ? watching : () => watching;
  const last: Record<string, RunStatus> = {};
  const unseen: Record<string, true> = {};
  for (const r of runs) {
    last[r.id] = r.status;
    const before = state.last[r.id];
    const finishedNow = before !== undefined && isWorking(before) && NEWS.includes(r.status);
    if (finishedNow && !sees(r.id)) unseen[r.id] = true;
    else if (state.unseen[r.id] && !finishedNow && NEWS.includes(r.status)) unseen[r.id] = true;
  }
  return { last, unseen };
}

/** Forgets the unseen marks of `ids` (all of them when left out). */
export function markSeen(state: SeenState, ids?: string[]): SeenState {
  if (!ids) return Object.keys(state.unseen).length ? { ...state, unseen: {} } : state;
  if (!ids.some((id) => state.unseen[id])) return state;
  const unseen = { ...state.unseen };
  for (const id of ids) delete unseen[id];
  return { ...state, unseen };
}

// ---------------------------------------------------------------------------
// Words and numbers for one run
// ---------------------------------------------------------------------------

/** "1 file", "3 files". */
export const filesText = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** A short name for what the run is: "Fixer", "Review", or a custom profile's name. */
export function runNoun(run: Pick<RunSummary, "kind" | "profileName" | "profileId" | "title">): string {
  switch (run.kind) {
    case "fixer":
      return "Fixer";
    case "reviewer":
      return "Review";
    case "rebuttal":
      return "Response to reviewers";
    case "task":
      return run.profileId && run.profileName ? run.profileName : "Task";
    default:
      return run.profileName || run.title.trim() || kindLabel(run.kind);
  }
}

/** The run's title, or its kind when it has none. */
export const runTitle = (run: Pick<RunSummary, "title" | "kind">) => run.title.trim() || kindLabel(run.kind);

/** True when a run waits for the user to approve a plan. */
export const wantsPlan = (run: Pick<RunSummary, "status" | "awaiting">) => run.status === "awaiting_input" && isRebuttalPlan(run.awaiting);

/** How far along a run is, 0 to 1, or null when that can't be told (the ring spins). */
export function runProgressFraction(run: RunSummary): number | null {
  const p = runProgress(run);
  if (p.plan.length) {
    const done = p.plan.filter((i) => i.status !== "pending" && i.status !== "active").length;
    return done / p.plan.length;
  }
  const phases = p.phases.filter((ph) => ph.status !== "skipped");
  if (phases.length) {
    let done = 0;
    for (const ph of phases) {
      if (ph.status === "done" || ph.status === "failed") done += 1;
      else if (ph.status === "active" && ph.total) done += Math.min(1, (ph.done ?? 0) / ph.total);
    }
    return done / phases.length;
  }
  if (run.status === "running" && run.maxSteps && run.maxSteps > 0) return Math.min(0.95, run.stepCount / run.maxSteps);
  return null;
}

/** What a working run does right now: the running tool, the active phase, or its last step. */
export function activityText(run: RunSummary): string {
  if (run.status === "queued") return runStatusText(run);
  const p = runProgress(run);
  if (p.activity?.label) return p.activity.label;
  const phase = p.phases.find((ph) => ph.status === "active");
  if (phase) {
    if (phase.detail) return `${phase.label}: ${phase.detail}`;
    if (phase.total) return `${phase.label} (${phase.done ?? 0} of ${phase.total})`;
    return phase.label;
  }
  return run.lastStep?.trim() || runStatusText(run);
}

/** The active phase's name, for a Running row (falls back to the status). */
export function phaseText(run: RunSummary): string {
  if (run.status === "queued") return runStatusText(run);
  const phase = runProgress(run).phases.find((ph) => ph.status === "active");
  return phase?.label ?? activityText(run);
}

// ---------------------------------------------------------------------------
// The pill
// ---------------------------------------------------------------------------

export type PillKind = "needsInput" | "review" | "failed" | "running" | "finished" | "idle";

export interface PillState {
  kind: PillKind;
  text: string;
  /** The run the pill speaks about, if one. */
  runId: string | null;
  /** More runs in the same state, shown as "+n". */
  more: number;
  /** For "running": how far along, or null for a spinning ring. */
  fraction: number | null;
}

export const IDLE_TEXT = "Ask AI · recent chats";

const byNewest = (a: RunSummary, b: RunSummary) => b.startedAt - a.startedAt || b.id.localeCompare(a.id);

/**
 * The pill's state; the first that applies wins: a run waits for input, a run
 * has changes to review, a run failed unseen, runs are working, a run finished
 * unseen, otherwise idle.
 */
export function pillState(runs: RunSummary[], unseen: Record<string, true>): PillState {
  const sorted = runs.slice().sort(byNewest);
  const state = (kind: PillKind, text: string, group: RunSummary[], fraction: number | null = null): PillState => ({
    kind,
    text,
    runId: group[0]?.id ?? null,
    more: Math.max(0, group.length - 1),
    fraction,
  });

  const input = sorted.filter((r) => r.status === "awaiting_input");
  if (input.length) {
    const [r] = input;
    const text = wantsPlan(r) ? "Plan needs your approval" : `${runNoun(r)} is waiting for you`;
    return state("needsInput", text, input);
  }

  const review = sorted.filter((r) => r.status === "awaiting_review");
  if (review.length) {
    const conflicts = review.reduce((n, r) => n + r.conflictFiles, 0);
    const pending = review.reduce((n, r) => n + r.pendingFiles, 0);
    const text = conflicts > 0 ? `${filesText(conflicts)} need a manual pick` : pending > 0 ? `${filesText(pending)} to review` : "Changes to review";
    return { ...state("review", text, review), more: 0 };
  }

  const failed = sorted.filter((r) => isFailed(r.status) && unseen[r.id]);
  if (failed.length) return state("failed", `${runNoun(failed[0])} failed: open`, failed);

  const working = sorted.filter((r) => isWorking(r.status));
  if (working.length) {
    // Speak about a run that is actually going before one waiting for a slot.
    const lead = working.find((r) => r.status === "running") ?? working[0];
    const group = [lead, ...working.filter((r) => r !== lead)];
    return state("running", activityText(lead), group, runProgressFraction(lead));
  }

  const finished = sorted.filter((r) => r.status === "done" && unseen[r.id]);
  if (finished.length) return state("finished", `${runNoun(finished[0])} finished`, finished);

  return { kind: "idle", text: IDLE_TEXT, runId: null, more: 0, fraction: null };
}

// ---------------------------------------------------------------------------
// Chats by day
// ---------------------------------------------------------------------------

export type ChatGroupLabel = "Today" | "Yesterday" | "Earlier";

export interface ChatGroup {
  label: ChatGroupLabel;
  chats: ChatSummary[];
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Chats newest first, at most `limit`, in Today / Yesterday / Earlier (local days); empty groups are left out. */
export function groupChats(chats: ChatSummary[], now: Date = new Date(), limit = MAX_CHATS): ChatGroup[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: ChatGroup[] = [
    { label: "Today", chats: [] },
    { label: "Yesterday", chats: [] },
    { label: "Earlier", chats: [] },
  ];
  const sorted = chats.slice().sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
  for (const c of sorted.slice(0, Math.max(0, limit))) {
    const g = c.updated >= today ? 0 : c.updated >= yesterday ? 1 : 2;
    groups[g].chats.push(c);
  }
  return groups.filter((g) => g.chats.length > 0);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** The best fuzzy score of `query` over `texts`, or null when none matches. An empty query matches everything with 0. */
export function matchScore(query: string, texts: (string | null | undefined)[]): number | null {
  if (!query.trim()) return 0;
  let best: number | null = null;
  for (const t of texts) {
    if (!t) continue;
    const m = fuzzyMatch(query, t);
    if (m && (best === null || m.score > best)) best = m.score;
  }
  return best;
}

/** The items whose texts match `query`, best first (in their own order when the query is empty). */
export function fuzzyItems<T>(query: string, items: T[], texts: (item: T) => (string | null | undefined)[]): T[] {
  if (!query.trim()) return items.slice();
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const score = matchScore(query, texts(item));
    if (score !== null) scored.push({ item, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.item);
}

/** What a run is searched by. */
export const runTexts = (r: RunSummary) => [r.title, runNoun(r), kindLabel(r.kind), r.profileName];
/** What a chat is searched by. */
export const chatTexts = (c: ChatSummary) => [c.title, c.preview];

// ---------------------------------------------------------------------------
// The popover's rows
// ---------------------------------------------------------------------------

/** What a Needs attention row does when picked. */
export type AttentionAction = { label: "Review plan"; dialog: "plan" } | { label: "Review changes"; dialog: "changes" } | { label: "Open"; dialog: null };

export type Row =
  | { type: "attention"; id: string; run: RunSummary; reason: string; action: AttentionAction }
  | { type: "running"; id: string; run: RunSummary }
  | { type: "recent"; id: string; run: RunSummary }
  | { type: "chat"; id: string; chat: ChatSummary; pending: boolean }
  | { type: "allChats"; id: string };

export interface Section {
  id: "attention" | "running" | "recent" | ChatGroupLabel | "more";
  /** The heading, or null for a row that needs none. */
  label: string | null;
  rows: Row[];
}

function attentionOf(run: RunSummary): { reason: string; action: AttentionAction } {
  if (run.status === "awaiting_input") {
    return wantsPlan(run)
      ? { reason: "Plan needs your approval", action: { label: "Review plan", dialog: "plan" } }
      : { reason: "Waiting for you", action: { label: "Open", dialog: null } };
  }
  if (run.status === "awaiting_review") {
    const reason = run.conflictFiles > 0 ? `${filesText(run.conflictFiles)} need a manual pick` : `${filesText(run.pendingFiles)} to review`;
    return { reason, action: { label: "Review changes", dialog: "changes" } };
  }
  return { reason: run.error?.trim() || "Didn't finish", action: { label: "Open", dialog: null } };
}

export interface SectionInput {
  runs: RunSummary[];
  chats: ChatSummary[];
  unseen: Record<string, true>;
  /** Chat ids with an answer being written. */
  pending: Record<string, unknown>;
  query: string;
  now?: Date;
}

/** The popover's groups, in order, with empty ones left out. */
export function buildSections({ runs, chats, unseen, pending, query, now = new Date() }: SectionInput): Section[] {
  const matched = fuzzyItems(query, runs.slice().sort(byNewest), runTexts);
  const searching = query.trim().length > 0;

  const attention = matched.filter((r) => r.status === "awaiting_input" || r.status === "awaiting_review" || (isFailed(r.status) && unseen[r.id]));
  const working = matched.filter((r) => isWorking(r.status));
  const recent = matched.filter((r) => SETTLED.includes(r.status) && !attention.includes(r)).slice(0, RECENT_RUNS);

  const sections: Section[] = [];
  if (attention.length)
    sections.push({ id: "attention", label: "Needs attention", rows: attention.map((run) => ({ type: "attention", id: `run-${run.id}`, run, ...attentionOf(run) })) });
  if (working.length) sections.push({ id: "running", label: "Running", rows: working.map((run) => ({ type: "running", id: `run-${run.id}`, run })) });
  if (recent.length) sections.push({ id: "recent", label: "Recent tasks", rows: recent.map((run) => ({ type: "recent", id: `run-${run.id}`, run })) });

  const found = fuzzyItems(query, chats, chatTexts);
  // While searching, the best matches come first, so day groups would scatter them: one list.
  const groups: ChatGroup[] = searching ? (found.length ? [{ label: "Earlier", chats: found.slice(0, MAX_CHATS) }] : []) : groupChats(found, now);
  for (const g of groups) {
    sections.push({
      id: g.label,
      label: searching ? "Chats" : g.label,
      rows: g.chats.map((chat) => ({ type: "chat", id: `chat-${chat.id}`, chat, pending: chat.id in pending })),
    });
  }
  // A search that found no chat leaves it out, so "Nothing matches." can show.
  if (searching ? found.length > 0 : chats.length > 0) sections.push({ id: "more", label: null, rows: [{ type: "allChats", id: "all-chats" }] });
  return sections;
}

/** Every row of the sections in order, for the arrow keys. */
export const flatRows = (sections: Section[]): Row[] => sections.flatMap((s) => s.rows);

/** The row index after pressing ↑ (delta -1) or ↓ (+1), wrapping at the ends; -1 when there are no rows. */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return delta < 0 ? count - 1 : 0;
  return (((current + delta) % count) + count) % count;
}

/** True for Ctrl+Shift+J (by key or by physical key, for other keyboard layouts). */
export function isCommandCenterShortcut(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key" | "code">): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key.toLowerCase() === "j" || e.code === "KeyJ");
}
