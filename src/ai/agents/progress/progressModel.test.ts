import { describe, expect, it } from "vitest";
import type { Phase, PlanItem, RunProgress, RunSummary, Step } from "../../../lib/agentsApi";
import {
  attentionFirst,
  countsText,
  currentPhase,
  dockRows,
  groupSteps,
  health,
  lanes,
  liveTail,
  phaseAnnouncements,
  phaseCaption,
  resultCount,
  runFraction,
  stepPapers,
} from "./progressModel";

const progress = (over: Partial<RunProgress> = {}): RunProgress => ({ phases: [], plan: [], activity: null, counts: {}, ...over });
const phase = (id: string, status: Phase["status"], over: Partial<Phase> = {}): Phase => ({ id, label: id, status, ...over });
const item = (n: number, status: PlanItem["status"]): PlanItem => ({ n, task: `task ${n}`, status });
const step = (n: number, over: Partial<Step> = {}): Step => ({ n, kind: "toolCall", tool: "read_file", resultSummary: `step ${n}`, ok: true, ms: 10, at: n, ...over });

describe("runFraction", () => {
  const running = { status: "running" as const, stepCount: 6, maxSteps: 24 };

  it("uses the plan first", () => {
    const p = progress({
      plan: [item(1, "done"), item(2, "partly"), item(3, "active"), item(4, "pending")],
      phases: [phase("plan", "done"), phase("work", "active")],
    });
    expect(runFraction({ ...running, progress: p })).toBe(0.5);
  });

  it("then the phases, counting the active phase's done/total", () => {
    const p = progress({ phases: [phase("checks", "done"), phase("reviewers", "active", { done: 1, total: 2 }), phase("chair", "pending"), phase("report", "pending")] });
    const f = runFraction({ ...running, progress: p })!;
    expect(f).toBeGreaterThan(0.25);
    expect(f).toBeLessThan(0.5);
    const skipped = progress({ phases: [phase("a", "skipped"), phase("b", "done")] });
    expect(runFraction({ ...running, progress: skipped })).toBe(1);
  });

  it("then steps used of the limit, capped at 0.95, only while the run works", () => {
    expect(runFraction({ ...running, progress: progress() })).toBe(0.25);
    expect(runFraction({ status: "running", stepCount: 40, maxSteps: 24 })).toBe(0.95);
    expect(runFraction({ status: "done", stepCount: 6, maxSteps: 24 })).toBeNull();
  });

  it("is null when nothing tells (a 1.2 run, no limit)", () => {
    expect(runFraction({ status: "running", stepCount: 3 })).toBeNull();
    expect(runFraction({ status: "running", stepCount: 3, maxSteps: 0 })).toBeNull();
    expect(runFraction({ status: "running", stepCount: 3, progress: { junk: true } as unknown as RunProgress })).toBeNull();
  });
});

describe("health", () => {
  it("names each status in one word", () => {
    expect(health({ status: "queued" }).id).toBe("running");
    expect(health({ status: "running" }).label).toBe("Running");
    expect(health({ status: "awaiting_input" }).label).toBe("Needs input");
    expect(health({ status: "awaiting_review" }).label).toBe("Review");
    expect(health({ status: "failed" }).tone).toBe("danger");
    expect(health({ status: "interrupted" }).id).toBe("failed");
    expect(health({ status: "done" }).tone).toBe("success");
    expect(health({ status: "cancelled" }).label).toBe("Stopped");
  });

  it("puts runs that wait on the user first, keeping the order otherwise", () => {
    const runs = [
      { id: "a", status: "running" },
      { id: "b", status: "awaiting_review" },
      { id: "c", status: "done" },
      { id: "d", status: "awaiting_input" },
    ] as const;
    expect(attentionFirst([...runs]).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("groupSteps", () => {
  it("merges 6 consecutive paper searches into one group with counts", () => {
    const steps = [
      step(1, { tool: "read_file" }),
      ...[2, 3, 4, 5, 6, 7].map((n) => step(n, { tool: "search_papers", resultSummary: `Searched papers for "q${n}": ${n === 7 ? 4 : 2} found`, ok: n !== 5 })),
      step(8, { kind: "message", tool: undefined, resultSummary: "Here is what I found" }),
      step(9, { tool: "search_papers", resultSummary: 'Searched papers for "x": 1 found' }),
    ];
    const groups = groupSteps(steps);
    expect(groups.map((g) => g.count)).toEqual([1, 6, 1, 1]);
    const g = groups[1];
    expect(g.tool).toBe("search_papers");
    expect(g.key).toBe(2);
    expect(g.okCount).toBe(5);
    expect(g.summary).toBe("Ran 6 paper searches · 14 results · 1 failed");
    // A single step keeps its own words.
    expect(groups[0].summary).toBe("step 1");
    expect(groups[2].tool).toBeUndefined();
  });

  it("keeps the same tool in different sub-runs apart, and never merges messages", () => {
    const groups = groupSteps([
      step(1, { tool: "read_file", sub: "R1" }),
      step(2, { tool: "read_file", sub: "R2" }),
      step(3, { kind: "message", tool: undefined }),
      step(4, { kind: "message", tool: undefined }),
    ]);
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1, 1]);
  });

  it("reads result counts from step summaries", () => {
    expect(resultCount('Searched papers for "x": 14 found, 3 new')).toBe(14);
    expect(resultCount("Searched the web for \"x\": 5 result(s)")).toBe(5);
    expect(resultCount('Searched for "foo": 3 hit(s)')).toBe(3);
    expect(resultCount("Read main.tex")).toBeNull();
  });
});

describe("lanes", () => {
  it("groups steps by sub-run in the order each first appears", () => {
    const out = lanes([step(1), step(2, { sub: "Methods" }), step(3, { sub: "Novelty" }), step(4, { sub: "Methods" }), step(5)]);
    expect(out.map((l) => l.sub)).toEqual([null, "Methods", "Novelty"]);
    expect(out[0].steps.map((s) => s.n)).toEqual([1, 5]);
    expect(out[1].steps.map((s) => s.n)).toEqual([2, 4]);
  });
});

describe("phases, counts, papers and the live tail", () => {
  it("finds the phase working now and words it", () => {
    const phases = [phase("read", "done"), phase("round1", "active", { label: "Fix round 1 of 3", detail: "3 errors left" }), phase("check", "pending")];
    expect(currentPhase(phases)?.id).toBe("round1");
    expect(phaseCaption(currentPhase(phases)!)).toBe("Fix round 1 of 3 · 3 errors left");
    expect(phaseCaption(phase("reviewers", "active", { label: "Reviewers", done: 2, total: 3 }))).toBe("Reviewers · 2 of 3");
    expect(currentPhase([phase("a", "done"), phase("b", "done"), phase("c", "skipped")])?.id).toBe("b");
    expect(currentPhase([phase("a", "pending")])).toBeNull();
  });

  it("announces phases that start or finish, not runs seen for the first time", () => {
    const run = (phases: Phase[]) => ({ id: "r", title: "Review paper", kind: "reviewer", progress: progress({ phases }) }) as Pick<RunSummary, "id" | "title" | "kind" | "progress">;
    const first = phaseAnnouncements({}, [run([phase("checks", "active", { label: "Automatic checks" })])]);
    expect(first.lines).toEqual([]);
    const next = phaseAnnouncements(first.memory, [run([phase("checks", "done", { label: "Automatic checks" }), phase("reviewers", "active", { label: "Reviewers" })])]);
    expect(next.lines).toEqual(["Review paper: Automatic checks finished", "Review paper: Reviewers started"]);
    // Nothing changed: nothing to say.
    expect(phaseAnnouncements(next.memory, [run([phase("checks", "done", { label: "Automatic checks" }), phase("reviewers", "active", { label: "Reviewers" })])]).lines).toEqual([]);
  });

  it("words the counters", () => {
    expect(countsText({ papersFound: 23, papersNew: 18 })).toBe("23 found · 18 new · 5 duplicates");
    expect(countsText({ papersFound: 4, papersNew: 4, keysChecked: 3 })).toBe("4 found · 4 new · 3 citations checked");
    expect(countsText({ somethingElse: 2 })).toBe("");
  });

  it("reads papers from step data", () => {
    expect(stepPapers({ data: { papers: [{ uid: "a" }] } })).toEqual([{ uid: "a" }]);
    expect(stepPapers({ data: { papers: "no" } })).toEqual([]);
    expect(stepPapers({})).toEqual([]);
  });

  it("keeps the last one or two lines of streamed text", () => {
    expect(liveTail("first\n\nsecond line\nthird   line  ")).toEqual(["second line", "third line"]);
    expect(liveTail("one", 1)).toEqual(["one"]);
    expect(liveTail(undefined)).toEqual([]);
  });
});

describe("dockRows", () => {
  it("lists working and waiting runs, at most three, and counts the rest", () => {
    const runs = [
      { id: "1", status: "running" },
      { id: "2", status: "done" },
      { id: "3", status: "queued" },
      { id: "4", status: "awaiting_review" },
      { id: "5", status: "running" },
      { id: "6", status: "awaiting_input" },
    ] as Pick<RunSummary, "id" | "status">[];
    const { shown, more } = dockRows(runs);
    expect(shown.map((r) => r.id)).toEqual(["4", "6", "1"]);
    expect(more).toBe(2);
    expect(dockRows([{ id: "x", status: "done" }] as Pick<RunSummary, "id" | "status">[])).toEqual({ shown: [], more: 0 });
  });
});
