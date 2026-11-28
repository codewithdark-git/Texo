import { describe, expect, it } from "vitest";
import { acceptAll, isActive, runStatusText, type Changeset, type ChangesetFile } from "./agentsApi";

const file = (name: string, state: ChangesetFile["state"]): ChangesetFile => ({
  file: name,
  baseText: "a",
  newText: "b",
  status: "modified",
  conflict: state === "conflict",
  changedOnDisk: false,
  baseHash: "",
  reason: "",
  state,
  hunks: [],
});

describe("agentsApi helpers", () => {
  it("tells active runs apart", () => {
    expect(isActive("queued")).toBe(true);
    expect(isActive("awaiting_input")).toBe(true);
    expect(isActive("awaiting_review")).toBe(false);
    expect(isActive("interrupted")).toBe(false);
  });

  it("describes run states in plain words", () => {
    expect(runStatusText({ status: "awaiting_review", pendingFiles: 2, conflictFiles: 0 })).toBe("2 file(s) to review");
    expect(runStatusText({ status: "awaiting_review", pendingFiles: 0, conflictFiles: 1 })).toContain("manual pick");
    expect(runStatusText({ status: "interrupted", pendingFiles: 0, conflictFiles: 0 })).toContain("Texo closed");
  });

  it("accepts only undecided files", () => {
    const cs: Changeset = { runId: "r", files: [file("a.tex", "pending"), file("b.tex", "applied"), file("c.tex", "conflict")] };
    expect(acceptAll(cs)).toEqual([
      { file: "a.tex", accept: true },
      { file: "c.tex", accept: true },
    ]);
  });
});

describe("kind reports, plans and profiles", () => {
  it("recognises reports and the rebuttal plan payload", async () => {
    const { isFixReport, isTaskReport, isRebuttalReport, isRebuttalPlan } = await import("./agentsApi");
    expect(isFixReport({ kind: "fix" })).toBe(true);
    expect(isTaskReport({ kind: "task" })).toBe(true);
    expect(isRebuttalReport({ kind: "review" })).toBe(false);
    expect(isRebuttalReport(null)).toBe(false);
    expect(isRebuttalPlan({ type: "rebuttalPlan", concerns: [], message: "" })).toBe(true);
    expect(isRebuttalPlan({ type: "rebuttalPlan" })).toBe(false);
    expect(isRebuttalPlan(null)).toBe(false);
  });

  it("builds plan answers", async () => {
    const { approvePlan } = await import("./agentsApi");
    expect(approvePlan()).toEqual({ approved: true });
    expect(approvePlan([], "  ")).toEqual({ approved: true, concerns: [] });
    const c = { id: "R1", reviewer: "R", quote: "q", summary: "s", action: "change" as const, plan: "p" };
    expect(approvePlan([c], " Be brief ")).toEqual({ approved: true, concerns: [c], note: "Be brief" });
  });

  it("makes new, duplicated and profile-based requests", async () => {
    const { newProfile, duplicateProfile, profileRequest, taskStatusText, utf8Bytes } = await import("./agentsApi");
    const p = newProfile("reviewer", "Strict statistician");
    expect(p.id).toBe("");
    expect(p.tools).toEqual([]);
    const d = duplicateProfile({ ...p, id: "strict", source: "builtin", overridesBuiltin: true });
    expect(d).toMatchObject({ id: "", name: "Strict statistician (copy)", source: "global", overridesBuiltin: false });
    expect(profileRequest({ id: "strict", kind: "reviewer" }, "Review", { dirtyBuffers: [] })).toEqual({
      dirtyBuffers: [],
      kind: "reviewer",
      profileId: "strict",
      prompt: "Review",
    });
    expect(taskStatusText("notDone")).toBe("Not done");
    expect(utf8Bytes("a\r\nb")).toBe(3);
    expect(utf8Bytes("▸")).toBe(3);
  });
});

describe("run progress", () => {
  const progress = {
    phases: [
      { id: "read", label: "Read the errors", status: "done", startedAt: 1, finishedAt: 2, detail: "3 errors" },
      { id: "round1", label: "Fix round 1 of 3", status: "active", startedAt: 2, detail: "3 errors left" },
      { id: "work", label: "Work", status: "pending", done: 0, total: 2 },
    ],
    plan: [
      { n: 1, task: "Add a greeting", status: "done", note: "Added" },
      { n: 2, task: "Fix the typo", status: "notDone" },
    ],
    activity: {
      tool: "search_papers",
      label: 'Searching papers: "diffusion"',
      startedAt: 3,
      sources: [{ source: "arXiv", state: "ok", detail: "4" }],
    },
    counts: { papersFound: 4 },
  };

  it("recognises well-formed progress", async () => {
    const { isRunProgress } = await import("./agentsApi");
    expect(isRunProgress(progress)).toBe(true);
    expect(isRunProgress({ ...progress, activity: null })).toBe(true);
    expect(isRunProgress({ phases: [], plan: [], activity: null, counts: {} })).toBe(true);
  });

  it("refuses malformed progress", async () => {
    const { isRunProgress } = await import("./agentsApi");
    expect(isRunProgress(null)).toBe(false);
    expect(isRunProgress([])).toBe(false);
    expect(isRunProgress({ phases: [], plan: [], counts: {} })).toBe(true);
    expect(isRunProgress({ plan: [], activity: null, counts: {} })).toBe(false);
    expect(isRunProgress({ ...progress, phases: [{ id: "x", label: "X", status: "running" }] })).toBe(false);
    expect(isRunProgress({ ...progress, plan: [{ n: "1", task: "A", status: "done" }] })).toBe(false);
    expect(isRunProgress({ ...progress, plan: [{ n: 1, task: "A", status: "not done" }] })).toBe(false);
    expect(isRunProgress({ ...progress, activity: { tool: "x", label: "y" } })).toBe(false);
    expect(isRunProgress({ ...progress, counts: { papersFound: "4" } })).toBe(false);
  });

  it("gives runs from Texo 1.2 an empty progress", async () => {
    const { runProgress, EMPTY_PROGRESS } = await import("./agentsApi");
    expect(runProgress({})).toEqual(EMPTY_PROGRESS);
    expect(runProgress({ progress: { phases: "x" } })).toEqual(EMPTY_PROGRESS);
    expect(runProgress({ progress: { phases: [], plan: [], counts: {} } }).activity).toBeNull();
    expect(runProgress({ progress }).plan).toHaveLength(2);
  });
});
