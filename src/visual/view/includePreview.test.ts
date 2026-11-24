import { describe, expect, it, vi } from "vitest";

// The workspace and backend aren't needed for the path rules.
vi.mock("../../workspace/store", () => ({ getModel: () => undefined, useWorkspace: { getState: () => ({ project: null, files: [] }) } }));
vi.mock("../../lib/api", () => ({ api: {} }));

import { displayName, mayInline, MAX_INCLUDE_DEPTH, resolveInclude, safeTarget } from "./includePreview";

describe("safeTarget", () => {
  it("keeps project-relative names", () => {
    expect(safeTarget("sec_intro")).toBe("sec_intro");
    expect(safeTarget("./chapters/one.tex")).toBe("chapters/one.tex");
    expect(safeTarget("chapters\\two")).toBe("chapters/two");
    expect(safeTarget(' "spaced name" ')).toBe("spaced name");
  });

  it("refuses anything that leaves the project", () => {
    for (const t of ["../secret", "a/../../b", "/etc/passwd", "C:/Windows/x", "c:\\x", "~/notes", "", "\\macro", "{x}"]) {
      expect(safeTarget(t)).toBeNull();
    }
  });
});

describe("resolveInclude", () => {
  const files = ["main.tex", "sec_intro.tex", "chapters/one.tex", "chapters/two.tex", "chapters/fig.tex", "paper/main.tex", "paper/body.tex"];

  it("finds files with or without .tex", () => {
    expect(resolveInclude("sec_intro", "main.tex", "main.tex", files)).toBe("sec_intro.tex");
    expect(resolveInclude("sec_intro.tex", "main.tex", "main.tex", files)).toBe("sec_intro.tex");
    expect(resolveInclude("chapters/one", "main.tex", "main.tex", files)).toBe("chapters/one.tex");
  });

  it("looks beside the main document first, then the including file", () => {
    expect(resolveInclude("body", "paper/main.tex", "paper/main.tex", files)).toBe("paper/body.tex");
    expect(resolveInclude("two", "chapters/one.tex", "main.tex", files)).toBe("chapters/two.tex");
  });

  it("returns null for missing files and unsafe targets", () => {
    expect(resolveInclude("nope", "main.tex", "main.tex", files)).toBeNull();
    expect(resolveInclude("../main", "chapters/one.tex", "main.tex", files)).toBeNull();
  });
});

describe("include chains", () => {
  it("stops at the depth limit and on cycles", () => {
    expect(mayInline({ depth: 0, files: ["main.tex"] }, "a.tex")).toBe("ok");
    expect(mayInline({ depth: MAX_INCLUDE_DEPTH, files: ["main.tex"] }, "a.tex")).toBe("deep");
    expect(mayInline({ depth: 1, files: ["main.tex", "a.tex"] }, "main.tex")).toBe("cycle");
  });

  it("names targets as files", () => {
    expect(displayName("sec_intro")).toBe("sec_intro.tex");
    expect(displayName("chapters/one.tex")).toBe("one.tex");
  });
});
