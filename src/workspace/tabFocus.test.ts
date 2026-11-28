import { afterEach, describe, expect, it } from "vitest";
import { HOLD_MS, editorMayFocus, holdTabFocus, releaseTabFocus } from "./tabFocus";

describe("tab focus hold", () => {
  afterEach(() => releaseTabFocus());

  it("lets the editor focus when nothing asked to keep focus on the tabs", () => {
    expect(editorMayFocus(true, 1000)).toBe(true);
    expect(editorMayFocus(false, 1000)).toBe(true);
  });

  it("keeps focus on the tabs after an arrow key, while focus is still there", () => {
    holdTabFocus(1000);
    expect(editorMayFocus(true, 1000 + 10)).toBe(false);
    // Focus moved elsewhere already: the editor may take it.
    expect(editorMayFocus(false, 1000 + 10)).toBe(true);
  });

  it("wears off after a while", () => {
    holdTabFocus(1000);
    expect(editorMayFocus(true, 1000 + HOLD_MS + 1)).toBe(true);
  });

  it("is released by showing a tab another way", () => {
    holdTabFocus(1000);
    releaseTabFocus();
    expect(editorMayFocus(true, 1001)).toBe(true);
  });
});
