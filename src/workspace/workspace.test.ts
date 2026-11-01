import { describe, expect, it } from "vitest";
import { parseOutline, plainTitle } from "./outlineParser";
import { buildTree, isWithin, parentDir, rebase } from "./paths";

describe("paths", () => {
  it("handles parents, containment, and rebasing", () => {
    expect(parentDir("a/b/c.tex")).toBe("a/b");
    expect(parentDir("main.tex")).toBe("");
    expect(isWithin("sec/intro.tex", "sec")).toBe(true);
    expect(isWithin("sections/intro.tex", "sec")).toBe(false);
    expect(rebase("sec/intro.tex", "sec", "chapters")).toBe("chapters/intro.tex");
    expect(rebase("a.tex", "a.tex", "b.tex")).toBe("b.tex");
  });

  it("builds a sorted tree with folders first", () => {
    const tree = buildTree([
      { path: "main.tex", isDir: false, size: 1 },
      { path: "figures", isDir: true, size: 0 },
      { path: "figures/plot10.png", isDir: false, size: 1 },
      { path: "figures/plot2.png", isDir: false, size: 1 },
      { path: "Appendix.tex", isDir: false, size: 1 },
      { path: "orphan/deep/file.tex", isDir: false, size: 1 },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["figures", "orphan", "Appendix.tex", "main.tex"]);
    expect(tree[0].children.map((n) => n.name)).toEqual(["plot2.png", "plot10.png"]);
    expect(tree[1].children[0].children[0].path).toBe("orphan/deep/file.tex");
  });
});

describe("outline", () => {
  it("finds headings with levels, lines, and nested braces", () => {
    const tex = [
      "\\documentclass{article}",
      "\\section{Intro}\\label{sec:intro}",
      "% \\section{Commented out}",
      "\\subsection*[short]{The \\emph{Big} {Idea}~1}",
      "text 50\\% done",
      "\\chapter{",
      "",
      "\\subsubsection {Spaced}",
    ].join("\n");
    expect(parseOutline(tex)).toEqual([
      { level: 2, title: "Intro", line: 2, starred: false },
      { level: 3, title: "The Big Idea 1", line: 4, starred: true },
      { level: 4, title: "Spaced", line: 8, starred: false },
    ]);
  });

  it("cleans titles for display", () => {
    expect(plainTitle("Results\\footnote{see appendix} for \\textbf{all}")).toBe("Results for all");
  });
});
