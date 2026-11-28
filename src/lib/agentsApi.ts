// Bindings for the agents runtime (src-tauri/src/agents): background AI runs
// that work in a private copy of the project and end with a changeset for
// review. Accepting writes through the change history (one AI commit).
//
// Events: `agent-run-updated` (RunSummary), `agent-step` (StepEvent),
// `agent-message` (MessageEvent, streamed text; chat-style kinds only).
//
// Before `agentApply`, save any unsaved editor buffers of the files being
// applied: the merge compares the run's starting text with the file on disk.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ReviewSetup } from "./reviewApi";

export type AgentKindId = "fixer" | "reviewer" | "rebuttal" | "task" | "chat" | (string & {});

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "awaiting_review"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

export type StepKind = "think" | "toolCall" | "message";

export interface Step {
  /** 1-based, unique in the run (sub-runs share the numbering). */
  n: number;
  kind: StepKind;
  tool?: string;
  /** Tool arguments, long strings shortened. */
  args?: Record<string, unknown>;
  /** One line for the step list. */
  resultSummary: string;
  /** The tool result as the model saw it (capped at 2000 chars). */
  result?: string;
  /** Message / think text. */
  text?: string;
  ok: boolean;
  ms: number;
  /** Seconds since 1970. */
  at: number;
  /** Sub-run label (e.g. a reviewer persona). */
  sub?: string;
  /** A notice from Texo (model switched, retrying…), not the model's words. */
  notice?: boolean;
  /** Structured data from the tool, e.g. `{papers: [...]}` (at most 10, abstracts ≤ 300 chars). */
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Run progress (agents/types.rs RunProgress): phases, plan, the running tool
// ---------------------------------------------------------------------------

export type PhaseStatus = "pending" | "active" | "done" | "failed" | "skipped";

/** One stage of a run, in order (kind-specific: fixer rounds, reviewers …). */
export interface Phase {
  id: string;
  label: string;
  status: PhaseStatus;
  /** Seconds since 1970. */
  startedAt?: number;
  finishedAt?: number;
  /** One line, e.g. "3 errors left". */
  detail?: string;
  done?: number;
  total?: number;
}

export type PlanStatus = "pending" | "active" | "done" | "partly" | "notDone" | "skipped";

export interface PlanItem {
  /** 1-based. */
  n: number;
  task: string;
  status: PlanStatus;
  note?: string;
}

export type SourceState = "pending" | "ok" | "waiting" | "degraded";

/** One source (arXiv, Crossref …) of the tool running now. */
export interface SourceChip {
  source: string;
  state: SourceState;
  /** e.g. "14" results or "3s" to wait. */
  detail?: string;
}

/** The tool running right now (never kept in the journal). */
export interface Activity {
  tool: string;
  /** e.g. `Searching papers: "diffusion transformers"`. */
  label: string;
  /** Sub-run label (e.g. a reviewer persona). */
  sub?: string;
  /** Seconds since 1970. */
  startedAt: number;
  sources?: SourceChip[];
  /** A line the tool streams about what it does now. */
  detail?: string;
}

export interface RunProgress {
  phases: Phase[];
  plan: PlanItem[];
  activity: Activity | null;
  /** e.g. papersFound, papersNew, duplicates, keysChecked. */
  counts: Record<string, number>;
}

export const EMPTY_PROGRESS: RunProgress = { phases: [], plan: [], activity: null, counts: {} };

const PHASE_STATUSES: readonly string[] = ["pending", "active", "done", "failed", "skipped"];
const PLAN_STATUSES: readonly string[] = ["pending", "active", "done", "partly", "notDone", "skipped"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optNum = (v: unknown) => v === undefined || typeof v === "number";
const optStr = (v: unknown) => v === undefined || typeof v === "string";

function isPhase(v: unknown): v is Phase {
  return (
    isObj(v) &&
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    PHASE_STATUSES.includes(v.status as string) &&
    optNum(v.startedAt) &&
    optNum(v.finishedAt) &&
    optStr(v.detail) &&
    optNum(v.done) &&
    optNum(v.total)
  );
}

function isPlanItem(v: unknown): v is PlanItem {
  return isObj(v) && typeof v.n === "number" && typeof v.task === "string" && PLAN_STATUSES.includes(v.status as string) && optStr(v.note);
}

function isActivity(v: unknown): v is Activity {
  return (
    isObj(v) &&
    typeof v.tool === "string" &&
    typeof v.label === "string" &&
    typeof v.startedAt === "number" &&
    optStr(v.sub) &&
    optStr(v.detail) &&
    (v.sources === undefined || (Array.isArray(v.sources) && v.sources.every((s) => isObj(s) && typeof s.source === "string")))
  );
}

/** A well-formed `progress` (runs from Texo 1.2 have none: use `runProgress`). */
export function isRunProgress(v: unknown): v is RunProgress {
  return (
    isObj(v) &&
    Array.isArray(v.phases) &&
    v.phases.every(isPhase) &&
    Array.isArray(v.plan) &&
    v.plan.every(isPlanItem) &&
    (v.activity === null || v.activity === undefined || isActivity(v.activity)) &&
    isObj(v.counts) &&
    Object.values(v.counts).every((n) => typeof n === "number")
  );
}

/** A run's progress, or an empty one when it has none (or a malformed one). */
export function runProgress(run: { progress?: unknown }): RunProgress {
  const p = run.progress;
  if (!isRunProgress(p)) return EMPTY_PROGRESS;
  return { ...p, activity: p.activity ?? null };
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  toolCalls: number;
}

export interface Attachment {
  name: string;
  mime: string;
  /** Bytes as base64 (images after downscaling, small text files). */
  dataBase64?: string;
  /** A file inside the project. */
  path?: string;
  /** Text already extracted in the webview (PDFs). */
  text?: string;
  /** "Also save into project": project path; goes through the changeset (text only). */
  saveAs?: string;
}

export interface AttachmentInfo {
  name: string;
  mime: string;
  path?: string;
  usedAs: "image" | "text" | "described" | "skipped";
  note?: string;
}

export interface DirtyBuffer {
  file: string;
  text: string;
}

export interface RunOptions {
  title?: string | null;
  model?: string | null;
  fallbackModels?: string[] | null;
  thinking?: boolean | null;
  /** The model can see images; omit to use the known model list (else the vision fallback describes them). */
  vision?: boolean | null;
  maxSteps?: number | null;
  /** Whole-run limit in seconds (default 15 min). */
  timeoutSecs?: number | null;
  /** Narrow the kind's tools to these names. */
  tools?: string[] | null;
  /** Profile instructions, added to the system prompt. */
  instructions?: string | null;
  /** History author: "Texo AI · <profileName> (<model>)". */
  profileName?: string | null;
  /** Apply when the run finishes, unless something needs attention. */
  autoApply?: boolean;
  /**
   * Kind-specific settings. Reviewer: `{review?: ReviewSetup, export?: "md" | "tex" | "both" | ("md"|"tex")[]}`
   * (export writes review.md / review.tex through the changeset). Rebuttal: `{reviewRunId?: string, reviewReport?: ReviewReport}`
   * (an earlier Texo review to answer). See `ReviewerExtra` / `RebuttalExtra`.
   */
  extra?: unknown;
}

export interface StartRequest {
  /** May be "" when `profileId` is given: the profile's kind is used. */
  kind: AgentKindId;
  /** A profile fills in the kind and every option the request leaves open. */
  profileId?: string | null;
  prompt: string;
  attachments?: Attachment[];
  dirtyBuffers?: DirtyBuffer[];
  options?: RunOptions;
}

export type FileStatus = "added" | "modified" | "deleted";
export type FileState = "pending" | "applied" | "rejected" | "conflict";

export interface ChangeEntry {
  file: string;
  baseText: string | null;
  baseHash: string;
  newText: string | null;
  reason: string;
  state: FileState;
  mergedText?: string;
  attention?: string[];
}

export interface Hunk {
  index: number;
  /** 1-based first base line (pure insertion: the line after which, 0 = top). */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ChangesetFile {
  file: string;
  baseText: string | null;
  newText: string | null;
  status: FileStatus;
  /** Applying now would conflict with the current file: needs a manual pick. */
  conflict: boolean;
  /** The file changed on disk since the run read it (it will be merged). */
  changedOnDisk: boolean;
  baseHash: string;
  reason: string;
  state: FileState;
  hunks: Hunk[];
  /** Both versions with conflict markers, after a conflicting apply. */
  mergedText?: string;
  /** "Needs your attention" reasons; never applied automatically. */
  attention?: string[];
}

export interface Changeset {
  runId: string;
  files: ChangesetFile[];
}

export interface Decision {
  file: string;
  accept: boolean;
  /** Accept only these hunk indices; omit for all. */
  hunks?: number[] | null;
  /** The user's own final text (edited diff or conflict resolution); wins over hunks. */
  editedText?: string | null;
  /** Why it was rejected (offer it as a memory note). */
  reason?: string | null;
}

export interface MergeConflict {
  file: string;
  baseText: string | null;
  oursText: string | null;
  theirsText: string | null;
  mergedText: string | null;
  reason: string;
}

/** A run's structured result; `kind` names the schema, the rest is the kind's fields. */
export interface Report {
  kind: string;
  [field: string]: unknown;
}

export interface RunSummary {
  id: string;
  project: string;
  kind: AgentKindId;
  profileId: string | null;
  profileName: string | null;
  title: string;
  status: RunStatus;
  model: string;
  stepCount: number;
  lastStep: string | null;
  /** Files still waiting for a decision. */
  pendingFiles: number;
  changedFiles: number;
  conflictFiles: number;
  needsAttention: boolean;
  hasReport: boolean;
  usage: RunUsage;
  startedAt: number;
  finishedAt: number | null;
  /** Plain words: why it failed or stopped early. */
  error: string | null;
  /** What the run waits for in `awaiting_input` (kind-specific). */
  awaiting: unknown;
  /** Phases, plan, the running tool, counters. Texo 1.3 always sends it; read it with `runProgress`. */
  progress?: RunProgress;
  /** The step limit of the run's main loop (fixer 16, reviewer 40, others 24, or the profile's). */
  maxSteps?: number;
  /** When the run's time limit ends (seconds since 1970); null while it waits for you. */
  deadlineAt?: number | null;
}

export interface AgentRun {
  version: number;
  id: string;
  project: string;
  kind: AgentKindId;
  profileId: string | null;
  profileName: string | null;
  title: string;
  prompt: string;
  attachments: AttachmentInfo[];
  status: RunStatus;
  model: string;
  provider: string;
  steps: Step[];
  changeset: ChangeEntry[];
  report: Report | null;
  finalMessage: string | null;
  usage: RunUsage;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  awaiting: unknown;
  /** The "before run" snapshot in the history. */
  startCommit: string | null;
  applyCommits: string[];
  options: RunOptions;
  progress?: RunProgress;
  maxSteps?: number;
  deadlineAt?: number | null;
}

export interface ApplyResult {
  commit: string | null;
  written: string[];
  deleted: string[];
  rejected: string[];
  conflicts: MergeConflict[];
  historyError: string | null;
  run: RunSummary;
}

export interface StepEvent {
  runId: string;
  step: Step;
}

export interface MessageEvent {
  runId: string;
  sub?: string;
  text: string;
  /** Forget the text streamed so far for this run (and sub-run). */
  reset: boolean;
}

export const AGENT_RUN_UPDATED_EVENT = "agent-run-updated";
export const AGENT_STEP_EVENT = "agent-step";
export const AGENT_MESSAGE_EVENT = "agent-message";

export const agentsApi = {
  start: (project: string, request: StartRequest) => invoke<RunSummary>("agent_start", { project, request }),
  list: (project: string) => invoke<RunSummary[]>("agent_list", { project }),
  get: (project: string, runId: string) => invoke<AgentRun>("agent_get", { project, runId }),
  cancel: (runId: string) => invoke<boolean>("agent_cancel", { runId }),
  /** Answer a run in `awaiting_input` (e.g. an approved or edited plan). */
  respond: (runId: string, input: unknown) => invoke<void>("agent_respond", { runId, input }),
  changeset: (project: string, runId: string) => invoke<Changeset>("agent_changeset", { project, runId }),
  apply: (project: string, runId: string, decisions: Decision[]) =>
    invoke<ApplyResult>("agent_apply", { project, runId, decisions }),
  discard: (project: string, runId: string) => invoke<RunSummary>("agent_discard", { project, runId }),
  delete: (project: string, runId: string) => invoke<void>("agent_delete", { project, runId }),
  onRunUpdated: (cb: (run: RunSummary) => void): Promise<UnlistenFn> =>
    listen<RunSummary>(AGENT_RUN_UPDATED_EVENT, (e) => cb(e.payload)),
  onStep: (cb: (e: StepEvent) => void): Promise<UnlistenFn> => listen<StepEvent>(AGENT_STEP_EVENT, (e) => cb(e.payload)),
  onMessage: (cb: (e: MessageEvent) => void): Promise<UnlistenFn> =>
    listen<MessageEvent>(AGENT_MESSAGE_EVENT, (e) => cb(e.payload)),
};

/** Still working (a cancel button makes sense). */
export function isActive(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "awaiting_input";
}

/** Plain words for a run card. */
export function runStatusText(run: Pick<RunSummary, "status" | "pendingFiles" | "conflictFiles">): string {
  switch (run.status) {
    case "queued":
      return "Waiting for a free slot";
    case "running":
      return "Working…";
    case "awaiting_input":
      return "Waiting for you";
    case "awaiting_review":
      if (run.conflictFiles > 0) return `${run.conflictFiles} file(s) need a manual pick`;
      return `${run.pendingFiles} file(s) to review`;
    case "done":
      return "Done";
    case "failed":
      return "Didn't finish";
    case "cancelled":
      return "Stopped";
    case "interrupted":
      return "Stopped when Texo closed";
  }
}

/** Decisions that accept every undecided file of a changeset ("Accept all"). */
export function acceptAll(cs: Changeset): Decision[] {
  return cs.files.filter((f) => f.state === "pending" || f.state === "conflict").map((f) => ({ file: f.file, accept: true }));
}

// ---------------------------------------------------------------------------
// Kind reports and the rebuttal plan (src-tauri/src/agents/kinds)
// ---------------------------------------------------------------------------

/** `options.extra` of a reviewer run. */
export interface ReviewerExtra {
  review?: ReviewSetup;
  /** Also write review.md / review.tex into the project (through the changeset). */
  export?: "md" | "tex" | "both" | ("md" | "tex")[];
}

/** `options.extra` of a rebuttal run: an earlier Texo review to answer. */
export interface RebuttalExtra {
  reviewRunId?: string;
  reviewReport?: unknown;
}

/** The fixer's report (`kind: "fix"`). */
export interface FixReport extends Report {
  kind: "fix";
  /** The last shadow compile succeeded. */
  fixed: boolean;
  /** Texo could compile in this run (false: the fix isn't checked). */
  compiled: boolean;
  /** Compile rounds used (at most 3). */
  rounds: number;
  remaining: { file: string | null; line: number | null; message: string }[];
  /** Offer the one-click install (`installTexPackage`) for these. */
  missingPackages: string[];
  /** What the first remaining error means (plain words), when not fixed. */
  explanation: string | null;
  summary: string;
}

export type TaskStatus = "done" | "partly" | "notDone" | "unknown";

export interface TaskResult {
  /** 1-based, as in the plan. */
  n: number;
  task: string;
  status: TaskStatus;
  note: string;
}

/** The task agent's report (`kind: "task"`): one entry per planned task. */
export interface TaskReport extends Report {
  kind: "task";
  tasks: TaskResult[];
  /** e.g. "2 of 3 task(s) done, 1 partly, 0 not done." */
  summary: string;
}

export type RebuttalAction = "answer" | "change" | "experiment";

export interface RebuttalConcern {
  /** "R1.2": reviewer 1, point 2. */
  id: string;
  reviewer: string;
  quote: string;
  summary: string;
  action: RebuttalAction;
  plan: string;
  file?: string;
  /** After drafting: "answered" | "changed" | "tbd" | "skipped". */
  status?: string;
  /** After drafting: where the manuscript changed. */
  changes?: string;
}

/** `run.awaiting` while a rebuttal run waits for its plan to be approved. */
export interface RebuttalPlanPayload {
  type: "rebuttalPlan";
  concerns: RebuttalConcern[];
  message: string;
}

/** What to send with `agentsApi.respond` for a rebuttal plan. */
export interface RebuttalPlanAnswer {
  approved: boolean;
  /** The edited plan; omit to keep the proposed one. */
  concerns?: RebuttalConcern[];
  /** A note for the drafting step. */
  note?: string;
}

/** The rebuttal's report (`kind: "rebuttal"`). */
export interface RebuttalReport extends Report {
  kind: "rebuttal";
  summary: string;
  concerns: RebuttalConcern[];
  /** "response-to-reviewers.tex", or null when it wasn't written (or you stopped before drafting). */
  letter: string | null;
  /** The `[TBD: …]` placeholders in the letter: experiments still to run. */
  tbd: string[];
  warnings: string[];
}

export const REBUTTAL_LETTER = "response-to-reviewers.tex";

export function isFixReport(r: Report | null | undefined): r is FixReport {
  return r?.kind === "fix";
}

export function isTaskReport(r: Report | null | undefined): r is TaskReport {
  return r?.kind === "task";
}

export function isRebuttalReport(r: Report | null | undefined): r is RebuttalReport {
  return r?.kind === "rebuttal";
}

/** The run waits for its rebuttal plan to be approved. */
export function isRebuttalPlan(awaiting: unknown): awaiting is RebuttalPlanPayload {
  return (
    typeof awaiting === "object" &&
    awaiting !== null &&
    (awaiting as { type?: unknown }).type === "rebuttalPlan" &&
    Array.isArray((awaiting as { concerns?: unknown }).concerns)
  );
}

/** The answer that approves a (possibly edited) plan; blank notes are left out. */
export function approvePlan(concerns?: RebuttalConcern[], note?: string): RebuttalPlanAnswer {
  const answer: RebuttalPlanAnswer = { approved: true };
  if (concerns) answer.concerns = concerns;
  if (note && note.trim()) answer.note = note.trim();
  return answer;
}

/** Plain words for a task status. */
export function taskStatusText(s: TaskStatus): string {
  switch (s) {
    case "done":
      return "Done";
    case "partly":
      return "Partly done";
    case "notDone":
      return "Not done";
    case "unknown":
      return "Not reported";
  }
}

// ---------------------------------------------------------------------------
// Profiles, defaults and project memory (agents/profiles.rs, profile_commands.rs)
// ---------------------------------------------------------------------------

export type ProfileSource = "builtin" | "global" | "project";
/** Which file a save or delete goes to. */
export type ProfileScope = "global" | "project";

export interface AgentProfile {
  /** Lowercase letters, digits, dashes; "" when creating (made from the name). */
  id: string;
  name: string;
  kind: AgentKindId;
  description: string;
  instructions: string;
  /** null: the default model for the kind's role. */
  model: string | null;
  fallbackModels: string[];
  /** A subset of the kind's tools; empty: all of them. */
  tools: string[];
  autoApply: boolean;
  /** null: the kind's limit (fixer 16, reviewer 40, others 24). */
  maxSteps: number | null;
  thinking?: boolean | null;
  vision?: boolean | null;
  /** Reviewer profiles only. */
  review?: ReviewSetup | null;
  /** Output only. */
  source: ProfileSource;
  /** Output only: a built-in profile the user changed (Reset undoes it). */
  overridesBuiltin: boolean;
}

export interface RoleModels {
  model: string;
  fallbacks: string[];
  thinking?: boolean | null;
}

export interface RoleSet {
  agent?: RoleModels | null;
  chat?: RoleModels | null;
  vision?: RoleModels | null;
  review?: RoleModels | null;
}

export interface AgentDefaults {
  /** Per provider id ("nvidia", "anthropic", …). The list view has the built-in defaults filled in. */
  roles: Record<string, RoleSet>;
  /** 1–5. Saved; the runtime currently always allows 3. */
  maxParallel: number;
}

export interface ProfilesView {
  /** Built-ins first (in kind order), then global, then project profiles. */
  profiles: AgentProfile[];
  defaults: AgentDefaults;
  builtinIds: string[];
  /** Files or profiles that couldn't be read (plain words). */
  warnings: string[];
}

export interface MemoryInfo {
  text: string;
  bytes: number;
  maxBytes: number;
}

export const BUILTIN_PROFILE_IDS = ["fixer", "reviewer", "rebuttal", "task", "chat"] as const;
export const MEMORY_MAX_BYTES = 8 * 1024;

export const profilesApi = {
  /** Merged profiles; pass the project to include its own profiles. */
  list: (project?: string | null) => invoke<ProfilesView>("agent_profiles_list", { project: project ?? null }),
  /** Creates (id "") or replaces. Saving a built-in's id overrides it. */
  save: (scope: ProfileScope, profile: AgentProfile, project?: string | null) =>
    invoke<ProfilesView>("agent_profiles_save", { project: project ?? null, scope, profile }),
  /** Ask the user first. Built-ins can't be deleted, only reset. */
  remove: (scope: ProfileScope, id: string, project?: string | null) =>
    invoke<ProfilesView>("agent_profiles_delete", { project: project ?? null, scope, id }),
  /** Undo the user's changes to a built-in profile (global and project). */
  reset: (id: string, project?: string | null) => invoke<ProfilesView>("agent_profiles_reset", { project: project ?? null, id }),
  saveDefaults: (defaults: AgentDefaults, project?: string | null) =>
    invoke<ProfilesView>("agent_defaults_save", { project: project ?? null, defaults }),
};

export const memoryApi = {
  get: (project: string) => invoke<MemoryInfo>("memory_get", { project }),
  /** Refused over 8 KB (the message says so); blank text clears it. */
  set: (project: string, text: string) => invoke<MemoryInfo>("memory_set", { project, text }),
  /** Ask the user first. */
  clear: (project: string) => invoke<MemoryInfo>("memory_clear", { project }),
  /** Adds one note ("Remember this for next time?" after a rejected change). */
  add: (project: string, note: string) => invoke<MemoryInfo>("memory_add", { project, note }),
};

/** A blank profile of a kind for the "New profile" form. */
export function newProfile(kind: AgentKindId, name = ""): AgentProfile {
  return {
    id: "",
    name,
    kind,
    description: "",
    instructions: "",
    model: null,
    fallbackModels: [],
    tools: [],
    autoApply: false,
    maxSteps: null,
    review: null,
    source: "global",
    overridesBuiltin: false,
  };
}

/** A copy of a profile to save as a new one ("Duplicate"). */
export function duplicateProfile(p: AgentProfile): AgentProfile {
  return { ...p, id: "", name: `${p.name} (copy)`, source: "global", overridesBuiltin: false };
}

/** A run request that uses a profile (the backend fills in the rest). */
export function profileRequest(profile: Pick<AgentProfile, "id" | "kind">, prompt: string, extra?: Partial<StartRequest>): StartRequest {
  return { ...extra, kind: profile.kind, profileId: profile.id, prompt };
}

/** The UTF-8 size of a text, for the 8 KB memory counter. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text.replace(/\r\n/g, "\n")).length;
}
