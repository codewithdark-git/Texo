// Static markup of the sidebar footer: Papers as its first row, full and in
// the folded rail, with the saved count when known; a click opens the Papers
// editor tab. A server render reads the stores' first state, so the row's
// states are checked on PapersRow.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PapersRow, SidebarFooter } from "./SidebarFooter";
import footerSource from "./SidebarFooter.tsx?raw";

const render = (compact: boolean) => renderToStaticMarkup(createElement(SidebarFooter, { project: "C:/p", compact }));
const row = (p: Partial<{ compact: boolean; inFront: boolean; saved: number | null }> = {}) =>
  renderToStaticMarkup(createElement(PapersRow, { compact: false, inFront: false, saved: null, ...p }));

describe("SidebarFooter", () => {
  it("starts with Papers, then the tasks, Support and Project settings", () => {
    for (const compact of [false, true]) {
      const html = render(compact);
      const at = (label: string) => html.indexOf(`aria-label="${label}"`);
      expect(at("Papers"), `compact=${compact}`).toBeGreaterThanOrEqual(0);
      expect(at("Papers")).toBeLessThan(at("Support Texo"));
      expect(at("Support Texo")).toBeLessThan(at("Project settings"));
    }
    expect(footerSource.indexOf("<PapersFooterButton")).toBeLessThan(footerSource.indexOf("<AgentTasksDock"));
  });

  it("shows the label in full and only the icon, with a tooltip, in the rail", () => {
    expect(render(false)).toContain(">Papers</span>");
    const rail = row({ compact: true });
    expect(rail).toContain('aria-label="Papers"');
    expect(rail).not.toContain(">Papers</span>");
    expect(rail).toContain("w-8 justify-center");
    expect(footerSource).toMatch(/<Tooltip content="Papers" side="right">/);
  });

  it("shows the saved count when known, never in the rail", () => {
    expect(row()).not.toContain("saved paper");
    expect(row({ saved: 0 })).not.toContain("saved paper");
    const full = row({ saved: 12 });
    expect(full).toContain('title="12 saved papers"');
    expect(full).toContain(">12</span>");
    expect(row({ saved: 1 })).toContain('title="1 saved paper"');
    expect(row({ compact: true, saved: 12 })).not.toContain(">12<");
  });

  it("marks the row while the Papers tab is in front", () => {
    expect(row()).not.toContain('aria-current="page"');
    expect(row({ inFront: true })).toContain('aria-current="page"');
  });

  it("opens the Papers editor tab on click, fed by the tabs and the library", () => {
    expect(footerSource).toMatch(/onClick=\{openPapersTab\}/);
    expect(footerSource).toContain('useAiTabs((s) => s.active === "papers")');
    expect(footerSource).toContain("s.status.saved");
  });
});
