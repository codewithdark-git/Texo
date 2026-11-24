import { describe, expect, it } from "vitest";
import { closestKeys, editDistance, loadsPackage, packageFor, usepackageInsertLine } from "./quickFixes";

describe("closestKeys", () => {
  it("measures edits", () => {
    expect(editDistance("knuth84", "knuth1984")).toBe(2);
    expect(editDistance("Lamport", "lamport")).toBe(0);
  });

  it("returns the nearest plausible keys, never the key itself", () => {
    const keys = ["knuth1984", "knuth84a", "lamport94", "knuth84", "smith2020", "knuth84b"];
    expect(closestKeys("knuth84", keys)).toEqual(["knuth84a", "knuth84b", "knuth1984"]);
    expect(closestKeys("fig:plot", ["fig:plots", "tab:data"])).toEqual(["fig:plots"]);
    expect(closestKeys("zzz", keys)).toEqual([]);
  });
});

describe("packages", () => {
  it("knows common commands", () => {
    expect(packageFor("\\includegraphics")).toBe("graphicx");
    expect(packageFor("toprule")).toBe("booktabs");
    expect(packageFor("\\SI")).toBe("siunitx");
    expect(packageFor("\\foo")).toBeNull();
    expect(packageFor("\\constructor")).toBeNull();
  });

  it("sees packages already loaded, also in lists", () => {
    expect(loadsPackage("\\usepackage[final]{graphicx}", "graphicx")).toBe(true);
    expect(loadsPackage("\\usepackage{amsmath, amssymb}", "amssymb")).toBe(true);
    expect(loadsPackage("\\usepackage{graphics}", "graphicx")).toBe(false);
  });

  it("inserts after the last one-line \\usepackage, else at \\begin{document}", () => {
    const doc = ["\\documentclass{article}", "\\usepackage{amsmath}", "\\usepackage[", "  a]{b}", "% \\usepackage{x}", "\\begin{document}", "Hi"];
    expect(usepackageInsertLine(doc)).toBe(3);
    expect(usepackageInsertLine(["\\documentclass{article}", "\\begin{document}"])).toBe(2);
    expect(usepackageInsertLine(["\\section{Intro}", "Text"])).toBeNull();
  });
});
