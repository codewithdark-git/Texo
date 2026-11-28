// Static markup of the run card, the Agents tab and the sidebar dock. The
// modules that pull in Monaco or the backend are swapped for stand-ins.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
vi.mock("../actions", () => ({ errorText: String, retryRun: vi.fn(), startRun: vi.fn(), startFixerRun: vi.fn() }));
vi.mock("../ChangesetDialog", () => ({ ChangesetDialog: () => null }));
vi.mock("../NewTaskDialog", () => ({ NewTaskDialog: () => null }));
vi.mock("../PlanDialog", () => ({ PlanDialog: () => null }));
vi.mock("../ReportDialog", () => ({ ReportDialog: () => null }));
vi.mock("../../review/ReviewSetupDialog", () => ({ ReviewSetupDialog: () => null }));
vi.mock("../../aiAccess", () => ({ useAccess: () => [{ state: "loading" }, () => {}] }));
vi.mock("../../aiPrefs", () => ({ useAiSettings: Object.assign(() => null, { getState: () => ({ update: async () => {} }) }) }));
vi.mock("../../../library/PaperStrip", () => ({ PaperStrip: ({ papers }: { papers: unknown[] }) => `papers:${papers.length}` }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunProgress, RunSummary } from "../../../lib/agentsApi";
import { cardView, initialCardView, RunCard } from "../RunCard";
import { AgentsTab } from "../AgentsTab";
import { DockList } from "../../dock/AgentTasksDock";
import { LiveLine } from "./LiveLine";
import { PhaseStepper } from "./PhaseStepper";
import { PlanChecklist } from "./PlanChecklist";
import { StepGroups } from "./StepGroups";

const count = (html: string, needle: string) => html.split(needle).length - 1;

function run(id: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    project: "C:/p",
    kind: "task",
    profileId: null,
    profileName: null,
    title: `Run ${id}`,
    status: "running",
    model: "m",
    stepCount: 3,
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
    maxSteps: 24,
    ...over,
  };
}

const progress = (over: Partial<RunProgress> = {}): RunProgress => ({ phases: [], plan: [], activity: null, counts: {}, ...over });

describe("RunCard", () => {
  it("a running card has a progress ring with its value", () => {
    const html = renderToStaticMarkup(createElement(RunCard, { project: "C:/p", run: run("a") }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="13"');
    expect(html).toContain("Running");
    expect(html).toContain("Stop");
  });

  it("spins when progress can't be told, and shows phases and what runs now", () => {
    const p = progress({
      phases: [
        { id: "read", label: "Read the errors", status: "done" },
        { id: "round1", label: "Fix round 1 of 3", status: "active", detail: "3 errors left" },
        { id: "check", label: "Compile check", status: "pending" },
      ],
      activity: { tool: "search_papers", label: 'Searching papers: "diffusion"', startedAt: 1, sources: [{ source: "arXiv", state: "ok", detail: "4" }] },
    });
    const html = renderToStaticMarkup(createElement(RunCard, { project: "C:/p", run: run("b", { kind: "fixer", progress: p }) }));
    expect(html).toContain("Fix round 1 of 3 · 3 errors left");
    expect(html).toContain("texo-shimmer");
    expect(html).toContain("arXiv: 4 found");
    const unknown = renderToStaticMarkup(createElement(RunCard, { project: "C:/p", run: run("c", { maxSteps: undefined }) }));
    expect(unknown).toContain('role="progressbar"');
    expect(unknown).not.toContain("aria-valuenow");
    expect(unknown).toContain("texo-ring-indeterminate");
  });

  it("a finished card has no ring, its counts and the next actions", () => {
    const html = renderToStaticMarkup(
      createElement(RunCard, {
        project: "C:/p",
        run: run("d", { status: "awaiting_review", pendingFiles: 2, finishedAt: 1100, progress: progress({ counts: { papersFound: 23, papersNew: 18 } }) }),
      }),
    );
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain("23 found · 18 new · 5 duplicates");
    expect(html).toContain("Review changes");
    expect(html).not.toContain("Stop");
  });

  it("a failed card says why and offers Retry", () => {
    const html = renderToStaticMarkup(createElement(RunCard, { project: "C:/p", run: run("e", { status: "failed", error: "The model stopped answering.", finishedAt: 1001 }) }));
    expect(html).toContain("The model stopped answering.");
    expect(html).toContain("Retry");
    expect(html).toContain("Failed");
  });
});

describe("RunCard focus requests", () => {
  it("a card that mounts with a request opens in Summary density and flashes", () => {
    const html = renderToStaticMarkup(createElement(RunCard, { project: "C:/p", run: run("f"), density: "summary", focusSeq: 3 }));
    expect(html).toContain('aria-expanded="true"');
    expect(count(html, "texo-flash")).toBe(1);
    const plain = renderToStaticMarkup(createElement(RunCard, { project: "C:/p", run: run("f"), density: "summary" }));
    expect(plain).toContain('aria-expanded="false"');
    expect(plain).not.toContain("texo-flash");
  });

  it("opens and flashes on every new request, and density still opens or folds", () => {
    let v = initialCardView("summary", 2);
    expect(v).toMatchObject({ open: true, seq: 2, flash: 2 });
    // The request is cleared: nothing changes, the flash keeps running.
    expect(cardView(v, "summary", 0)).toBe(v);
    v = { ...v, open: false, flash: 0 };
    // A later request for the same card opens it and flashes again.
    v = cardView(v, "summary", 5);
    expect(v).toMatchObject({ open: true, flash: 5 });
    expect(cardView(v, "summary", 5)).toBe(v);
    v = cardView(v, "detailed", 0);
    expect(v.open).toBe(true);
    v = cardView(v, "summary", 0);
    expect(v.open).toBe(false);
    expect(initialCardView("detailed", 0)).toMatchObject({ open: true, flash: 0 });
    expect(initialCardView("summary", 0)).toMatchObject({ open: false, flash: 0 });
  });
});

describe("progress pieces", () => {
  it("the phase stepper names every phase for screen readers", () => {
    const html = renderToStaticMarkup(
      createElement(PhaseStepper, {
        phases: [
          { id: "checks", label: "Automatic checks", status: "done" },
          { id: "reviewers", label: "Reviewers", status: "active", done: 1, total: 3 },
          { id: "chair", label: "Area chair", status: "pending" },
        ],
      }),
    );
    expect(html).toContain('aria-label="Phases"');
    expect(html).toContain("Automatic checks: done");
    expect(html).toContain("Reviewers · 1 of 3");
    expect(html).toContain("2/3");
  });

  it("the plan checklist shows each item's state", () => {
    const html = renderToStaticMarkup(
      createElement(PlanChecklist, {
        plan: [
          { n: 1, task: "Shorten the abstract", status: "done" },
          { n: 2, task: "Fix the figures", status: "active" },
          { n: 3, task: "Add a reference", status: "pending" },
        ],
      }),
    );
    expect(html).toContain("texo-check-draw");
    expect(html).toContain("animate-spin");
    expect(html).toContain("1 of 3");
    expect(count(html, "data-flip=")).toBe(3);
  });

  it("step groups fold repeated calls and show the papers they found", () => {
    const steps = [1, 2, 3].map((n) => ({
      n,
      kind: "toolCall" as const,
      tool: "search_papers",
      resultSummary: `Searched papers for "q": ${n} found`,
      ok: true,
      ms: 100,
      at: n,
      data: { papers: [{ uid: `p${n}` }] },
    }));
    const html = renderToStaticMarkup(createElement(StepGroups, { steps, active: false }));
    expect(html).toContain("Ran 3 paper searches · 6 results");
    expect(html).toContain("papers:3");
  });

  it("the live line shows the last streamed lines when no tool runs", () => {
    const html = renderToStaticMarkup(createElement(LiveLine, { activity: null, stream: "one\ntwo\n**three**" }));
    expect(html).toContain("two");
    expect(html).toContain("three");
    expect(html).not.toContain("**");
    expect(html).not.toContain("aria-live");
  });
});

describe("AgentsTab", () => {
  it("has one polite live region and the density switch stays out until there are runs", () => {
    const html = renderToStaticMarkup(createElement(AgentsTab, { project: "C:/p" }));
    expect(count(html, 'aria-live="polite"')).toBe(1);
    expect(html).toContain("sr-only");
    expect(html).toContain("New task");
  });
});

describe("the background tasks dock", () => {
  it("shows at most 3 rows plus n more", () => {
    const runs = [1, 2, 3, 4, 5].map((n) => run(String(n)));
    const html = renderToStaticMarkup(createElement(DockList, { runs, compact: false }));
    expect(count(html, "<li")).toBe(3);
    expect(html).toContain("2 more");
    expect(html).toContain("Run 1");
    expect(html).not.toContain("Run 4");
  });

  it("is quiet with nothing running, and one icon with a count in the rail", () => {
    expect(renderToStaticMarkup(createElement(DockList, { runs: [run("x", { status: "done" })], compact: false }))).toContain("No background tasks");
    const rail = renderToStaticMarkup(createElement(DockList, { runs: [run("1"), run("2")], compact: true }));
    expect(rail).toContain('aria-label="2 background tasks"');
    expect(rail).toContain('role="progressbar"');
    expect(count(rail, "<li")).toBe(0);
  });
});
