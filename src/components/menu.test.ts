import { describe, expect, it } from "vitest";
import { dropdownPlace, menuKeyTarget, scrollMovesTrigger } from "./Menu";

const view = { width: 1000, height: 800 };
const widths = { maxWidth: 992, minWidth: 208 };

describe("dropdownPlace", () => {
  it("opens under the trigger, lined up with its right edge", () => {
    const p = dropdownPlace({ top: 100, bottom: 124, left: 900, right: 924 }, view, "right", 120);
    expect(p.side).toBe("bottom");
    expect(p.style).toEqual({ top: 128, right: 76, ...widths });
  });

  it("lines up with the left edge when asked", () => {
    expect(dropdownPlace({ top: 100, bottom: 124, left: 40, right: 64 }, view, "left", 120).style).toEqual({ top: 128, left: 40, ...widths });
  });

  it("opens upward when there is no room below", () => {
    const p = dropdownPlace({ top: 700, bottom: 724, left: 900, right: 924 }, view, "right", 150);
    expect(p.side).toBe("top");
    expect(p.style).toEqual({ bottom: 104, right: 76, ...widths });
  });

  it("never sticks out past the window edge", () => {
    expect(dropdownPlace({ top: 10, bottom: 30, left: -20, right: 0 }, view, "left", 50).style.left).toBe(4);
    expect(dropdownPlace({ top: 10, bottom: 30, left: 990, right: 1010 }, view, "right", 50).style.right).toBe(4);
  });

  it("stays narrower than a small window", () => {
    const s = dropdownPlace({ top: 10, bottom: 30, left: 10, right: 30 }, { width: 180, height: 400 }, "left", 50).style;
    expect(s.maxWidth).toBe(172);
    expect(s.minWidth).toBe(172);
  });
});

describe("menuKeyTarget", () => {
  it("moves down and up, wrapping at the ends", () => {
    expect(menuKeyTarget("ArrowDown", 0, 3)).toBe(1);
    expect(menuKeyTarget("ArrowDown", 2, 3)).toBe(0);
    expect(menuKeyTarget("ArrowUp", 0, 3)).toBe(2);
    expect(menuKeyTarget("ArrowUp", 2, 3)).toBe(1);
  });

  it("starts from the first or last item when none has focus", () => {
    expect(menuKeyTarget("ArrowDown", -1, 3)).toBe(0);
    expect(menuKeyTarget("ArrowUp", -1, 3)).toBe(2);
  });

  it("jumps to the ends with Home and End", () => {
    expect(menuKeyTarget("Home", 1, 3)).toBe(0);
    expect(menuKeyTarget("End", 1, 3)).toBe(2);
  });

  it("ignores other keys and empty menus", () => {
    expect(menuKeyTarget("a", 0, 3)).toBeNull();
    expect(menuKeyTarget("ArrowDown", -1, 0)).toBeNull();
  });
});

describe("scrollMovesTrigger", () => {
  const node = (kids: object[] = []) => {
    const n = { contains: (o: unknown): boolean => o === n || kids.some((k) => (k as { contains: (o: unknown) => boolean }).contains(o)) };
    return n;
  };

  it("closes for a scroll of an element that holds the trigger", () => {
    const trigger = node();
    const panel = node([trigger]);
    expect(scrollMovesTrigger(panel as unknown as EventTarget, trigger as unknown as Node)).toBe(true);
  });

  it("leaves the menu open for a scroll somewhere else", () => {
    const trigger = node();
    const log = node();
    expect(scrollMovesTrigger(log as unknown as EventTarget, trigger as unknown as Node)).toBe(false);
    expect(scrollMovesTrigger(null, trigger as unknown as Node)).toBe(false);
    expect(scrollMovesTrigger({} as EventTarget, trigger as unknown as Node)).toBe(false);
  });
});
