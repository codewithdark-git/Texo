import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyMotion, presenceAfter, resolveMotion, usePresence } from "./motion";

describe("resolveMotion", () => {
  it("follows the system when the setting is Match system", () => {
    expect(resolveMotion("system", true)).toBe("reduce");
    expect(resolveMotion("system", false)).toBe("full");
  });

  it("reduces motion when asked, whatever the system says", () => {
    expect(resolveMotion("reduce", false)).toBe("reduce");
    expect(resolveMotion("reduce", true)).toBe("reduce");
  });

  it("keeps full motion when asked, even if the system asks for less", () => {
    expect(resolveMotion("full", true)).toBe("full");
    expect(resolveMotion("full", false)).toBe("full");
  });
});

describe("applyMotion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts a forced choice on <html> and leaves Match system to the media query", () => {
    const dataset: Record<string, string> = {};
    vi.stubGlobal("document", { documentElement: { dataset } });
    applyMotion("reduce");
    expect(dataset.motion).toBe("reduce");
    applyMotion("full");
    expect(dataset.motion).toBe("full");
    applyMotion("system");
    expect("motion" in dataset).toBe(false);
  });

  it("does nothing without a page", () => {
    expect(() => applyMotion("reduce")).not.toThrow();
  });
});

describe("usePresence", () => {
  it("keeps the element mounted for its exit, and only then removes it", () => {
    expect(presenceAfter(true, false)).toEqual({ mounted: true, state: "enter", waitForExit: false });
    // Closing something on screen plays the exit first.
    expect(presenceAfter(false, true)).toEqual({ mounted: true, state: "exit", waitForExit: true });
    // Closing something already gone has nothing to wait for.
    expect(presenceAfter(false, false)).toEqual({ mounted: false, state: "exit", waitForExit: false });
  });

  it("renders an open element at once, in its enter state", () => {
    function Probe({ open }: { open: boolean }) {
      const { mounted, state } = usePresence(open, 200);
      return mounted ? createElement("div", { "data-state": state }) : null;
    }
    expect(renderToStaticMarkup(createElement(Probe, { open: true }))).toBe('<div data-state="enter"></div>');
    expect(renderToStaticMarkup(createElement(Probe, { open: false }))).toBe("");
  });
});
