import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import compilePanel from "../workspace/CompilePanel.tsx?raw";
import type { RunStatus } from "../lib/agentsApi";
import type { Phase } from "../lib/agentsApi";
import { activeFixerRun, fixerProgress, fixIssuesLabel, fixIssuesState, NO_ERRORS, NOT_COMPILED, WAIT_FOR_COMPILE, type FixCompileStatus, type FixerRun } from "./fixIssues";

// The view module pulls in the stores; the markup tests need none of them.
vi.mock("./fixStore", () => ({ explainIssue: () => {}, fixAllErrors: () => {}, useFix: () => false }));
vi.mock("./agents/actions", () => ({ startFixerRun: async () => null }));
vi.mock("./agents/runsStore", () => ({ listenRunEvents: () => () => {}, runsForProject: () => [], useRuns: () => ({}) }));
vi.mock("./panel/aiPanelStore", () => ({ useAiPanel: { getState: () => ({ show: () => {} }) } }));

import { ExplainIssueButton, FIX_MENU, FixIssuesView } from "./AiButtons";
import { DEFAULT_AI_SETTINGS } from "./aiPrefs";
import type { Issue } from "../lib/api";

const counts = (error: number, warning = 0, badbox = 0) => ({ error, warning, badbox });
const phase = (id: string, status: Phase["status"]): Phase => ({ id, label: id, status });
const fixer = (status: RunStatus, phases: Phase[] = []): FixerRun => ({ id: "r1", status, progress: { phases, plan: [], activity: null, counts: {} } });

describe("fixIssuesState", () => {
  const statuses: FixCompileStatus[] = [undefined, "success", "failed", "aborted", "timeout", "compiling"];
  const countSets = [counts(0), counts(0, 2, 3), counts(3), counts(1, 4)];
  const runs: (FixerRun | null)[] = [null, fixer("running"), fixer("queued"), fixer("awaiting_input"), fixer("done"), fixer("awaiting_review"), fixer("failed")];

  // The whole table: every count set × compile status × AI switch × fixer run.
  for (const ai of [false, true])
    for (const run of runs)
      for (const status of statuses)
        for (const c of countSets) {
          const expected = !ai
            ? "hidden"
            : run && ["running", "queued", "awaiting_input"].includes(run.status)
              ? "progress"
              : status === "compiling" || (c.error === 0 && status !== "failed")
                ? "disabled"
                : "ready";
          it(`ai ${ai}, fixer ${run?.status ?? "none"}, ${status ?? "not compiled"}, ${c.error} errors / ${c.warning} warnings → ${expected}`, () => {
            const s = fixIssuesState(c, status, ai, run);
            expect(s.kind).toBe(expected);
            if (s.kind === "ready" || s.kind === "disabled") expect(s.count).toBe(c.error);
            if (s.kind === "disabled") expect(s.reason).toBe(status === "compiling" ? WAIT_FOR_COMPILE : status === undefined ? NOT_COMPILED : NO_ERRORS);
            if (s.kind === "progress") expect(s.runId).toBe("r1");
          });
        }

  it("warnings and layout boxes alone leave it dimmed, saying why", () => {
    expect(fixIssuesState(counts(0, 9, 9), "success", true, null)).toEqual({ kind: "disabled", count: 0, reason: NO_ERRORS });
  });

  it("a compile that failed without a listed error is still fixable", () => {
    expect(fixIssuesState(counts(0), "failed", true, null)).toEqual({ kind: "ready", count: 0 });
    expect(fixIssuesLabel(0)).toBe("Fix issues");
    expect(fixIssuesLabel(3)).toBe("Fix issues (3)");
  });
});

describe("fixerProgress", () => {
  const all = (active: string) =>
    ["read", "round1", "round2", "round3", "check"].map((id, i, ids) => phase(id, i < ids.indexOf(active) ? "done" : id === active ? "active" : "pending"));

  it("names the round out of the rounds there are", () => {
    expect(fixerProgress(fixer("running", all("round2")))).toEqual({ label: "Fixing… round 2 of 3", value: 2 / 5 });
  });

  it("names the read and check phases", () => {
    expect(fixerProgress(fixer("running", all("read"))).label).toBe("Fixing… reading the errors");
    expect(fixerProgress(fixer("running", all("check"))).label).toBe("Fixing… compile check");
  });

  it("is indeterminate without phases, and says when the run waits for a slot", () => {
    expect(fixerProgress(fixer("running"))).toEqual({ label: "Fixing…", value: undefined });
    expect(fixerProgress({ id: "r", status: "running" })).toEqual({ label: "Fixing…", value: undefined });
    expect(fixerProgress(fixer("queued", all("read"))).label).toBe("Fixer waiting to start");
  });

  it("leaves skipped phases out of the fraction", () => {
    const phases = [phase("read", "done"), phase("round1", "active"), phase("round2", "skipped"), phase("round3", "skipped"), phase("check", "pending")];
    expect(fixerProgress(fixer("running", phases)).value).toBeCloseTo(1 / 3);
  });
});

describe("activeFixerRun", () => {
  const run = (id: string, kind: string, status: RunStatus, startedAt: number) => ({ id, kind, status, startedAt });
  it("picks the newest fixer run still at work", () => {
    const runs = [run("a", "fixer", "running", 1), run("b", "fixer", "queued", 5), run("c", "task", "running", 9), run("d", "fixer", "done", 10)];
    expect(activeFixerRun(runs)?.id).toBe("b");
    expect(activeFixerRun([run("d", "fixer", "awaiting_review", 10)])).toBeNull();
    expect(activeFixerRun([])).toBeNull();
  });
});

describe("FixIssuesView", () => {
  const props = { menuOpen: false, onMenuOpenChange: () => {}, onAgent: () => {}, onQuickFix: () => {}, onShowRun: () => {} };
  const render = (extra: Partial<Parameters<typeof FixIssuesView>[0]> & Pick<Parameters<typeof FixIssuesView>[0], "state">) =>
    renderToStaticMarkup(createElement(FixIssuesView, { ...props, ...extra }));

  it("is a labelled split button with a chevron menu: Quick fix and the fixer agent", () => {
    const closed = render({ state: { kind: "ready", count: 2 } });
    expect(closed).toContain('aria-label="Fix issues"');
    expect(closed).toContain("Fix issues (2)");
    expect(closed).toContain('aria-haspopup="menu"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('role="menu"');

    const open = render({ state: { kind: "ready", count: 2 }, menuOpen: true });
    expect(open).toContain('role="menu"');
    expect(open).toContain('aria-expanded="true"');
    expect(open.split('role="menuitem"').length - 1).toBe(2);
    expect(open).toContain("Quick fix");
    expect(open).toContain("Let the fixer agent handle it");
    expect(FIX_MENU.map((m) => m.label)).toEqual(["Quick fix (Explain & fix)", "Let the fixer agent handle it"]);
  });

  it("renders nothing when hidden", () => {
    expect(render({ state: { kind: "hidden" } })).toBe("");
  });

  it("is disabled while compiling, with the reason, and keeps its menu shut", () => {
    const html = render({ state: { kind: "disabled", count: 2, reason: WAIT_FOR_COMPILE }, menuOpen: true });
    expect(html).toContain('aria-label="Fix issues"');
    expect(html.split('aria-disabled="true"').length - 1).toBe(2);
    expect(html).not.toContain('role="menu"');
  });

  it("becomes a progress chip while a fixer run works", () => {
    const html = render({ state: { kind: "progress", runId: "r1", label: "Fixing… round 2 of 3", value: 0.4 } });
    expect(html).toContain("Fixing… round 2 of 3");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).not.toContain("Fix issues (");
  });
});

describe("ExplainIssueButton", () => {
  const issue = (severity: Issue["severity"]) => ({ severity, message: "Undefined control sequence.", file: "main.tex", line: 3 }) as Issue;
  // Static rendering reads the store's initial state, which has AI on (the
  // AI-off branch is covered by fixIssuesState and the early return).
  it("shows on each error, and not on warnings", () => {
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(true);
    expect(renderToStaticMarkup(createElement(ExplainIssueButton, { issue: issue("error") }))).toContain("Explain &amp; fix");
    expect(renderToStaticMarkup(createElement(ExplainIssueButton, { issue: issue("warning") }))).toBe("");
  });
});

describe("CompilePanel's Issues area", () => {
  it("uses the one Fix issues button instead of the two old ones", () => {
    expect(compilePanel).toContain("<FixIssuesButton");
    expect(compilePanel).not.toMatch(/<FixAllButton|<FixerAgentButton/);
  });

  it("still renders Explain & fix on every issue row", () => {
    const row = compilePanel.slice(compilePanel.indexOf("function IssueRow"), compilePanel.indexOf("function IssueList"));
    expect(row).toContain("<ExplainIssueButton issue={issue} />");
    expect(compilePanel).toMatch(/main\.map\(\(issue, i\) => \(\s*<IssueRow/);
    expect(compilePanel).toMatch(/consequences\.map\(\(issue, i\) => \(\s*<IssueRow/);
  });
});
