import { beforeEach, describe, expect, it } from "vitest";
import { DENSITY_KEY, finishText, justFinished, openRunTab, parseDensity, showFinished, useAiPanel } from "./aiPanelStore";
import { useAiTabs } from "../tabs/aiTabsStore";
import { useLayout } from "../../workspace/layoutStore";

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
  beforeEach(() => {
    useAiPanel.setState({ badge: 0, unseen: [], seen: {} });
    useAiTabs.getState().reset();
    useLayout.setState({ layout: "split" });
  });

  it("rises for background finishes and clears when the Agents tab comes forward", async () => {
    const s = useAiPanel.getState();
    expect(s.noteRun({ id: "r1", status: "running" })).toBe(false);
    expect(s.noteRun({ id: "r1", status: "awaiting_review" })).toBe(true);
    expect(useAiPanel.getState().badge).toBe(1);
    useAiPanel.getState().show("agents");
    await Promise.resolve();
    expect(useAiPanel.getState().badge).toBe(0);
    expect(useAiTabs.getState().active).toBe("agents");
  });

  it("keeps the badge when a run's tab takes the Agents tab's place", async () => {
    useAiPanel.setState({ badge: 2 });
    useAiPanel.getState().show("agents");
    useAiTabs.getState().openRun("r9");
    await Promise.resolve();
    expect(useAiTabs.getState().tabs).toEqual(["run:r9"]);
    expect(useAiPanel.getState().badge).toBe(2);
  });

  it("clears for an Agents tab already open once it is in view again", async () => {
    useAiTabs.getState().open("agents");
    useLayout.setState({ layout: "pdf" });
    useAiPanel.setState({ badge: 1 });
    useAiPanel.getState().show("agents");
    await Promise.resolve();
    expect(useLayout.getState().layout).toBe("split");
    expect(useAiPanel.getState().badge).toBe(0);
  });

  it("asks the Chat tab to open its list of chats", () => {
    useAiPanel.getState().showChatList();
    expect(useAiTabs.getState().active).toBe("chat");
    expect(useAiPanel.getState().chatListWanted).toBe(true);
    useAiPanel.setState({ chatListWanted: false });
  });

  it("clears when the user picks the Agents tab in the strip too", () => {
    useAiTabs.getState().open("agents");
    useAiTabs.getState().open("chat");
    useAiPanel.setState({ badge: 2 });
    useAiTabs.getState().activate("agents");
    expect(useAiPanel.getState().badge).toBe(0);
  });

  it("stays quiet while the Agents tab or the run's own tab is in view", () => {
    useAiTabs.getState().open("agents");
    const s = useAiPanel.getState();
    s.noteRun({ id: "r2", status: "queued" });
    expect(s.noteRun({ id: "r2", status: "done" })).toBe(false);
    useAiTabs.getState().openRun("r3");
    s.noteRun({ id: "r3", status: "running" });
    expect(s.noteRun({ id: "r3", status: "failed" })).toBe(false);
    expect(useAiPanel.getState().badge).toBe(0);
  });

  it("takes a run off the badge when its own tab comes forward", () => {
    const s = useAiPanel.getState();
    for (const id of ["a", "b"]) {
      s.noteRun({ id, status: "running" });
      s.noteRun({ id, status: "awaiting_review" });
    }
    expect(useAiPanel.getState().badge).toBe(2);
    useAiTabs.getState().openRun("a");
    expect(useAiPanel.getState().badge).toBe(1);
    expect(useAiPanel.getState().unseen).toEqual(["b"]);
    // Opening it again changes nothing.
    useAiTabs.getState().open("chat");
    useAiTabs.getState().activate("run:a");
    expect(useAiPanel.getState().badge).toBe(1);
  });

  it("counts a run that finishes twice unseen once", () => {
    const s = useAiPanel.getState();
    s.noteRun({ id: "c", status: "running" });
    s.noteRun({ id: "c", status: "awaiting_input" });
    s.noteRun({ id: "c", status: "running" });
    s.noteRun({ id: "c", status: "done" });
    expect(useAiPanel.getState().badge).toBe(1);
  });

  it("the toast's Open clears its run even when the tab was already active behind the PDF", () => {
    useAiTabs.getState().openRun("d");
    useLayout.setState({ layout: "pdf" });
    const s = useAiPanel.getState();
    s.noteRun({ id: "d", status: "running" });
    expect(s.noteRun({ id: "d", status: "done" })).toBe(true);
    openRunTab("d");
    expect(useAiPanel.getState().badge).toBe(0);
    expect(useAiTabs.getState().active).toBe("run:d");
  });

  it("the button opens the one finished run, or the Agents tab for several", async () => {
    const s = useAiPanel.getState();
    s.noteRun({ id: "e", status: "running" });
    s.noteRun({ id: "e", status: "failed" });
    showFinished();
    expect(useAiTabs.getState().active).toBe("run:e");
    expect(useAiPanel.getState().badge).toBe(0);
    for (const id of ["f", "g"]) {
      s.noteRun({ id, status: "running" });
      s.noteRun({ id, status: "done" });
    }
    useAiTabs.getState().activate(null);
    // Still in view: the run tab hides nothing, so move to a file first.
    expect(useAiPanel.getState().badge).toBe(2);
    showFinished();
    await Promise.resolve();
    expect(useAiTabs.getState().active).toBe("agents");
    expect(useAiPanel.getState().badge).toBe(0);
  });

  it("rises while a tab is open but hidden behind the PDF", () => {
    useAiTabs.getState().open("agents");
    useLayout.setState({ layout: "pdf" });
    const s = useAiPanel.getState();
    s.noteRun({ id: "r4", status: "running" });
    expect(s.noteRun({ id: "r4", status: "done" })).toBe(true);
  });
});

describe("card density", () => {
  it("reads a saved density defensively, Summary by default", () => {
    expect(parseDensity("detailed")).toBe("detailed");
    expect(parseDensity("summary")).toBe("summary");
    expect(parseDensity("loud")).toBe("summary");
    expect(parseDensity(null)).toBe("summary");
  });

  it("keeps its key and survives without storage", () => {
    expect(DENSITY_KEY).toBe("texo.aiPanel.density");
    useAiPanel.getState().setDensity("detailed");
    expect(useAiPanel.getState().density).toBe("detailed");
    useAiPanel.getState().setDensity("summary");
    expect(useAiPanel.getState().density).toBe("summary");
  });
});
