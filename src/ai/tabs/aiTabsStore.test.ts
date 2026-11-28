import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aiTabsKey,
  cycleTab,
  EMPTY_TABS,
  isAiTabId,
  MAX_SAVED_TABS,
  openPapersTab,
  parseAiTabs,
  runIdOf,
  runTabId,
  runTabKeeper,
  stripTabs,
  useAiTabs,
  withoutRuns,
  withoutTab,
  withTab,
  type AiTabId,
} from "./aiTabsStore";
import { useLayout } from "../../workspace/layoutStore";
import { useRunFocus } from "../agents/focusStore";
import { useAiPanel } from "../panel/aiPanelStore";
import tabView from "./AiTabView.tsx?raw";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});

const tabs = useAiTabs.getState;

beforeEach(() => {
  store.clear();
  useAiTabs.getState().reset();
  useLayout.setState({ layout: "split" });
});

describe("tab ids", () => {
  it("names Chat, Agents and one tab per run", () => {
    expect(runTabId("abc")).toBe("run:abc");
    expect(runIdOf("run:abc")).toBe("abc");
    expect(runIdOf("chat")).toBeNull();
    expect(isAiTabId("agents")).toBe(true);
    expect(isAiTabId("run:0f3a")).toBe(true);
    expect(isAiTabId("run:")).toBe(false);
    expect(isAiTabId("files")).toBe(false);
    expect(isAiTabId(3)).toBe(false);
  });
});

describe("saved tabs", () => {
  it("reads them defensively", () => {
    expect(parseAiTabs('{"tabs":["chat","run:r1","nope","chat"],"active":"run:r1"}')).toEqual({ tabs: ["chat", "run:r1"], active: "run:r1" });
    // An active tab that isn't open is no tab.
    expect(parseAiTabs('{"tabs":["chat"],"active":"agents"}')).toEqual({ tabs: ["chat"], active: null });
    expect(parseAiTabs("not json")).toEqual(EMPTY_TABS);
    expect(parseAiTabs(null)).toEqual(EMPTY_TABS);
    expect(parseAiTabs('{"tabs":"chat"}')).toEqual(EMPTY_TABS);
  });

  it("keeps at most MAX_SAVED_TABS, dropping the oldest run tabs first", () => {
    const many = ["chat", ...Array.from({ length: MAX_SAVED_TABS + 2 }, (_, i) => `run:r${i}`)];
    const read = parseAiTabs(JSON.stringify({ tabs: many, active: "chat" }));
    expect(read.tabs).toHaveLength(MAX_SAVED_TABS);
    expect(read.tabs[0]).toBe("chat");
    expect(read.tabs).not.toContain("run:r0");
    expect(read.tabs).toContain(`run:r${MAX_SAVED_TABS + 1}`);
  });

  it("are remembered per project, with the tab in front", () => {
    tabs().load("p1");
    tabs().open("chat");
    useRunFocus.getState().focus("r1");
    expect(JSON.parse(store.get(aiTabsKey("p1"))!)).toEqual({ tabs: ["chat", "run:r1"], active: "run:r1" });

    // Another project starts with its own (none).
    tabs().reset();
    tabs().load("p2");
    expect(tabs().tabs).toEqual([]);
    tabs().open("agents");

    tabs().reset();
    tabs().load("p1");
    expect(tabs().tabs).toEqual(["chat", "run:r1"]);
    expect(tabs().active).toBe("run:r1");
    expect(JSON.parse(store.get(aiTabsKey("p2"))!).tabs).toEqual(["agents"]);
  });
});

describe("opening and closing", () => {
  it("opens a tab once and brings it forward", () => {
    let s = withTab(EMPTY_TABS, "chat");
    s = withTab(s, "agents");
    s = withTab(s, "chat");
    expect(s).toEqual({ tabs: ["chat", "agents"], active: "chat" });
  });

  it("gives the editor area to the right-hand neighbour, else the left, else the last file", () => {
    const s = { tabs: ["chat", "agents", "run:r1"] as AiTabId[], active: "agents" as AiTabId };
    expect(withoutTab(s, "agents").next).toEqual({ kind: "ai", id: "run:r1" });
    expect(withoutTab({ ...s, active: "run:r1" }, "run:r1").next).toEqual({ kind: "ai", id: "agents" });
    const last = withoutTab({ tabs: ["chat"], active: "chat" }, "chat", ["a.tex", "b.tex"]);
    expect(last).toEqual({ state: { tabs: [], active: null }, next: { kind: "file", path: "b.tex" } });
    // A tab behind another closes without changing what shows.
    expect(withoutTab(s, "chat")).toEqual({ state: { tabs: ["agents", "run:r1"], active: "agents" }, next: { kind: "none" } });
    expect(withoutTab(s, "run:zz").state).toBe(s);
  });

  it("puts the editor side back when the PDF fills the window", () => {
    useLayout.setState({ layout: "pdf" });
    tabs().open("chat");
    expect(useLayout.getState().layout).toBe("split");
  });

  it("activate(null) shows the file; an unknown tab can't come forward", () => {
    tabs().open("chat");
    tabs().activate("agents");
    expect(tabs().active).toBe("chat");
    tabs().activate(null);
    expect(tabs().active).toBeNull();
    expect(tabs().tabs).toEqual(["chat"]);
  });
});

describe("the Papers tab", () => {
  it("is a tab id of its own, named Papers, with no run", () => {
    expect(isAiTabId("papers")).toBe(true);
    expect(runIdOf("papers")).toBeNull();
    // AiTabView pulls in the editor, so its label and icon are read from the source.
    expect(tabView).toContain('if (id === "papers") return "Papers";');
    expect(tabView).toMatch(/id === "papers" \? \(\s*<BookOpen /);
  });

  it("opens once, and a second open brings it forward", () => {
    tabs().load("p1");
    tabs().open("chat");
    openPapersTab();
    expect(tabs()).toMatchObject({ tabs: ["chat", "papers"], active: "papers" });
    tabs().activate("chat");
    openPapersTab();
    expect(tabs()).toMatchObject({ tabs: ["chat", "papers"], active: "papers" });
  });

  it("is remembered per project", () => {
    tabs().load("p1");
    openPapersTab();
    expect(JSON.parse(store.get(aiTabsKey("p1"))!)).toEqual({ tabs: ["papers"], active: "papers" });
    tabs().reset();
    tabs().load("p1");
    expect(tabs()).toMatchObject({ tabs: ["papers"], active: "papers" });
    expect(parseAiTabs('{"tabs":["papers","chat"],"active":"papers"}')).toEqual({ tabs: ["papers", "chat"], active: "papers" });
  });

  it("closes like Chat, and isn't closed with the runs", () => {
    const s = { tabs: ["papers", "run:r1"] as AiTabId[], active: "papers" as AiTabId };
    expect(withoutTab(s, "papers").next).toEqual({ kind: "ai", id: "run:r1" });
    expect(withoutTab({ tabs: ["papers"], active: "papers" }, "papers", ["a.tex"]).next).toEqual({ kind: "file", path: "a.tex" });
    expect(withoutRuns(s, () => false)).toEqual({ tabs: ["papers"], active: "papers" });
  });

  it("puts the editor side back when the PDF fills the window", () => {
    useLayout.setState({ layout: "pdf" });
    openPapersTab();
    expect(useLayout.getState().layout).toBe("split");
  });

  it("shows the library in a centred column", () => {
    expect(tabView).toMatch(/tab === "papers" \? \(\s*<PapersTab project=\{project\} \/>/);
    expect(tabView).toContain("<LibraryPanel project={project} />");
    expect(tabView).toMatch(/max-w-3xl/);
  });
});

describe("the contract other parts rely on", () => {
  it('show("chat") and show("agents") open those tabs', () => {
    useAiPanel.getState().show("chat");
    expect(tabs()).toMatchObject({ tabs: ["chat"], active: "chat" });
    useAiPanel.getState().show("agents");
    expect(tabs()).toMatchObject({ tabs: ["chat", "agents"], active: "agents" });
  });

  it("focus(runId) opens that run's tab", () => {
    useRunFocus.getState().focus("r7");
    expect(tabs()).toMatchObject({ tabs: ["run:r7"], active: "run:r7" });
    useRunFocus.getState().focus("r7");
    expect(tabs().tabs).toEqual(["run:r7"]);
  });

  it('show("agents") followed at once by focus(run) opens only the run\'s tab', async () => {
    useAiPanel.getState().show("agents");
    useRunFocus.getState().focus("r1");
    expect(tabs()).toMatchObject({ tabs: ["run:r1"], active: "run:r1" });
    // An Agents tab that was open already stays.
    useAiPanel.getState().show("agents");
    await Promise.resolve();
    useAiPanel.getState().show("agents");
    useRunFocus.getState().focus("r2");
    expect(tabs().tabs).toEqual(["run:r1", "agents", "run:r2"]);
    // Later, the two are separate requests.
    tabs().reset();
    useAiPanel.getState().show("agents");
    await Promise.resolve();
    useRunFocus.getState().focus("r3");
    expect(tabs().tabs).toEqual(["agents", "run:r3"]);
  });
});

describe("run tabs follow the runs", () => {
  const runs = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, {}]));

  it("close when their run is deleted, or missing from a fresh list", () => {
    const s = { tabs: ["chat", "run:a", "run:b"] as AiTabId[], active: "run:b" as AiTabId };
    // Deleted: a was listed and is gone.
    const deleted = runTabKeeper({ project: "P", runs: runs("a", "b"), loading: false }, { project: "P", runs: runs("b"), loading: false }, "P");
    expect(withoutRuns(s, deleted!)).toEqual({ tabs: ["chat", "run:b"], active: "run:b" });
    // A run not seen yet (just started) keeps its tab until a list says otherwise.
    const added = runTabKeeper({ project: "P", runs: runs("a"), loading: false }, { project: "P", runs: runs("b"), loading: false }, "P");
    expect(added!("c")).toBe(true);
    const listed = runTabKeeper({ project: "P", runs: {}, loading: true }, { project: "P", runs: runs("a"), loading: false, error: null }, "P");
    expect(withoutRuns(s, listed!)).toEqual({ tabs: ["chat", "run:a"], active: "run:a" });
    // Nothing gone, another project, or a failed list: keep everything.
    expect(runTabKeeper({ project: "P", runs: runs("a"), loading: false }, { project: "P", runs: runs("a", "b"), loading: false }, "P")).toBeNull();
    expect(runTabKeeper({ project: "Q", runs: runs("a"), loading: false }, { project: "P", runs: {}, loading: false }, "P")).toBeNull();
    expect(runTabKeeper({ project: "P", runs: {}, loading: true }, { project: "P", runs: {}, loading: false, error: "offline" }, "P")).toBeNull();
    expect(withoutRuns(s, () => true)).toBe(s);
  });

  it("a closed run tab in front gives way to the tab before it", () => {
    const s = { tabs: ["chat", "run:a"] as AiTabId[], active: "run:a" as AiTabId };
    expect(withoutRuns(s, () => false)).toEqual({ tabs: ["chat"], active: "chat" });
    expect(withoutRuns({ tabs: ["run:a"], active: "run:a" }, () => false)).toEqual({ tabs: [], active: null });
  });
});

describe("one strip with the file tabs", () => {
  it("lists files, then AI tabs, and Ctrl+Tab goes through both", () => {
    const ai = { tabs: ["chat", "run:r1"] as AiTabId[], active: null };
    expect(stripTabs(["a.tex"], ai.tabs)).toEqual([
      { kind: "file", path: "a.tex" },
      { kind: "ai", id: "chat" },
      { kind: "ai", id: "run:r1" },
    ]);
    expect(cycleTab(["a.tex", "b.tex"], "b.tex", ai, false)).toEqual({ kind: "ai", id: "chat" });
    expect(cycleTab(["a.tex"], "a.tex", { ...ai, active: "run:r1" }, false)).toEqual({ kind: "file", path: "a.tex" });
    expect(cycleTab(["a.tex"], "a.tex", { ...ai, active: "chat" }, true)).toEqual({ kind: "file", path: "a.tex" });
    expect(cycleTab(["a.tex"], "a.tex", EMPTY_TABS, false)).toBeNull();
  });
});
