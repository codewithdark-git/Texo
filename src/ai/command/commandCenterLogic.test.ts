import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
// Starting runs reaches the editor (Monaco needs a window); not under test here.
vi.mock("../agents/actions", () => ({ startFixerRun: vi.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import source from "./CommandCenter.tsx?raw";
import { CommandCenter, CommandPill } from "./CommandCenter";
import type { RunSummary } from "../../lib/agentsApi";
import type { ChatSummary } from "../../lib/chatApi";
import {
  activityText,
  buildSections,
  EMPTY_SEEN,
  flatRows,
  fuzzyItems,
  groupChats,
  IDLE_TEXT,
  isCommandCenterShortcut,
  markSeen,
  moveSelection,
  pillState,
  runProgressFraction,
  trackUnseen,
  type PillState,
} from "./commandCenterLogic";

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

function chat(id: string, updated: number, over: Partial<ChatSummary> = {}): ChatSummary {
  return { id, title: id, created: updated, updated, model: null, messageCount: 2, preview: "", ...over };
}

const plan = { type: "rebuttalPlan", concerns: [], message: "" };

describe("pillState", () => {
  const input = run("input", { status: "awaiting_input", kind: "rebuttal", awaiting: plan });
  const review = run("review", { status: "awaiting_review", pendingFiles: 3 });
  const failed = run("failed", { status: "failed", kind: "fixer" });
  const working = run("working", { status: "running", lastStep: "Read main.tex" });
  const finished = run("finished", { status: "done", kind: "reviewer" });
  const unseen = { failed: true, finished: true } as const;

  it("ranks needs input > review > failed unseen > running > finished unseen > idle", () => {
    const all = [finished, working, failed, review, input];
    const order: PillState["kind"][] = [];
    let left = all;
    for (;;) {
      const p = pillState(left, unseen);
      order.push(p.kind);
      if (p.kind === "idle") break;
      left = left.filter((r) => r.id !== p.runId);
    }
    expect(order).toEqual(["needsInput", "review", "failed", "running", "finished", "idle"]);
  });

  it("says what each state is about in plain words", () => {
    expect(pillState([input], {}).text).toBe("Plan needs your approval");
    expect(pillState([review], {}).text).toBe("3 files to review");
    expect(pillState([run("one", { status: "awaiting_review", pendingFiles: 1 })], {}).text).toBe("1 file to review");
    expect(pillState([failed], unseen).text).toBe("Fixer failed: open");
    expect(pillState([finished], unseen).text).toBe("Review finished");
    expect(pillState([working], {}).text).toBe("Read main.tex");
    expect(pillState([], {})).toEqual({ kind: "idle", text: IDLE_TEXT, runId: null, more: 0, fraction: null });
  });

  it("ignores failed and finished runs that were already seen", () => {
    expect(pillState([failed, finished], {}).kind).toBe("idle");
  });

  it("counts the other working runs as +n and prefers a running one over a queued one", () => {
    const queued = run("queued", { status: "queued", startedAt: 2000 });
    const p = pillState([queued, working, run("w2", { startedAt: 500 })], {});
    expect(p.kind).toBe("running");
    expect(p.runId).toBe("working");
    expect(p.more).toBe(2);
  });

  it("shows the running tool's label and a known fraction", () => {
    const r = run("r", {
      progress: {
        phases: [],
        plan: [
          { n: 1, task: "a", status: "done" },
          { n: 2, task: "b", status: "active" },
        ],
        activity: { tool: "search_papers", label: "Searching Semantic Scholar…", startedAt: 1 },
        counts: {},
      },
    });
    const p = pillState([r], {});
    expect(p.text).toBe("Searching Semantic Scholar…");
    expect(p.fraction).toBe(0.5);
  });
});

describe("run progress", () => {
  it("uses the plan, then phases, then steps out of the limit, else null", () => {
    const phases = run("p", {
      progress: {
        phases: [
          { id: "read", label: "Read the errors", status: "done" },
          { id: "round1", label: "Fix round 1 of 3", status: "active", done: 1, total: 2 },
          { id: "check", label: "Compile check", status: "pending" },
          { id: "x", label: "Skipped", status: "skipped" },
        ],
        plan: [],
        activity: null,
        counts: {},
      },
    });
    expect(runProgressFraction(phases)).toBeCloseTo(0.5);
    expect(runProgressFraction(run("s", { stepCount: 30, maxSteps: 24 }))).toBe(0.95);
    expect(runProgressFraction(run("s", { stepCount: 6, maxSteps: 24 }))).toBe(0.25);
    expect(runProgressFraction(run("n"))).toBeNull();
    expect(activityText(phases)).toBe("Fix round 1 of 3 (1 of 2)");
    expect(activityText(run("q", { status: "queued" }))).toBe("Waiting for a free slot");
  });
});

describe("unseen finishes", () => {
  it("marks a run that finishes while the Agents tab is out of view, not one first seen finished", () => {
    let s = trackUnseen(EMPTY_SEEN, [run("a"), run("old", { status: "failed" })], false);
    expect(s.unseen).toEqual({});
    s = trackUnseen(s, [run("a", { status: "failed" }), run("old", { status: "failed" })], false);
    expect(s.unseen).toEqual({ a: true });
    // It stays until seen …
    s = trackUnseen(s, [run("a", { status: "failed" })], false);
    expect(s.unseen).toEqual({ a: true });
    expect(markSeen(s).unseen).toEqual({});
    expect(markSeen(s, ["a"]).unseen).toEqual({});
    // … or until it runs again.
    expect(trackUnseen(s, [run("a", { status: "running" })], false).unseen).toEqual({});
  });

  it("does not mark a finish the user watched, or one they stopped", () => {
    const s = trackUnseen(EMPTY_SEEN, [run("a"), run("b")], false);
    expect(trackUnseen(s, [run("a", { status: "done" }), run("b")], true).unseen).toEqual({});
    expect(trackUnseen(s, [run("a", { status: "cancelled" }), run("b")], false).unseen).toEqual({});
  });

  it("does not mark a finish watched in the run's own tab, but marks the others", () => {
    const s = trackUnseen(EMPTY_SEEN, [run("a"), run("b")], false);
    const watching = (id: string) => id === "a";
    expect(trackUnseen(s, [run("a", { status: "done" }), run("b", { status: "done" })], watching).unseen).toEqual({ b: true });
  });
});

describe("groupChats", () => {
  // Thursday 26 November 2026, 10:00 local time.
  const now = new Date(2026, 10, 26, 10, 0, 0);
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).getTime();

  it("puts chats in Today / Yesterday / Earlier, newest first", () => {
    const groups = groupChats([chat("old", at(20, 9)), chat("today2", at(26, 9)), chat("yest", at(25, 23)), chat("today1", at(26, 0)), chat("dawn", at(25, 0))], now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(groups.map((g) => g.chats.map((c) => c.id))).toEqual([["today2", "today1"], ["yest", "dawn"], ["old"]]);
  });

  it("leaves out empty groups and keeps at most eight chats", () => {
    const many = Array.from({ length: 12 }, (_, i) => chat(`c${i}`, at(10, i)));
    const groups = groupChats(many, now);
    expect(groups.map((g) => g.label)).toEqual(["Earlier"]);
    expect(groups[0].chats).toHaveLength(8);
    expect(groups[0].chats[0].id).toBe("c11");
  });
});

describe("search", () => {
  const runs = [run("fix", { title: "Fix compile errors", kind: "fixer", status: "done", startedAt: 2000 }), run("rev", { title: "Review for NeurIPS", kind: "reviewer", status: "done" })];
  const chats = [chat("c1", 5, { title: "Bibliography style", preview: "natbib or biblatex" }), chat("c2", 4, { title: "Abstract wording" })];

  it("filters chats and runs with the same fuzzy match", () => {
    expect(fuzzyItems("neur", runs, (r) => [r.title]).map((r) => r.id)).toEqual(["rev"]);
    expect(fuzzyItems("biblatex", chats, (c) => [c.title, c.preview]).map((c) => c.id)).toEqual(["c1"]);
    expect(fuzzyItems("", chats, (c) => [c.title])).toHaveLength(2);
  });

  it("buildSections applies the query to both runs and chats", () => {
    const ids = (q: string) => flatRows(buildSections({ runs, chats, unseen: {}, pending: {}, query: q })).map((r) => r.id);
    expect(ids("")).toEqual(["run-fix", "run-rev", "chat-c1", "chat-c2", "all-chats"]);
    // "Show all in AI panel" follows the chats: only while some chat is listed.
    expect(ids("fix")).toEqual(["run-fix"]);
    expect(ids("abstract")).toEqual(["chat-c2", "all-chats"]);
  });

  it("buildSections returns no sections when a query matches nothing", () => {
    expect(buildSections({ runs, chats, unseen: {}, pending: {}, query: "zzqqxx" })).toEqual([]);
  });
});

describe("buildSections", () => {
  it("groups runs into Needs attention, Running and Recent tasks with their actions", () => {
    const runs = [
      run("plan", { status: "awaiting_input", kind: "rebuttal", awaiting: plan, startedAt: 9 }),
      run("changes", { status: "awaiting_review", pendingFiles: 2, startedAt: 8 }),
      run("broke", { status: "failed", error: "The model stopped answering.", startedAt: 7 }),
      run("going", { status: "running", startedAt: 6 }),
      ...Array.from({ length: 7 }, (_, i) => run(`done${i}`, { status: "done", startedAt: 5 - i })),
    ];
    const sections = buildSections({ runs, chats: [], unseen: { broke: true }, pending: {}, query: "" });
    expect(sections.map((s) => s.label)).toEqual(["Needs attention", "Running", "Recent tasks"]);
    const [attention, running, recent] = sections;
    expect(attention.rows.map((r) => (r.type === "attention" ? [r.run.id, r.reason, r.action.label] : null))).toEqual([
      ["plan", "Plan needs your approval", "Review plan"],
      ["changes", "2 files to review", "Review changes"],
      ["broke", "The model stopped answering.", "Open"],
    ]);
    expect(running.rows).toHaveLength(1);
    expect(recent.rows).toHaveLength(5);
  });

  it("marks chats with an answer on the way", () => {
    const rows = flatRows(buildSections({ runs: [], chats: [chat("a", 2), chat("b", 1)], unseen: {}, pending: { b: {} }, query: "" }));
    expect(rows.map((r) => (r.type === "chat" ? r.pending : null))).toEqual([false, true, null]);
  });
});

describe("moveSelection", () => {
  it("moves through rows across groups and wraps at both ends", () => {
    expect(moveSelection(0, 1, 4)).toBe(1);
    expect(moveSelection(3, 1, 4)).toBe(0);
    expect(moveSelection(0, -1, 4)).toBe(3);
    expect(moveSelection(-1, 1, 4)).toBe(0);
    expect(moveSelection(-1, -1, 4)).toBe(3);
    expect(moveSelection(2, 1, 0)).toBe(-1);
  });

  it("knows the shortcut by key and by physical key", () => {
    const k = (over: Partial<KeyboardEvent>) => ({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "J", code: "KeyJ", ...over });
    expect(isCommandCenterShortcut(k({}))).toBe(true);
    expect(isCommandCenterShortcut(k({ key: "о" }))).toBe(true);
    expect(isCommandCenterShortcut(k({ shiftKey: false, key: "j" }))).toBe(false);
    expect(isCommandCenterShortcut(k({ altKey: true }))).toBe(false);
  });
});

describe("CommandCenter markup", () => {
  it("the pill says it opens a dialog and whether it is open", () => {
    const html = renderToStaticMarkup(createElement(CommandCenter, { project: "C:\\Papers\\one" }));
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(IDLE_TEXT);
    const open = renderToStaticMarkup(
      createElement(CommandPill, { pill: pillState([], {}), open: true, compact: false, onToggle: () => {}, buttonRef: { current: null } }),
    );
    expect(open).toContain('aria-expanded="true"');
  });

  it("a running pill shows a progress ring and a needs-input pill a pulsing dot", () => {
    const pill = (p: PillState) => renderToStaticMarkup(createElement(CommandPill, { pill: p, open: false, compact: false, onToggle: () => {}, buttonRef: { current: null } }));
    const running = pill(pillState([run("a"), run("b")], {}));
    expect(running).toContain('role="progressbar"');
    expect(running).toContain("+1");
    expect(pill(pillState([run("a", { status: "awaiting_input" })], {}))).toContain("texo-pulse-dot");
  });

  it("follows runs and chats itself, so it works with the AI panel closed", () => {
    expect(source).toMatch(/listenRunEvents\(\)/);
    expect(source).toMatch(/useChat\.getState\(\)\.init\(project\)/);
    expect(source).toMatch(/listenChatEvents\(\)/);
    expect(source).toMatch(/useRuns\.getState\(\)\.load\(project\)/);
  });
});
