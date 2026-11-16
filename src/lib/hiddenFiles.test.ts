import { describe, expect, it } from "vitest";
import { isHiddenPath } from "./hiddenFiles";

describe("isHiddenPath", () => {
  it("keeps project files and .latexmkrc visible", () => {
    expect(isHiddenPath(".latexmkrc")).toBe(false);
    expect(isHiddenPath("figures/a.png")).toBe(false);
    expect(isHiddenPath("main.tex")).toBe(false);
    expect(isHiddenPath("refs.bib")).toBe(false);
  });

  it("hides dot-folders, build artifacts, temporary and system files", () => {
    expect(isHiddenPath(".git/x")).toBe(true);
    expect(isHiddenPath(".git")).toBe(true);
    expect(isHiddenPath("main.aux")).toBe(true);
    expect(isHiddenPath("main.synctex.gz")).toBe(true);
    expect(isHiddenPath("build/main.fdb_latexmk")).toBe(true);
    expect(isHiddenPath("a/.DS_Store")).toBe(true);
    expect(isHiddenPath("x.texo-tmp")).toBe(true);
    expect(isHiddenPath("figures/Thumbs.db")).toBe(true);
    expect(isHiddenPath("desktop.ini")).toBe(true);
  });
});
