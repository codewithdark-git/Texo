import { describe, expect, it } from "vitest";
import { PATH_DROP_ATTR, registerPathDrop, routeDrop } from "./pathDrop";

/** An element that sits inside the given ancestors (selector → attributes). */
function el(ancestors: Record<string, Record<string, string>>) {
  return {
    closest(selector: string) {
      const attrs = ancestors[selector];
      return attrs ? { getAttribute: (name: string) => attrs[name] ?? null } : null;
    },
  };
}

describe("routing file-manager drops (FE-2)", () => {
  it("sends drops on the New task dialog to its handler", () => {
    const got: string[][] = [];
    const off = registerPathDrop("task-1", (paths) => got.push(paths));
    const target = el({ [`[${PATH_DROP_ATTR}]`]: { [PATH_DROP_ATTR]: "task-1" }, '[aria-modal="true"]': {} });
    const route = routeDrop(target);
    expect(typeof route).toBe("function");
    if (typeof route === "function") route(["C:\\Users\\me\\plot.png"]);
    expect(got).toEqual([["C:\\Users\\me\\plot.png"]]);

    // Once the dialog closes, a drop there is no longer the dialog's.
    off();
    expect(routeDrop(target)).toBe("blocked");
  });

  it("refuses drops on other dialogs instead of importing them", () => {
    expect(routeDrop(el({ '[aria-modal="true"]': {} }))).toBe("blocked");
  });

  it("leaves drops on the workspace to the file tree import", () => {
    expect(routeDrop(el({}))).toBeNull();
    expect(routeDrop(null)).toBeNull();
  });
});
