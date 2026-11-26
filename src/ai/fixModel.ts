// What the AI fixer works with on the frontend: the checked shape of an
// answer, friendly error states, and the round-by-round state machine of the
// fix panel. Pure and tested; the store wires it to the backend and editor.

import type { AiCompileInput, AiPreviousAttempt, CompileResult, Issue } from "../lib/api";
import { badEditPath, normalizePath, validPackageName, type ProposedEdit } from "./fixEdits";

export interface EnvAction {
  kind: "install_package";
  manager: "miktex" | "texlive";
  package: string;
  why: string;
  /** Texo found the package manager and can run it. */
  available: boolean;
  /** The command Texo would run, shown before the user confirms. */
  command: string;
}

/** An answer from the AI, checked: bad edits and actions are kept apart with a reason. */
export interface FixProposal {
  summary: string;
  cause: string;
  steps: string[];
  edits: ProposedEdit[];
  /** Edits refused before they were shown (outside the project, not a text file, ...). */
  rejected: { edit: ProposedEdit; reason: string }[];
  envActions: EnvAction[];
  confidence: "low" | "medium" | "high" | null;
  /** Remarks from the backend ("one suggestion was dropped ..."). */
  notes: string[];
  /** The model that answered. */
  model: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Accepts both `env_actions` and `envActions` style keys. */
function field(o: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (o[n] !== undefined) return o[n];
  return undefined;
}

function confidenceOf(v: unknown): FixProposal["confidence"] {
  if (typeof v === "number" && Number.isFinite(v)) {
    const x = v > 1 ? v / 100 : v;
    return x >= 0.75 ? "high" : x >= 0.4 ? "medium" : "low";
  }
  const s = str(v).toLowerCase();
  return s === "low" || s === "medium" || s === "high" ? s : null;
}

/** Checks an answer from the backend, whatever exact shape it arrives in. */
export function normalizeProposal(raw: unknown): FixProposal {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const edits: ProposedEdit[] = [];
  const rejected: FixProposal["rejected"] = [];
  const rawEdits = field(o, "edits");
  for (const e of Array.isArray(rawEdits) ? rawEdits : []) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const edit: ProposedEdit = {
      file: normalizePath(str(r.file)),
      find: str(r.find),
      replace: str(r.replace),
      why: str(r.why),
    };
    const pathProblem = badEditPath(edit.file);
    // The backend checks every edit too and says why one can't apply.
    if (r.ok === false) rejected.push({ edit, reason: str(r.reason) || "Texo can't apply this change." });
    else if (pathProblem) rejected.push({ edit, reason: pathProblem });
    else if (!edit.find) rejected.push({ edit, reason: "The suggestion doesn't say which text to change." });
    else if (edit.find === edit.replace) rejected.push({ edit, reason: "The suggestion doesn't change anything." });
    else edits.push(edit);
  }
  const envActions: EnvAction[] = [];
  const rawActions = field(o, "env_actions", "envActions");
  for (const a of Array.isArray(rawActions) ? rawActions : []) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const manager = str(r.manager).toLowerCase();
    const pkg = str(r.package).trim();
    if (str(r.kind) !== "install_package" && str(r.kind) !== "installPackage") continue;
    if (manager !== "miktex" && manager !== "texlive") continue;
    if (!validPackageName(pkg)) continue;
    if (envActions.some((x) => x.package === pkg && x.manager === manager)) continue;
    envActions.push({
      kind: "install_package",
      manager,
      package: pkg,
      why: str(r.why),
      available: r.available === true,
      command: str(r.command) || (manager === "miktex" ? `miktex packages install ${pkg}` : `tlmgr install ${pkg}`),
    });
  }
  const rawSteps = field(o, "steps");
  const rawNotes = field(o, "notes");
  return {
    notes: (Array.isArray(rawNotes) ? rawNotes : []).map(str).filter(Boolean),
    model: str(field(o, "model")),
    summary: str(field(o, "summary")).trim(),
    cause: str(field(o, "cause")).trim(),
    steps: (Array.isArray(rawSteps) ? rawSteps : []).map(str).map((s) => s.trim()).filter(Boolean),
    edits,
    rejected,
    envActions,
    confidence: confidenceOf(field(o, "confidence")),
  };
}

// ---------------------------------------------------------------------------
// Errors

export type AiErrorKind =
  | "noKey"
  | "disabled"
  /** The backend wants the privacy notice accepted for this provider first. */
  | "noticeRequired"
  /** The account is out of credits. */
  | "payment"
  | "badKey"
  | "forbidden"
  | "modelNotFound"
  | "rateLimited"
  | "server"
  | "offline"
  | "timeout"
  | "tls"
  | "refused"
  | "badAnswer"
  | "cancelled"
  | "other";

export interface AiError {
  kind: AiErrorKind;
  /** Plain words for the panel. */
  message: string;
  /** Seconds to wait, for rate limits. */
  retryAfter?: number;
}

const KIND_ALIASES: Record<string, AiErrorKind> = {
  nokey: "noKey",
  missingkey: "noKey",
  disabled: "disabled",
  aidisabled: "disabled",
  noticerequired: "noticeRequired",
  payment: "payment",
  paymentrequired: "payment",
  unauthorized: "badKey",
  badkey: "badKey",
  invalidkey: "badKey",
  auth: "badKey",
  forbidden: "forbidden",
  modelnotfound: "modelNotFound",
  notfound: "modelNotFound",
  ratelimited: "rateLimited",
  ratelimit: "rateLimited",
  toomanyrequests: "rateLimited",
  server: "server",
  servererror: "server",
  unavailable: "server",
  offline: "offline",
  network: "offline",
  truncated: "badAnswer",
  toolarge: "other",
  badrequest: "other",
  invalidinput: "other",
  keystore: "other",
  timeout: "timeout",
  timedout: "timeout",
  tls: "tls",
  certificate: "tls",
  refused: "refused",
  refusal: "refused",
  badanswer: "badAnswer",
  badresponse: "badAnswer",
  invalidresponse: "badAnswer",
  parse: "badAnswer",
  cancelled: "cancelled",
  canceled: "cancelled",
};

/** Guesses the kind from the words of a plain-string error. */
function kindFromText(text: string): AiErrorKind {
  const t = text.toLowerCase();
  if (/\bcancel+ed\b/.test(t)) return "cancelled";
  if (/no (api )?key|key (is )?(not set|missing)|add (an|a|your) (api )?key/.test(t)) return "noKey";
  if (/ai (is )?(turned )?off|ai (is )?disabled/.test(t)) return "disabled";
  if (/\b401\b|unauthori[sz]ed|invalid (api )?key|bad (api )?key|key (was )?(rejected|not accepted)/.test(t)) return "badKey";
  if (/\b403\b|forbidden|not allowed|permission/.test(t)) return "forbidden";
  if (/\b404\b|model.*(not found|doesn.t exist|unknown)|unknown model/.test(t)) return "modelNotFound";
  if (/\b429\b|rate.?limit|too many requests|quota/.test(t)) return "rateLimited";
  if (/\b5\d\d\b|server error|overloaded|unavailable|bad gateway/.test(t)) return "server";
  if (/tls|certificate|ssl/.test(t)) return "tls";
  if (/timed? ?out|timeout/.test(t)) return "timeout";
  if (/offline|network|connect|dns|resolve|unreachable|no internet/.test(t)) return "offline";
  if (/refus|declined/.test(t)) return "refused";
  if (/json|parse|unexpected (answer|response)|couldn.t read the (answer|response)/.test(t)) return "badAnswer";
  return "other";
}

const DEFAULT_MESSAGES: Record<AiErrorKind, string> = {
  noKey: "Add an API key in Settings > AI to use the AI helper.",
  disabled: "The AI helper is turned off. You can turn it on in Settings > AI.",
  noticeRequired: "Please read the privacy notice first.",
  payment: "Your account with this AI provider is out of credits. Add credits, or pick a free provider in Settings > AI.",
  badKey: "The AI provider didn't accept your API key. Check it in Settings > AI, or paste a new one.",
  forbidden: "Your API key isn't allowed to use this model. Pick another model in Settings > AI.",
  modelNotFound: "The chosen model isn't available from this provider any more. Pick another model in Settings > AI.",
  rateLimited: "The AI provider says you've sent too many requests. Wait a little and try again.",
  server: "The AI provider is having trouble right now. Try again in a minute.",
  offline: "Texo couldn't reach the AI provider. Check your internet connection and try again.",
  timeout: "The AI provider took too long to answer. Try again.",
  tls: "Texo couldn't open a secure connection to the AI provider. A proxy or firewall may be in the way.",
  refused: "The AI declined to help with this one. The plain explanation above still applies.",
  badAnswer: "The AI's answer couldn't be read. Try again, or pick another model.",
  cancelled: "Stopped.",
  other: "The AI helper ran into a problem.",
};

/** Turns whatever the backend threw into a kind and plain words. Never shows a key: the backend never sends one. */
export function toAiError(err: unknown): AiError {
  if (err && typeof err === "object" && !(err instanceof Error)) {
    const o = err as Record<string, unknown>;
    const rawKind = str(o.kind ?? o.code ?? o.type).replace(/[^a-z]/gi, "").toLowerCase();
    const message = str(o.message ?? o.error);
    const kind = KIND_ALIASES[rawKind] ?? (message ? kindFromText(message) : "other");
    const retry = Number(o.retryAfterSecs ?? o.retryAfter ?? o.retry_after_secs ?? o.retry_after);
    return {
      kind,
      message: message || DEFAULT_MESSAGES[kind],
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: Math.ceil(retry) } : {}),
    };
  }
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  const kind = text ? kindFromText(text) : "other";
  const retry = /retry[- ]after[^0-9]*(\d+)|(?:in|after) (\d+) ?s(?:ec|econds?)?\b/i.exec(text);
  return {
    kind,
    message: text || DEFAULT_MESSAGES[kind],
    ...(retry ? { retryAfter: Number(retry[1] ?? retry[2]) } : {}),
  };
}

export function defaultAiMessage(kind: AiErrorKind): string {
  return DEFAULT_MESSAGES[kind];
}

/** Errors whose fix is in Settings > AI. */
export function needsSettings(kind: AiErrorKind): boolean {
  return kind === "noKey" || kind === "disabled" || kind === "badKey" || kind === "forbidden" || kind === "modelNotFound" || kind === "payment";
}

/** Errors worth simply trying again. */
export function retryable(kind: AiErrorKind): boolean {
  return kind === "rateLimited" || kind === "server" || kind === "offline" || kind === "timeout" || kind === "badAnswer" || kind === "other";
}

// ---------------------------------------------------------------------------
// Rounds

export const MAX_ROUNDS = 3;

/** What one round did, sent along with the next request so the AI doesn't repeat itself. */
export interface Attempt {
  round: number;
  summary: string;
  /** Edits that were applied. */
  applied: ProposedEdit[];
  /** The first errors after recompiling. */
  errorsAfter: string[];
}

/** A short, comparable picture of a compile's errors. */
export function errorFingerprint(result: CompileResult | null): string[] {
  if (!result) return [];
  return result.issues
    .filter((i) => i.severity === "error")
    .map((i) => `${i.file ?? ""}:${i.line ?? ""}:${i.message}`)
    .slice(0, 20);
}

export type RoundOutcome =
  /** Compiles without errors now. */
  | "fixed"
  /** Errors remain, but they changed or got fewer. */
  | "progress"
  /** The same errors as before. */
  | "noProgress";

export function judgeRound(before: CompileResult | null, after: CompileResult): RoundOutcome {
  const errorsAfter = errorFingerprint(after);
  if (after.status === "success" && errorsAfter.length === 0) return "fixed";
  if (errorsAfter.length === 0 && after.pdfPath) return "fixed";
  const errorsBefore = errorFingerprint(before);
  if (errorsAfter.length < errorsBefore.length) return "progress";
  if (errorsAfter.length === errorsBefore.length && errorsAfter.every((e, i) => e === errorsBefore[i])) {
    // The same errors; a run that failed without listing any counts as no change too.
    return "noProgress";
  }
  return errorsAfter.join("\n") === errorsBefore.join("\n") ? "noProgress" : "progress";
}

/** Which problem the fixer is asked about: one issue, or the whole compile. */
export type FixScope = { kind: "issue"; issue: Issue } | { kind: "all" };

export type EditDecision = "accepted" | "rejected";

export type FixPhase =
  | { kind: "idle" }
  /** The one-time privacy notice is showing. */
  | { kind: "notice" }
  | { kind: "asking" }
  | { kind: "proposal"; proposal: FixProposal; decisions: EditDecision[]; problems: (string | null)[] }
  | { kind: "applying" }
  | { kind: "recompiling" }
  | { kind: "outcome"; outcome: RoundOutcome; applied: number; summary: string }
  | { kind: "error"; error: AiError };

export interface FixState {
  open: boolean;
  scope: FixScope;
  round: number;
  phase: FixPhase;
  attempts: Attempt[];
  /** The compile result the current round was asked about. */
  before: CompileResult | null;
}

export type FixEvent =
  | { type: "open"; scope: FixScope; result: CompileResult | null; noticeNeeded: boolean }
  | { type: "noticeAccepted" }
  | { type: "ask" }
  | { type: "answer"; proposal: FixProposal; problems: (string | null)[] }
  | { type: "failed"; error: AiError }
  | { type: "cancelled" }
  | { type: "toggle"; index: number }
  | { type: "setAll"; decision: EditDecision }
  /** Edits that no longer apply, found when Apply was pressed. */
  | { type: "stale"; problems: (string | null)[] }
  | { type: "applying" }
  | { type: "recompiling"; applied: ProposedEdit[]; summary: string }
  | { type: "compiled"; result: CompileResult }
  | { type: "retry" }
  | { type: "close" };

export const initialFixState: FixState = {
  open: false,
  scope: { kind: "all" },
  round: 0,
  phase: { kind: "idle" },
  attempts: [],
  before: null,
};

/** Whether "Try again" is offered after this outcome. */
export function canRetry(state: FixState): boolean {
  if (state.round >= MAX_ROUNDS) return false;
  const p = state.phase;
  if (p.kind === "outcome") return p.outcome === "progress";
  if (p.kind === "error") return retryable(p.error.kind) || p.error.kind === "cancelled";
  return false;
}

export function fixReducer(state: FixState, event: FixEvent): FixState {
  const p = state.phase;
  switch (event.type) {
    case "open":
      return {
        open: true,
        scope: event.scope,
        round: 0,
        attempts: [],
        before: event.result,
        phase: event.noticeNeeded ? { kind: "notice" } : { kind: "idle" },
      };
    case "noticeAccepted":
      return p.kind === "notice" ? { ...state, phase: { kind: "idle" } } : state;
    case "ask":
      if (p.kind === "asking" || p.kind === "applying" || p.kind === "recompiling" || p.kind === "notice") return state;
      if (state.round >= MAX_ROUNDS) return state;
      return { ...state, round: state.round + 1, phase: { kind: "asking" } };
    case "answer": {
      if (p.kind !== "asking") return state;
      const decisions = event.proposal.edits.map((_, i): EditDecision => (event.problems[i] ? "rejected" : "accepted"));
      return { ...state, phase: { kind: "proposal", proposal: event.proposal, decisions, problems: event.problems } };
    }
    case "failed":
      if (p.kind !== "asking" && p.kind !== "applying" && p.kind !== "recompiling") return state;
      // A request that got no answer doesn't use up a round.
      return {
        ...state,
        round: p.kind === "asking" ? state.round - 1 : state.round,
        // The backend wants the privacy notice accepted first: show it.
        phase: event.error.kind === "noticeRequired" ? { kind: "notice" } : { kind: "error", error: event.error },
      };
    case "cancelled":
      if (p.kind !== "asking") return state;
      return { ...state, round: state.round - 1, phase: { kind: "error", error: { kind: "cancelled", message: defaultAiMessage("cancelled") } } };
    case "toggle": {
      if (p.kind !== "proposal" || p.problems[event.index]) return state;
      const decisions = p.decisions.slice();
      decisions[event.index] = decisions[event.index] === "accepted" ? "rejected" : "accepted";
      return { ...state, phase: { ...p, decisions } };
    }
    case "setAll": {
      if (p.kind !== "proposal") return state;
      const decisions = p.decisions.map((_, i): EditDecision => (p.problems[i] ? "rejected" : event.decision));
      return { ...state, phase: { ...p, decisions } };
    }
    case "stale": {
      if (p.kind !== "proposal") return state;
      const problems = p.problems.map((x, i) => x ?? event.problems[i] ?? null);
      const decisions = p.decisions.map((d, i): EditDecision => (problems[i] ? "rejected" : d));
      return { ...state, phase: { ...p, problems, decisions } };
    }
    case "applying":
      return p.kind === "proposal" ? { ...state, phase: { kind: "applying" } } : state;
    case "recompiling": {
      if (p.kind !== "applying") return state;
      return {
        ...state,
        phase: { kind: "recompiling" },
        attempts: [...state.attempts, { round: state.round, summary: event.summary, applied: event.applied, errorsAfter: [] }],
      };
    }
    case "compiled": {
      if (p.kind !== "recompiling") return state;
      const attempts = state.attempts.slice();
      const last = attempts[attempts.length - 1];
      const outcome = judgeRound(state.before, event.result);
      if (last) attempts[attempts.length - 1] = { ...last, errorsAfter: errorFingerprint(event.result).slice(0, 5) };
      return {
        ...state,
        attempts,
        before: event.result,
        phase: { kind: "outcome", outcome, applied: last?.applied.length ?? 0, summary: last?.summary ?? "" },
      };
    }
    case "retry":
      if (!canRetry(state)) return state;
      return { ...state, phase: { kind: "idle" } };
    case "close":
      return { ...initialFixState };
  }
}

/** The accepted edits of a proposal phase. */
export function acceptedEdits(phase: FixPhase): ProposedEdit[] {
  if (phase.kind !== "proposal") return [];
  return phase.proposal.edits.filter((_, i) => phase.decisions[i] === "accepted" && !phase.problems[i]);
}

/** The parts of a compile the backend needs (not the PDF path or the console output). */
export function compileInput(result: CompileResult): AiCompileInput {
  return {
    status: result.status,
    engine: result.engine,
    issues: result.issues.map(({ severity, message, file, line, context }) => ({ severity, message, file, line, context })),
    hints: result.hints,
    log: result.log,
  };
}

/** Earlier rounds, as the backend wants them. */
export function previousAttempts(attempts: Attempt[]): AiPreviousAttempt[] {
  return attempts.map((a) => ({ summary: a.summary, edits: a.applied, applied: a.applied.length > 0, remainingErrors: a.errorsAfter }));
}
