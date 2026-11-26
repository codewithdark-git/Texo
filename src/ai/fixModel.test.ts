import { describe, expect, it } from "vitest";
import type { CompileResult, Issue } from "../lib/api";
import {
  acceptedEdits,
  canRetry,
  compileInput,
  previousAttempts,
  fixReducer,
  initialFixState,
  judgeRound,
  MAX_ROUNDS,
  needsSettings,
  normalizeProposal,
  toAiError,
  type FixState,
} from "./fixModel";

const issue = (message: string, line = 1): Issue => ({ severity: "error", message, file: "main.tex", line, context: null });

const result = (status: CompileResult["status"], issues: Issue[], pdf = status === "success"): CompileResult => ({
  status,
  compiler: "latexmk",
  engine: "pdflatex",
  pdfPath: pdf ? "/x/main.pdf" : null,
  durationMs: 1,
  issues,
  hints: [],
  log: "",
  output: "",
  rcIgnored: false,
  savedPdf: null,
});

describe("normalizeProposal", () => {
  it("keeps good edits and actions and refuses bad ones", () => {
    const p = normalizeProposal({
      summary: " A brace is missing. ",
      cause: "Line 4 opens { but never closes it.",
      steps: ["Add the closing brace.", "", 3],
      edits: [
        { file: "main.tex", find: "\\textbf{x", replace: "\\textbf{x}", why: "close it" },
        { file: "../evil.tex", find: "a", replace: "b", why: "" },
        { file: "figure.png", find: "a", replace: "b", why: "" },
        { file: "main.tex", find: "", replace: "b", why: "" },
        "junk",
      ],
      env_actions: [
        { kind: "install_package", manager: "miktex", package: "cm-super", why: "fonts" },
        { kind: "install_package", manager: "miktex", package: "cm-super", why: "again" },
        { kind: "install_package", manager: "apt", package: "x", why: "" },
        { kind: "install_package", manager: "texlive", package: "bad name;", why: "" },
        { kind: "run_shell", manager: "miktex", package: "x", why: "" },
      ],
      confidence: 0.8,
    });
    expect(p.summary).toBe("A brace is missing.");
    expect(p.steps).toEqual(["Add the closing brace.", "3"]);
    expect(p.edits).toEqual([{ file: "main.tex", find: "\\textbf{x", replace: "\\textbf{x}", why: "close it" }]);
    expect(p.rejected).toHaveLength(3);
    expect(p.envActions).toEqual([
      { kind: "install_package", manager: "miktex", package: "cm-super", why: "fonts", available: false, command: "miktex packages install cm-super" },
    ]);
    expect(p.confidence).toBe("high");
  });

  it("keeps edits the backend refused apart, with its reason", () => {
    const p = normalizeProposal({
      summary: "s",
      edits: [
        { file: "main.tex", find: "a", replace: "b", why: "", ok: true, line: 3 },
        { file: "main.tex", find: "x", replace: "y", why: "", ok: false, reason: "Not in the file." },
      ],
    });
    expect(p.edits).toHaveLength(1);
    expect(p.rejected).toEqual([{ edit: { file: "main.tex", find: "x", replace: "y", why: "" }, reason: "Not in the file." }]);
  });

  it("copes with camelCase keys, word confidences and junk", () => {
    expect(normalizeProposal({ envActions: [{ kind: "install_package", manager: "TeXLive", package: "x", why: "" }], confidence: "Low" })).toMatchObject({
      envActions: [{ manager: "texlive", package: "x" }],
      confidence: "low",
    });
    expect(normalizeProposal(null)).toMatchObject({ summary: "", edits: [], steps: [], confidence: null });
  });
});

describe("toAiError", () => {
  it("reads structured errors", () => {
    expect(toAiError({ kind: "rate_limited", message: "Slow down.", retryAfter: 12.2 })).toEqual({ kind: "rateLimited", message: "Slow down.", retryAfter: 13 });
    expect(toAiError({ kind: "unauthorized" }).kind).toBe("badKey");
    // The backend's own shape.
    expect(toAiError({ kind: "notFound", message: "No such model.", retryAfterSecs: null })).toEqual({ kind: "modelNotFound", message: "No such model." });
    expect(toAiError({ kind: "rateLimited", message: "Wait.", retryAfterSecs: 7 }).retryAfter).toBe(7);
    expect(toAiError({ kind: "noticeRequired", message: "x" }).kind).toBe("noticeRequired");
    expect(toAiError({ kind: "truncated", message: "x" }).kind).toBe("badAnswer");
    expect(toAiError({ code: "no_key" }).message).toMatch(/Settings > AI/);
  });

  it("guesses from plain strings", () => {
    expect(toAiError("401 Unauthorized").kind).toBe("badKey");
    expect(toAiError("Rate limited (429). Retry after 30 seconds.")).toMatchObject({ kind: "rateLimited", retryAfter: 30 });
    expect(toAiError("Server error 503").kind).toBe("server");
    expect(toAiError("Model not found: foo").kind).toBe("modelNotFound");
    expect(toAiError("Could not connect: dns error").kind).toBe("offline");
    expect(toAiError("The request timed out").kind).toBe("timeout");
    expect(toAiError("Cancelled").kind).toBe("cancelled");
    expect(toAiError("No API key set for NVIDIA").kind).toBe("noKey");
    expect(toAiError("The model refused to answer").kind).toBe("refused");
    expect(toAiError(new Error("weird")).kind).toBe("other");
    expect(toAiError(undefined).message).toBeTruthy();
  });

  it("knows which errors are fixed in Settings", () => {
    expect(needsSettings("badKey")).toBe(true);
    expect(needsSettings("server")).toBe(false);
  });
});

describe("judgeRound", () => {
  const before = result("failed", [issue("Missing }"), issue("Undefined control sequence", 9)]);
  it("sees fixed, progress and no progress", () => {
    expect(judgeRound(before, result("success", []))).toBe("fixed");
    expect(judgeRound(before, result("failed", [issue("Undefined control sequence", 9)]))).toBe("progress");
    expect(judgeRound(before, result("failed", [issue("Something else", 3), issue("And this", 4)]))).toBe("progress");
    expect(judgeRound(before, result("failed", [issue("Missing }"), issue("Undefined control sequence", 9)]))).toBe("noProgress");
    expect(judgeRound(result("failed", []), result("failed", []))).toBe("noProgress");
  });
});

describe("fixReducer", () => {
  const before = result("failed", [issue("Missing }")]);
  const proposal = normalizeProposal({
    summary: "s",
    edits: [
      { file: "main.tex", find: "a", replace: "b", why: "" },
      { file: "main.tex", find: "c", replace: "d", why: "" },
    ],
  });
  const run = (...events: Parameters<typeof fixReducer>[1][]) => events.reduce(fixReducer, initialFixState);

  it("shows the notice once before anything is sent", () => {
    let s = run({ type: "open", scope: { kind: "all" }, result: before, noticeNeeded: true });
    expect(s.phase.kind).toBe("notice");
    expect(fixReducer(s, { type: "ask" }).phase.kind).toBe("notice");
    s = fixReducer(s, { type: "noticeAccepted" });
    expect(s.phase.kind).toBe("idle");
    expect(fixReducer(s, { type: "ask" })).toMatchObject({ round: 1, phase: { kind: "asking" } });
  });

  it("walks a round from asking to outcome", () => {
    let s = run(
      { type: "open", scope: { kind: "all" }, result: before, noticeNeeded: false },
      { type: "ask" },
      { type: "answer", proposal, problems: [null, "gone"] },
    );
    expect(s.phase).toMatchObject({ kind: "proposal", decisions: ["accepted", "rejected"] });
    // An edit that can't apply can't be accepted.
    expect(fixReducer(s, { type: "toggle", index: 1 })).toBe(s);
    s = fixReducer(s, { type: "toggle", index: 0 });
    expect(acceptedEdits(s.phase)).toEqual([]);
    s = fixReducer(s, { type: "setAll", decision: "accepted" });
    expect(acceptedEdits(s.phase)).toHaveLength(1);
    s = fixReducer(s, { type: "applying" });
    s = fixReducer(s, { type: "recompiling", applied: [proposal.edits[0]], summary: "s" });
    s = fixReducer(s, { type: "compiled", result: result("failed", [issue("Other", 5)]) });
    expect(s.phase).toMatchObject({ kind: "outcome", outcome: "progress", applied: 1, summary: "s" });
    expect(s.attempts).toEqual([{ round: 1, summary: "s", applied: [proposal.edits[0]], errorsAfter: ["main.tex:5:Other"] }]);
    expect(canRetry(s)).toBe(true);
    s = fixReducer(s, { type: "retry" });
    expect(fixReducer(s, { type: "ask" }).round).toBe(2);
  });

  it("marks edits that went stale at apply time", () => {
    let s = run(
      { type: "open", scope: { kind: "all" }, result: before, noticeNeeded: false },
      { type: "ask" },
      { type: "answer", proposal, problems: [null, null] },
    );
    s = fixReducer(s, { type: "stale", problems: ["changed", null] });
    expect(s.phase).toMatchObject({ kind: "proposal", decisions: ["rejected", "accepted"], problems: ["changed", null] });
  });

  it("stops after no progress or the last round", () => {
    const outcome = (outcome: "progress" | "noProgress", round: number): FixState => ({
      ...initialFixState,
      open: true,
      round,
      phase: { kind: "outcome", outcome, applied: 1, summary: "" },
    });
    expect(canRetry(outcome("noProgress", 1))).toBe(false);
    expect(canRetry(outcome("progress", MAX_ROUNDS))).toBe(false);
    expect(fixReducer({ ...outcome("progress", MAX_ROUNDS), phase: { kind: "idle" } }, { type: "ask" }).phase.kind).toBe("idle");
  });

  it("handles cancel and failures only while waiting", () => {
    let s = run({ type: "open", scope: { kind: "all" }, result: before, noticeNeeded: false }, { type: "ask" });
    s = fixReducer(s, { type: "cancelled" });
    expect(s).toMatchObject({ round: 0, phase: { kind: "error", error: { kind: "cancelled" } } });
    expect(canRetry(s)).toBe(true);
    expect(
      fixReducer(run({ type: "open", scope: { kind: "all" }, result: before, noticeNeeded: false }, { type: "ask" }), {
        type: "failed",
        error: { kind: "noticeRequired", message: "" },
      }).phase.kind,
    ).toBe("notice");
    // A late answer after cancelling is ignored.
    expect(fixReducer(s, { type: "answer", proposal, problems: [] })).toBe(s);
    expect(fixReducer(s, { type: "close" })).toEqual(initialFixState);
  });
});

describe("request shaping", () => {
  it("sends only what the backend needs", () => {
    const r = { ...result("failed", [issue("Missing }")]), output: "console", pdfPath: "/secret/path.pdf" };
    const input = compileInput(r);
    expect(input).toEqual({
      status: "failed",
      engine: "pdflatex",
      issues: [{ severity: "error", message: "Missing }", file: "main.tex", line: 1, context: null }],
      hints: [],
      log: "",
    });
    expect(JSON.stringify(input)).not.toContain("secret");
  });

  it("maps earlier rounds", () => {
    const edit = { file: "main.tex", find: "a", replace: "b", why: "w" };
    expect(previousAttempts([{ round: 1, summary: "s", applied: [edit], errorsAfter: ["e"] }])).toEqual([
      { summary: "s", edits: [edit], applied: true, remainingErrors: ["e"] },
    ]);
  });
});
