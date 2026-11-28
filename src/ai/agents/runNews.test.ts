import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import type { Phase, RunStatus, RunSummary } from "../../lib/agentsApi";
import { runNews, type RunNewsMemory } from "./runNews";
import source from "./RunCard.tsx?raw";

type NewsRun = Parameters<typeof runNews>[1];
const phase = (id: string, status: Phase["status"]): Phase => ({ id, label: id === "work" ? "Fixing" : "Checks", status });
const run = (status: RunStatus, phases: Phase[], over: Partial<RunSummary> = {}): NewsRun => ({
  id: "r1",
  title: "Fix compile errors",
  kind: "fixer",
  status,
  pendingFiles: 2,
  progress: { phases, plan: [], activity: null, counts: {} },
  ...over,
});

describe("a run tab's live region", () => {
  it("says nothing on the first update, then phase changes and the finish", () => {
    const first = runNews({ phases: {} }, run("running", [phase("checks", "active"), phase("work", "pending")]));
    expect(first.lines).toEqual([]);
    const second = runNews(first.memory, run("running", [phase("checks", "done"), phase("work", "active")]));
    expect(second.lines).toEqual(["Fix compile errors: Checks finished", "Fix compile errors: Fixing started"]);
    const last = runNews(second.memory, run("awaiting_review", [phase("checks", "done"), phase("work", "done")]));
    expect(last.lines).toEqual(["Fix compile errors: Fixing finished", "Fix compile errors: done. 2 file(s) to review."]);
    expect(runNews(last.memory, run("awaiting_review", [phase("checks", "done"), phase("work", "done")])).lines).toEqual([]);
  });

  it("announces a failure and a stop", () => {
    const mem: RunNewsMemory = { phases: {}, status: "running" };
    expect(runNews(mem, run("failed", [])).lines).toEqual(["Fix compile errors didn't finish."]);
    expect(runNews(mem, run("cancelled", [])).lines).toEqual(["Fix compile errors was stopped."]);
  });

  it("a run already settled when the tab opens isn't news", () => {
    expect(runNews({ phases: {} }, run("done", [])).lines).toEqual([]);
  });

  it("the run tab has a polite status region", () => {
    const page = source.slice(source.indexOf("function RunPage("));
    expect(page).toMatch(/aria-live="polite" aria-atomic="true" role="status" className="sr-only">\s*\{news\}/);
  });
});
