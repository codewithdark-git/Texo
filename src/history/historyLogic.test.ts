import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../lib/historyApi";
import {
  agentName,
  baseName,
  canUndoRun,
  dayKey,
  dayLabel,
  entrySteps,
  entryTitle,
  groupTimeline,
  modelFromAuthor,
  restoreSummary,
  undoOutcome,
  type RunGroup,
} from "./historyLogic";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime() / 1000;

function entry(id: string, time: number, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    shortId: id.slice(0, 7),
    time,
    summary: "Your edits",
    reason: "idle",
    author: "you",
    authorName: "You",
    runId: null,
    step: null,
    agent: null,
    model: null,
    kind: null,
    undoOf: null,
    parentId: null,
    labels: [],
    note: null,
    ...extra,
  };
}

const ai = (id: string, time: number, runId: string, step: number | null = null) =>
  entry(id, time, {
    author: "ai",
    authorName: "Texo AI · Fix compile errors (nvidia/nemotron)",
    runId,
    step,
    model: "nvidia/nemotron",
    reason: "agent-apply",
    summary: "Fixed the missing brace",
  });

describe("days", () => {
  const now = new Date(2026, 10, 25, 15);

  it("labels today and yesterday", () => {
    expect(dayLabel(at(2026, 11, 25, 9), now)).toBe("Today");
    expect(dayLabel(at(2026, 11, 24, 23), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 11, 20), now)).not.toMatch(/Today|Yesterday/);
  });

  it("keys by local day", () => {
    expect(dayKey(at(2026, 1, 5, 0))).toBe("2026-01-05");
    expect(dayKey(at(2026, 1, 5, 23))).toBe("2026-01-05");
  });
});

describe("groupTimeline", () => {
  const now = new Date(2026, 10, 25, 15);

  it("splits by day and folds one AI run's commits together", () => {
    const list = [
      entry("a1", at(2026, 11, 25, 14)),
      ai("b1", at(2026, 11, 25, 13), "run-1", 3),
      ai("b2", at(2026, 11, 25, 12), "run-1", 5),
      entry("c1", at(2026, 11, 25, 11), { reason: "before-run", summary: "Before an AI run" }),
      entry("d1", at(2026, 11, 24, 10)),
    ];
    const days = groupTimeline(list, now);
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday"]);
    expect(days[0].items.map((i) => i.type)).toEqual(["entry", "run", "entry"]);
    const run = days[0].items[1] as RunGroup;
    expect(run.entries.map((e) => e.id)).toEqual(["b1", "b2"]);
    expect(run.agent).toBe("Fix compile errors");
    expect(run.steps).toBe(5);
  });

  it("keeps two runs apart even when adjacent", () => {
    const days = groupTimeline([ai("x", at(2026, 11, 25, 10), "r1"), ai("y", at(2026, 11, 25, 9), "r2")], now);
    expect(days[0].items).toHaveLength(2);
  });

  it("handles an empty history", () => {
    expect(groupTimeline([], now)).toEqual([]);
  });
});

describe("words", () => {
  it("reads the agent from the author name", () => {
    expect(agentName({ agent: null, authorName: "Texo AI · Reviewer (claude-opus-5-5)" })).toBe("Reviewer");
    expect(agentName({ agent: null, authorName: "Texo AI · Task agent" })).toBe("Task agent");
    expect(agentName({ agent: "Fixer", authorName: "whatever" })).toBe("Fixer");
  });

  it("titles a version", () => {
    expect(entryTitle({ reason: "idle", summary: "Edited main.tex\nmore", undoOf: null })).toBe("Edited main.tex");
    expect(entryTitle({ reason: "before-compile", summary: "", undoOf: null })).toBe("Before compiling");
    expect(entryTitle({ reason: null, summary: "", undoOf: "r1" })).toBe("Undid an AI run");
  });

  it("knows when a run was already undone", () => {
    const group: RunGroup = { type: "run", runId: "r1", agent: "x", model: null, entries: [], steps: null };
    expect(canUndoRun(group, [entry("a", 1)])).toBe(true);
    expect(canUndoRun(group, [entry("a", 1, { undoOf: "r1" })])).toBe(false);
  });

  it("summarises a restore", () => {
    expect(restoreSummary({ commit: null, written: [], deleted: [], failed: [] })).toMatch(/already match/);
    expect(restoreSummary({ commit: "c", written: ["a.tex"], deleted: ["b.tex", "c.tex"], failed: [] })).toBe(
      "1 file restored, 2 files removed (still in history).",
    );
    expect(restoreSummary({ commit: "c", written: ["a.tex"], deleted: [], failed: ["x.tex"] })).toMatch(/couldn't be written.*x\.tex/);
  });
});

describe("steps and model", () => {
  const now = new Date(2026, 10, 25, 15);

  it("takes steps from the trailer, else from the note's tool calls", () => {
    expect(entrySteps({ step: 4, note: { toolCalls: ["a"] } })).toBe(4);
    expect(entrySteps({ step: null, note: { toolCalls: ["read_file a", "edit_file a", "compile"] } })).toBe(3);
    expect(entrySteps({ step: null, note: { steps: 7 } })).toBe(7);
    expect(entrySteps({ step: null, note: null })).toBeNull();
    expect(entrySteps({ step: null, note: { toolCalls: [] } })).toBeNull();
  });

  it("counts a run's steps from notes when commits have no step trailer", () => {
    const a = ai("a", at(2026, 11, 25, 10), "r1");
    a.note = { toolCalls: ["x", "y"] };
    const b = ai("b", at(2026, 11, 25, 9), "r1");
    b.note = { toolCalls: ["x", "y", "z", "w"] };
    const run = groupTimeline([a, b], now)[0].items[0] as RunGroup;
    expect(run.steps).toBe(4);
  });

  it("reads the model from the author name when there is no trailer", () => {
    expect(modelFromAuthor("Texo AI · Reviewer (claude-opus-5-5)")).toBe("claude-opus-5-5");
    expect(modelFromAuthor("Texo AI · Task agent")).toBeNull();
    expect(modelFromAuthor("You")).toBeNull();
    const e = ai("a", at(2026, 11, 25, 10), "r1");
    e.model = null;
    const run = groupTimeline([e], now)[0].items[0] as RunGroup;
    expect(run.model).toBe("nvidia/nemotron");
  });
});

describe("undoOutcome", () => {
  it("is a success when everything was undone", () => {
    const o = undoOutcome({ commit: "c", written: ["a.tex"], deleted: [], conflicts: [], failed: [] });
    expect(o.tone).toBe("success");
    expect(o.text).toBe("Undid the AI run (1 file restored).");
  });

  it("calls out conflicts and failures", () => {
    const o = undoOutcome({ commit: "c", written: ["a.tex"], deleted: [], conflicts: ["b.tex", "c.tex"], failed: ["d.tex"] });
    expect(o.tone).toBe("partial");
    expect(o.text).toMatch(/2 of its files afterwards, so they were left as they are/);
    expect(o.text).toMatch(/1 file couldn't be written/);
    expect(o.conflicts).toEqual(["b.tex", "c.tex"]);
    expect(o.failed).toEqual(["d.tex"]);
  });

  it("says when nothing changed", () => {
    const o = undoOutcome({ commit: null, written: [], deleted: [], conflicts: ["a.tex"], failed: [] });
    expect(o.text).toMatch(/^Nothing was undone.*1 of its files afterwards, so it was left as it is\.$/);
  });

  it("names files by their last part", () => {
    expect(baseName("chapters/intro.tex")).toBe("intro.tex");
    expect(baseName("main.tex")).toBe("main.tex");
  });
});
