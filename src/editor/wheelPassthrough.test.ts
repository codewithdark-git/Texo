import { describe, expect, it } from "vitest";
import { canScrollFurther, editorWheelPixels, wheelPixels } from "./wheelPassthrough";

describe("editorWheelPixels", () => {
  const size = { width: 800, height: 600 };
  it("moves as far as Monaco does for the same wheel", () => {
    // One mouse-wheel notch in Chromium: deltaY 100, wheelDeltaY -120 → Monaco scrolls 50px.
    expect(editorWheelPixels({ deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaX: 0, wheelDeltaY: -120 }, 22, size)).toEqual({ x: 0, y: 50 });
    expect(editorWheelPixels({ deltaX: 0, deltaY: -100, deltaMode: 0, wheelDeltaY: 120 }, 22, size).y).toBe(-50);
    // No legacy delta: the pixel delta, scaled the same way.
    expect(editorWheelPixels({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 22, size).y).toBeCloseTo(50);
    expect(editorWheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 22, size).y).toBe(66);
  });
});

const box = (scrollTop: number, scrollHeight: number, clientHeight = 100, scrollLeft = 0, scrollWidth = 100, clientWidth = 100) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
  scrollLeft,
  scrollWidth,
  clientWidth,
});

describe("canScrollFurther", () => {
  it("is false for a popup with nothing to scroll", () => {
    expect(canScrollFurther(box(0, 100), 0, 50)).toBe(false);
    expect(canScrollFurther(box(0, 100), 0, -50)).toBe(false);
  });

  it("keeps the wheel in a scrollable popup until it reaches its end", () => {
    expect(canScrollFurther(box(0, 300), 0, 50)).toBe(true);
    expect(canScrollFurther(box(0, 300), 0, -50)).toBe(false);
    expect(canScrollFurther(box(100, 300), 0, -50)).toBe(true);
    expect(canScrollFurther(box(200, 300), 0, 50)).toBe(false);
    expect(canScrollFurther(box(199.5, 300), 0, 50)).toBe(false);
  });

  it("follows the dominant axis", () => {
    expect(canScrollFurther(box(0, 100, 100, 0, 400), 60, 5)).toBe(true);
    expect(canScrollFurther(box(0, 100, 100, 300, 400), 60, 5)).toBe(false);
    expect(canScrollFurther(box(0, 100, 100, 0, 400), 0, 60)).toBe(false);
  });
});

describe("wheelPixels", () => {
  it("converts line and page deltas", () => {
    expect(wheelPixels(40, 0, 22, 600)).toBe(40);
    expect(wheelPixels(3, 1, 22, 600)).toBe(66);
    expect(wheelPixels(-1, 2, 22, 600)).toBe(-600);
  });
});
