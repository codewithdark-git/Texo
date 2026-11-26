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
