import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nextIndex, Tabs, TabPanel } from "./Tabs";
import { SegmentedControl } from "./SegmentedControl";
import { ProgressRing, ringGeometry } from "./ProgressRing";
import { ProgressBar } from "./ProgressBar";
import { StatusDot } from "./StatusDot";
import { Popover } from "./Popover";
import { Kbd } from "./Kbd";
import { toast, useUi, TOAST_EXIT_MS } from "../../ui";

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("Tabs", () => {
  it("nextIndex moves with the arrows, wrapping at the ends, and jumps with Home and End", () => {
    expect(nextIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextIndex("ArrowLeft", 1, 3)).toBe(0);
    expect(nextIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextIndex("Home", 2, 3)).toBe(0);
    expect(nextIndex("End", 0, 3)).toBe(2);
    expect(nextIndex("Enter", 0, 3)).toBeNull();
    expect(nextIndex("ArrowRight", 0, 0)).toBeNull();
  });

  const items = [
    { id: "files", label: "Files" },
    { id: "outline", label: "Outline" },
    { id: "search", label: "Search" },
  ];

  it("renders a tablist with one selected tab, the others out of the Tab order", () => {
    const html = renderToStaticMarkup(createElement(Tabs, { label: "Sidebar", items, value: "outline", onChange: () => {}, idPrefix: "side" }));
    expect(html).toContain('role="tablist"');
    expect(count(html, 'role="tab"')).toBe(3);
    expect(count(html, 'aria-selected="true"')).toBe(1);
    expect(count(html, 'tabindex="-1"')).toBe(2);
    expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"[^>]*>.*?Outline/);
    expect(html).toContain('aria-controls="side-panel-outline"');
  });

  it("names icon-only tabs for screen readers", () => {
    const html = renderToStaticMarkup(createElement(Tabs, { label: "Sidebar", items, value: "files", onChange: () => {}, idPrefix: "side", iconOnly: true }));
    expect(html).toContain('aria-label="Search"');
    expect(count(html, 'aria-selected="true"')).toBe(1);
  });

  it("keeps hidden panels mounted and linked to their tab", () => {
    const html = renderToStaticMarkup(createElement(TabPanel, { idPrefix: "side", id: "search", active: false, children: "results" }));
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="side-tab-search"');
    expect(html).toContain("hidden");
    expect(html).toContain("results");
  });
});

describe("SegmentedControl", () => {
  it("is a radio group with one checked option in the Tab order", () => {
    const html = renderToStaticMarkup(
      createElement(SegmentedControl, {
        label: "Layout",
        value: "split",
        onChange: () => {},
        options: [
          { value: "code", label: "Code" },
          { value: "split", label: "Split" },
          { value: "pdf", label: "PDF" },
        ],
      }),
    );
    expect(html).toContain('role="radiogroup"');
    expect(count(html, 'aria-checked="true"')).toBe(1);
    expect(count(html, 'tabindex="-1"')).toBe(2);
  });
});

describe("ProgressRing", () => {
  it("shows a known value with aria-valuenow and the matching arc", () => {
    const html = renderToStaticMarkup(createElement(ProgressRing, { value: 0.25, size: 16, stroke: 2 }));
    const r = 7;
    const c = 2 * Math.PI * r;
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="25"');
    const offset = Number(/stroke-dashoffset="([\d.]+)"/.exec(html)?.[1]);
    expect(offset).toBeCloseTo(c * 0.75, 2);
    expect(html).not.toContain("texo-ring-indeterminate");
  });

  it("spins, with no aria-valuenow, when the value isn't known", () => {
    const html = renderToStaticMarkup(createElement(ProgressRing, {}));
    expect(html).toContain("texo-ring-indeterminate");
    expect(html).not.toContain("aria-valuenow");
  });

  it("clamps values outside 0..1", () => {
    expect(ringGeometry(16, 2, 1.5).offset).toBe(0);
    expect(ringGeometry(16, 2, -1).offset).toBe(ringGeometry(16, 2, 0).c);
  });
});

describe("the other primitives", () => {
  it("ProgressBar reports k of n", () => {
    const html = renderToStaticMarkup(createElement(ProgressBar, { value: 3, max: 12, label: "Checking citations" }));
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('aria-valuetext="3 of 12"');
    expect(renderToStaticMarkup(createElement(ProgressBar, {}))).toContain("texo-bar-indeterminate");
  });

  it("StatusDot is hidden from screen readers unless it has a label", () => {
    expect(renderToStaticMarkup(createElement(StatusDot, { tone: "warning", pulse: true }))).toMatch(/aria-hidden="true".*texo-pulse-dot/);
    expect(renderToStaticMarkup(createElement(StatusDot, { tone: "danger", label: "Failed" }))).toContain('aria-label="Failed"');
  });

  it("Popover renders only its trigger while closed, and a labelled panel while open", () => {
    const trigger = createElement("button", { type: "button" }, "Open");
    const closed = renderToStaticMarkup(createElement(Popover, { open: false, onOpenChange: () => {}, trigger, label: "Chats", children: "list" }));
    expect(closed).not.toContain('role="dialog"');
    const open = renderToStaticMarkup(createElement(Popover, { open: true, onOpenChange: () => {}, trigger, label: "Chats", width: 420, children: "list" }));
    expect(open).toContain('role="dialog"');
    expect(open).toContain('aria-label="Chats"');
    expect(open).toContain("texo-menu");
    expect(open).toContain('data-side="bottom"');
  });

  it("Kbd draws a key cap", () => {
    expect(renderToStaticMarkup(createElement(Kbd, { children: "Ctrl+P" }))).toMatch(/^<kbd[^>]*>Ctrl\+P<\/kbd>$/);
  });
});

describe("toast", () => {
  afterEach(() => {
    vi.useRealTimers();
    useUi.setState({ toasts: [] });
  });

  it("keeps its old call shapes, so existing callers still work", () => {
    toast("Saved");
    toast("Couldn't save", "error");
    const [saved, failed] = useUi.getState().toasts;
    expect(saved).toMatchObject({ text: "Saved", kind: "success" });
    expect(saved.action).toBeUndefined();
    expect(failed).toMatchObject({ text: "Couldn't save", kind: "error" });
    // The type is unchanged for those callers: two optional-kind arguments still compile.
    const caller: (text: string, kind?: "success" | "info" | "error") => void = toast;
    expect(typeof caller).toBe("function");
  });

  it("can carry a button", () => {
    const run = vi.fn();
    toast("File deleted", "info", { label: "Undo", run });
    const [t] = useUi.getState().toasts;
    expect(t.action?.label).toBe("Undo");
    t.action!.run();
    expect(run).toHaveBeenCalledOnce();
  });

  it("plays an exit before it goes, and waits while hovered", () => {
    vi.useFakeTimers();
    toast("Saved");
    const id = useUi.getState().toasts[0].id;
    useUi.getState().pauseToast(id);
    vi.advanceTimersByTime(10_000);
    expect(useUi.getState().toasts[0].leaving).toBeFalsy();
    useUi.getState().resumeToast(id);
    vi.advanceTimersByTime(3_600);
    expect(useUi.getState().toasts[0].leaving).toBe(true);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(useUi.getState().toasts).toHaveLength(0);
  });

  it("stays while focus is in it, even after the pointer leaves", () => {
    vi.useFakeTimers();
    toast("Saved");
    const id = useUi.getState().toasts[0].id;
    const { pauseToast, resumeToast } = useUi.getState();
    pauseToast(id, "hover");
    pauseToast(id, "focus");
    resumeToast(id, "hover");
    vi.advanceTimersByTime(10_000);
    expect(useUi.getState().toasts[0].leaving).toBeFalsy();
    resumeToast(id, "focus");
    vi.advanceTimersByTime(3_600);
    expect(useUi.getState().toasts[0].leaving).toBe(true);
  });
});
