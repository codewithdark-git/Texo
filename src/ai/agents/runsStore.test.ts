import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import type { RunSummary, Step } from "../../lib/agentsApi";
import {
  applyMessage,
  canRetry,
  dropStreams,
  plainSummary,
  elapsedSecs,
  formatElapsed,
  formatTokens,
  mergeStep,
  mergeSteps,
  MAX_STEPS_SHOWN,
  NO_STREAMS,
  runsForProject,
  runStream,
  STREAM_TAIL,
  streamKey,
  upsertRun,
  useRuns,
} from "./runsStore";

const step = (n: number, resultSummary = `step ${n}`): Step => ({ n, kind: "toolCall", tool: "read_file", resultSummary, ok: true, ms: 5, at: 100 + n });

function run(id: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    project: "C:\\Papers\\one",
    kind: "task",
    profileId: null,
    profileName: null,
    title: id,
    status: "running",
    model: "m",
    stepCount: 0,
    lastStep: null,
    pendingFiles: 0,
    changedFiles: 0,
    conflictFiles: 0,
    needsAttention: false,
    hasReport: false,
    usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0 },
    startedAt: 1000,
    finishedAt: null,
    error: null,
    awaiting: null,
    ...over,
  };
}

describe("run reducers", () => {
  it("adds and replaces summaries", () => {
    let runs = upsertRun({}, run("a"));
    runs = upsertRun(runs, run("a", { status: "done" }));
    expect(Object.keys(runs)).toEqual(["a"]);
    expect(runs.a.status).toBe("done");
  });

  it("lists a project's runs newest first, matching paths loosely", () => {
    let runs = upsertRun({}, run("old", { startedAt: 1 }));
    runs = upsertRun(runs, run("new", { startedAt: 5, project: "c:/papers/one/" }));
    runs = upsertRun(runs, run("other", { project: "C:\\Papers\\two" }));
    expect(runsForProject(runs, "C:\\Papers\\one").map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("keeps steps in order without duplicates", () => {
    let s = mergeStep([], step(1));
    s = mergeStep(s, step(3));
    s = mergeStep(s, step(2));
    s = mergeStep(s, step(2, "updated"));
    expect(s.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(s[1].resultSummary).toBe("updated");
  });

  it("merges fetched steps with live ones that arrived meanwhile", () => {
    expect(mergeSteps([step(4)], [step(1), step(2), step(3)]).map((x) => x.n)).toEqual([1, 2, 3, 4]);
    expect(mergeSteps(undefined, [step(1)]).map((x) => x.n)).toEqual([1]);
  });

  it("caps the live list", () => {
    let s: Step[] = [];
    for (let i = 1; i <= MAX_STEPS_SHOWN + 5; i++) s = mergeStep(s, step(i));
    expect(s.length).toBe(MAX_STEPS_SHOWN);
    expect(s[0].n).toBe(6);
  });

  it("formats time and tokens", () => {
    expect(formatElapsed(4.7)).toBe("4 s");
    expect(formatElapsed(125)).toBe("2 min 05 s");
    expect(formatElapsed(3840)).toBe("1 h 04 min");
    expect(elapsedSecs({ startedAt: 10, finishedAt: null }, 25)).toBe(15);
    expect(elapsedSecs({ startedAt: 10, finishedAt: 12 }, 25)).toBe(2);
    expect(formatTokens(950)).toBe("950 tokens");
    expect(formatTokens(1234)).toBe("1.2k tokens");
    expect(formatTokens(45_600)).toBe("46k tokens");
  });

  it("offers retry only for runs that didn't finish", () => {
    expect(canRetry({ status: "failed" })).toBe(true);
    expect(canRetry({ status: "interrupted" })).toBe(true);
    expect(canRetry({ status: "done" })).toBe(false);
    expect(canRetry({ status: "running" })).toBe(false);
  });
});

describe("the runs store", () => {
  it("takes events for its project only, and steps only for followed runs", () => {
    useRuns.setState({ project: "C:\\Papers\\one", runs: {}, steps: { a: [] } });
    const st = useRuns.getState();
    st.noteRun(run("a"));
    st.noteRun(run("x", { project: "C:\\Papers\\two" }));
    st.noteStep("a", step(1));
    st.noteStep("b", step(1));
    expect(Object.keys(useRuns.getState().runs)).toEqual(["a"]);
    expect(useRuns.getState().steps).toEqual({ a: [step(1)] });
    st.forget("a");
    expect(useRuns.getState().runs).toEqual({});
    expect(useRuns.getState().steps).toEqual({});
  });
});

describe("plainSummary", () => {
  it("drops markdown marks and math fences", () => {
    expect(plainSummary("Here is some **markdown** and math $E=mc^2$.")).toBe("Here is some markdown and math E=mc^2.");
    expect(plainSummary("## Done\nUsed `\\cite` and *one* fix")).toBe("Done Used \\cite and one fix");
    expect(plainSummary("a_b and x*y stay")).toBe("a_b and x*y stay");
  });
});

describe("streamed text", () => {
  const msg = (text: string, over: { sub?: string; reset?: boolean; runId?: string } = {}) => ({ runId: "a", text, reset: false, ...over });

  it("appends pieces and starts over on reset", () => {
    let st = applyMessage(NO_STREAMS, msg("Hello "));
    st = applyMessage(st, msg("world"));
    expect(runStream(st, "a")).toBe("Hello world");
    st = applyMessage(st, msg("Fresh", { reset: true }));
    expect(runStream(st, "a")).toBe("Fresh");
    // A reset with nothing new forgets the text.
    st = applyMessage(st, msg("", { reset: true }));
    expect(runStream(st, "a")).toBeUndefined();
  });

  it("keeps only the last 240 characters", () => {
    let st = NO_STREAMS;
    for (let i = 0; i < 30; i++) st = applyMessage(st, msg("0123456789"));
    st = applyMessage(st, msg("END"));
    const text = runStream(st, "a")!;
    expect(STREAM_TAIL).toBe(240);
    expect(text.length).toBe(240);
    expect(text.endsWith("789END")).toBe(true);
  });

  it("keeps each sub-run apart and shows the one that spoke last", () => {
    let st = applyMessage(NO_STREAMS, msg("main"));
    st = applyMessage(st, msg("methods", { sub: "Methods" }));
    st = applyMessage(st, msg("novelty", { sub: "Novelty" }));
    st = applyMessage(st, msg(" more", { sub: "Methods" }));
    expect(st.text[streamKey("a", "Methods")]).toBe("methods more");
    expect(st.text[streamKey("a", "Novelty")]).toBe("novelty");
    expect(st.text[streamKey("a")]).toBe("main");
    expect(runStream(st, "a")).toBe("methods more");
    // A reset of one sub-run leaves the others.
    st = applyMessage(st, msg("again", { sub: "Novelty", reset: true }));
    expect(st.text[streamKey("a", "Methods")]).toBe("methods more");
    expect(runStream(st, "a")).toBe("again");
  });

  it("drops one run's streams and no other run's", () => {
    let st = applyMessage(NO_STREAMS, msg("x", { sub: "R1" }));
    st = applyMessage(st, msg("y"));
    st = applyMessage(st, msg("z", { runId: "b" }));
    st = dropStreams(st, "a");
    expect(Object.keys(st.text)).toEqual(["b"]);
    expect(runStream(st, "a")).toBeUndefined();
    expect(runStream(st, "b")).toBe("z");
  });

  it("the store takes text only for known runs that still work, and forgets it when they settle", () => {
    useRuns.setState({ project: "C:\\Papers\\one", runs: {}, steps: {}, streams: NO_STREAMS });
    const st = useRuns.getState();
    st.noteMessage(msg("unknown run"));
    expect(useRuns.getState().streams).toEqual(NO_STREAMS);
    st.noteRun(run("a"));
    st.noteMessage(msg("thinking"));
    expect(runStream(useRuns.getState().streams, "a")).toBe("thinking");
    st.noteRun(run("a", { status: "awaiting_review" }));
    expect(runStream(useRuns.getState().streams, "a")).toBeUndefined();
    st.noteMessage(msg("late"));
    expect(runStream(useRuns.getState().streams, "a")).toBeUndefined();
  });
});
