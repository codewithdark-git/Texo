import { beforeEach, describe, expect, it } from "vitest";
import { clampWidth, DEFAULT_WIDTH, finishText, justFinished, MAX_WIDTH, MIN_WIDTH, parsePrefs, useAiPanel } from "./aiPanelStore";
import { useAgentDialog } from "../agents/dialogStore";

describe("panel prefs", () => {
  it("clamps the width to the limits and the window", () => {
    expect(clampWidth(100)).toBe(MIN_WIDTH);
    expect(clampWidth(5000)).toBe(MAX_WIDTH);
    expect(clampWidth(500, 900)).toBe(420);
    expect(clampWidth(500, 500)).toBe(MIN_WIDTH);
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_WIDTH);
  });

  it("reads saved prefs defensively", () => {
    expect(parsePrefs('{"open":true,"width":450,"tab":"agents"}')).toEqual({ open: true, width: 450, tab: "agents" });
    expect(parsePrefs('{"open":"yes","width":"wide","tab":"other"}')).toEqual({ open: false, width: DEFAULT_WIDTH, tab: "chat" });
    expect(parsePrefs("not json")).toEqual({ open: false, width: DEFAULT_WIDTH, tab: "chat" });
    expect(parsePrefs(null).open).toBe(false);
  });
});

describe("finished runs", () => {
  it("counts only a working run that settles", () => {
    expect(justFinished("running", "awaiting_review")).toBe(true);
    expect(justFinished("queued", "failed")).toBe(true);
    expect(justFinished("running", "awaiting_input")).toBe(true);
    expect(justFinished("running", "cancelled")).toBe(false);
    expect(justFinished(undefined, "done")).toBe(false);
    expect(justFinished("done", "done")).toBe(false);
  });

  it("words the toast", () => {
    expect(finishText({ title: "Fix errors", status: "awaiting_review", pendingFiles: 2 })).toBe("Fix errors: done. 2 file(s) to review.");
    expect(finishText({ title: " ", status: "failed", pendingFiles: 0 })).toBe("The agent didn't finish.");
  });
});

describe("badge", () => {
  beforeEach(() => useAiPanel.setState({ open: false, tab: "chat", badge: 0, seen: {} }));

  it("rises for background finishes and clears on the Agents tab", () => {
    const s = useAiPanel.getState();
    expect(s.noteRun({ id: "r1", status: "running" })).toBe(false);
    expect(s.noteRun({ id: "r1", status: "awaiting_review" })).toBe(true);
    expect(useAiPanel.getState().badge).toBe(1);
    useAiPanel.getState().show("agents");
    expect(useAiPanel.getState().badge).toBe(0);
    expect(useAiPanel.getState().open).toBe(true);
  });

  it("stays quiet while the Agents tab is in view", () => {
    useAiPanel.setState({ open: true, tab: "agents" });
    const s = useAiPanel.getState();
    s.noteRun({ id: "r2", status: "queued" });
    expect(s.noteRun({ id: "r2", status: "done" })).toBe(false);
    expect(useAiPanel.getState().badge).toBe(0);
  });
});

describe("closing the panel", () => {
  beforeEach(() => {
    useAiPanel.setState({ open: true, tab: "chat", badge: 0, seen: {} });
    useAgentDialog.getState().open(null);
  });

  it("closes normally with no agent dialog open", () => {
    useAiPanel.getState().toggle();
    expect(useAiPanel.getState().open).toBe(false);
  });

  it("keeps an open agent dialog (and its review work) instead of closing (FE-4)", () => {
    useAgentDialog.getState().open({ type: "changes", runId: "r1" });
    useAiPanel.getState().toggle();
    expect(useAiPanel.getState().open).toBe(true);
    // The dialog is in the Agents tab: bring it into view.
    expect(useAiPanel.getState().tab).toBe("agents");
    useAgentDialog.getState().open(null);
    useAiPanel.getState().setOpen(false);
    expect(useAiPanel.getState().open).toBe(false);
  });
});
