import { beforeEach, describe, expect, it } from "vitest";
import {
  composersMounted,
  focusComposer,
  focusNotice,
  queueComposerText,
  registerComposer,
  shortcutNeedsEditor,
  takeComposerRequest,
  takeNoticeRequest,
  useComposerRequest,
} from "./composerFocus";

beforeEach(() => useComposerRequest.setState({ seq: 0, focus: false, text: null, notice: false }));

describe("asking the bar for focus", () => {
  it("waits until a bar takes it, then is gone", () => {
    focusComposer();
    expect(useComposerRequest.getState().seq).toBe(1);
    expect(takeComposerRequest("bar")).toEqual({ focus: true, text: null });
    expect(takeComposerRequest("bar")).toEqual({ focus: false, text: null });
  });

  it("keeps words for the ready bar while the setup line takes the focus", () => {
    focusComposer("Suggest a better title.");
    expect(takeComposerRequest("setup")).toEqual({ focus: true, text: null });
    expect(takeComposerRequest("bar")).toEqual({ focus: false, text: "Suggest a better title." });
  });

  it("keeps words picked while the privacy note is unread, without moving focus", () => {
    queueComposerText("Summarise my paper in five sentences.");
    expect(takeComposerRequest("setup").focus).toBe(false);
    expect(takeComposerRequest("bar").text).toBe("Summarise my paper in five sentences.");
  });

  it("asks the privacy note for focus once", () => {
    focusNotice();
    expect(takeNoticeRequest()).toBe(true);
    expect(takeNoticeRequest()).toBe(false);
  });
});

describe("Ctrl+J with no bar on screen", () => {
  const base = { shortcut: true, defaultPrevented: false, modal: false, mounted: 0, layout: "pdf" };

  it("brings the editor side back in the PDF only layout", () => {
    expect(shortcutNeedsEditor(base)).toBe(true);
  });

  it("leaves it to a bar that shows, an open dialog, or other keys", () => {
    expect(shortcutNeedsEditor({ ...base, mounted: 1 })).toBe(false);
    expect(shortcutNeedsEditor({ ...base, modal: true })).toBe(false);
    expect(shortcutNeedsEditor({ ...base, defaultPrevented: true })).toBe(false);
    expect(shortcutNeedsEditor({ ...base, shortcut: false })).toBe(false);
    expect(shortcutNeedsEditor({ ...base, layout: "split" })).toBe(false);
  });

  it("counts the bars listening, once each", () => {
    const before = composersMounted();
    const off = registerComposer();
    expect(composersMounted()).toBe(before + 1);
    off();
    off();
    expect(composersMounted()).toBe(before);
  });
});
