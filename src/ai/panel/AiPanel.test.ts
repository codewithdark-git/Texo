// The right-hand AI panel is gone: Chat, Agents and runs open as editor
// tabs. Without a DOM this checks the wiring in the sources: the workspace
// has no panel column, hosts the AI tab view and the agent dialogs, and the
// AI button opens the Chat tab while still watching runs.
import { describe, expect, it } from "vitest";
import button from "./AiPanel.tsx?raw";
import workspace from "../../workspace/Workspace.tsx?raw";
import tabBar from "../../workspace/TabBar.tsx?raw";
import { buttonLabel } from "./AiPanel";

/** Without comments, so a mention in one doesn't count. */
const code = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").replace(/^\s*\/\/.*$/gm, "");

describe("no AI panel column", () => {
  it("the workspace has no panel, and its grid no column for one", () => {
    expect(code(workspace)).not.toMatch(/<AiPanel\b/);
    expect(code(button)).not.toMatch(/export function AiPanel\(/);
    expect(workspace).toMatch(/gridTemplateColumns: `\$\{column\}px 4px minmax\(0, 1fr\)`/);
  });

  it("the editor section shows the AI tab in front, keeping the editor mounted", () => {
    const src = code(workspace);
    expect(src).toMatch(/\{aiTab && <AiTabView project=\{project\.path\} tab=\{aiTab\} \/>\}/);
    expect(src).toMatch(/<div className=\{aiTab \? "hidden" : "contents"\}>\s*<EditorPane \/>/);
    expect(src).toMatch(/useAiTabsSync\(project\.id, project\.path, ready\)/);
    // The agent dialogs show over any tab.
    expect(src).toMatch(/<AgentDialogs project=\{project\.path\} \/>/);
  });

  it("the tab strip is one tablist for file and AI tabs", () => {
    const src = code(tabBar);
    expect(src.match(/role="tablist"/g)).toHaveLength(1);
    expect(src).toMatch(/stripTabs\(tabs, aiTabs\)/);
    expect(src).toMatch(/<AiTabLabel id=\{t\.id\} \/>/);
    // Roving tab stop, arrow keys.
    expect(src).toMatch(/tabIndex: i === selected \? 0 : -1/);
    expect(src).toMatch(/nextIndex\(e\.key/);
  });
});

describe("the AI button", () => {
  it("opens the Chat tab, or the finished work while the badge shows, and keeps the run watcher mounted", () => {
    const src = code(button);
    expect(src).toMatch(/onClick=\{\(\) => \(useAiPanel\.getState\(\)\.badge \? showFinished\(\) : useAiPanel\.getState\(\)\.show\("chat"\)\)\}/);
    expect(src).toMatch(/export function AiPanelButton[\s\S]*useRunWatcher\(project\)/);
  });

  it("is a plain button, not a toggle", () => {
    expect(code(button)).not.toMatch(/aria-pressed/);
  });

  it("the finish toast offers Open", () => {
    expect(code(button)).toMatch(/\{ label: "Open", run: \(\) => openRunTab\(run\.id\) \}/);
  });

  it("says where a click goes", () => {
    expect(buttonLabel(0)).toBe("AI chat");
    expect(buttonLabel(1)).toBe("1 task finished: open it");
    expect(buttonLabel(3)).toBe("3 tasks finished: open the Agents tab");
  });

  it("Ctrl+Shift+A opens the Chat tab too", () => {
    expect(code(workspace)).toMatch(/key === "a" && e\.shiftKey\) \{\s*handled\(\);\s*useAiPanel\.getState\(\)\.show\("chat"\)/);
  });
});
