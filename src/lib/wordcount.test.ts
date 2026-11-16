import { describe, expect, it } from "vitest";
import { countDetailed, countMarkdownWords, countProject, countWords, totalWords } from "./wordcount";

describe("countWords", () => {
  it("counts body text and section titles, not the preamble", () => {
    const tex = [
      "\\documentclass{article}",
      "\\usepackage{amsmath}",
      "\\title{Ignored Preamble Title}",
      "\\begin{document}",
      "\\section{Two Words}",
      "Hello \\textbf{bold} world.",
      "\\end{document}",
    ].join("\n");
    expect(countWords(tex)).toBe(5);
  });

  it("skips comments, maths, labels, and citations", () => {
    const tex = "\\begin{document}\nSee~\\ref{fig:a} and \\cite{knuth}. % not this\n$x^2 + y$ is \\[ E = mc^2 \\] fine.\n\\begin{equation} a = b \\end{equation}\n50\\% done\\label{x}\n\\end{document}";
    // See, and, is, fine, 50, done
    expect(countWords(tex)).toBe(6);
  });

  it("works on a file with no document environment (an \\input chapter)", () => {
    expect(countWords("\\chapter{Intro}\nJust three words")).toBe(4);
  });
});

describe("countDetailed", () => {
  const tex = [
    "\\documentclass{article}",
    "\\title{Not Counted}",
    "\\begin{document}",
    "\\section{Two Words}\\label{sec:a}",
    "Body text here\\footnote{A short note.} and more. % a comment here",
    "50\\% done, see \\cite{a, b} and \\citep{c}.",
    "\\begin{figure}",
    "  \\includegraphics{plot.png}",
    "  \\caption[Short]{The $x$ plot of results}",
    "\\end{figure}",
    "\\begin{table*}\\caption{One}\\end{table*}",
    "Inline $a$ and \\(b\\), display \\[ c \\] and",
    "\\begin{align} d \\end{align}",
    "\\subsection*{Third}",
    "\\end{document}",
  ].join("\n");
  const c = countDetailed(tex);

  it("separates heading, caption and footnote words", () => {
    expect(c.headings).toBe(2);
    expect(c.headingWords).toBe(3); // Two, Words, Third
    expect(c.captionWords).toBe(5); // The, plot, of, results, One
    expect(c.footnoteWords).toBe(3); // A, short, note.
    // Body, text, here, and, more., 50, done,, see, and, Inline, and, display, and
    expect(c.textWords).toBe(13);
    expect(totalWords(c)).toBe(24);
  });

  it("counts maths, floats and citations", () => {
    expect(c.inlineMath).toBe(3); // $x$, $a$, \(b\)
    expect(c.displayMath).toBe(2); // \[ c \], align
    expect(c.figures).toBe(1);
    expect(c.tables).toBe(1);
    expect(c.citations).toBe(3);
  });

  it("ignores comments but keeps escaped percent signs", () => {
    const d = countDetailed("Kept 10\\% words % dropped words\n% all dropped");
    expect(d.textWords).toBe(3);
    expect(d.characters).toBe("Kept10words".length);
  });
});

describe("countProject", () => {
  const files: Record<string, string> = {
    "main.tex": [
      "\\documentclass{book}",
      "\\input{macros}",
      "\\includeonly{chapters/one,chapters/two}",
      "\\begin{document}",
      "Main words.",
      "\\include{chapters/one}",
      "\\include{chapters/skipped}",
      "\\input{chapters/two.tex}",
      "\\subfile{missing}",
      "% \\input{chapters/commented}",
      "\\end{document}",
    ].join("\n"),
    "macros.tex": "\\newcommand{\\x}{Not text}",
    "chapters/one.tex": "\\chapter{One}\nFirst chapter text. \\input{chapters/two}",
    "chapters/two.tex": "Second \\input{main}",
    "chapters/skipped.tex": "Left out entirely",
  };
  const read = async (path: string) => files[path] ?? null;

  it("follows includes with cycle protection and reports missing files", async () => {
    const result = await countProject("main.tex", read);
    expect(result.files.map((f) => f.path)).toEqual(["main.tex", "chapters/one.tex", "chapters/two.tex", "missing.tex"]);
    expect(result.missing).toEqual(["missing.tex"]);
    expect(result.files[3].stats).toBeNull();
    // Main, words., One, First, chapter, text., Second
    expect(totalWords(result.totals)).toBe(7);
    expect(result.totals.headings).toBe(1);
  });

  it("resolves paths against the main document's folder", async () => {
    const nested: Record<string, string> = {
      "thesis/main.tex": "\\begin{document}\\input{parts/a}\\end{document}",
      "thesis/parts/a.tex": "Alpha beta",
    };
    const result = await countProject("thesis/main.tex", async (p) => nested[p] ?? null);
    expect(result.files.map((f) => f.path)).toEqual(["thesis/main.tex", "thesis/parts/a.tex"]);
    expect(result.totals.textWords).toBe(2);
  });
});

describe("countMarkdownWords", () => {
  it("counts prose, not code, maths, link URLs or HTML", () => {
    const md = [
      "---",
      "title: Front matter",
      "---",
      "# A heading",
      "",
      "Some **bold** text with `inline code` and $x^2$ maths.",
      "",
      "```js",
      "const notCounted = 1;",
      "```",
      "",
      "$$",
      "E = mc^2",
      "$$",
      "",
      "See [the docs](https://example.com/very/long/url) or <span class=\"x\">this</span>.",
      "<!-- hidden comment -->",
      "| a | b |",
    ].join("\n");
    // A, heading, Some, bold, text, with, and, maths., See, the, docs, or, this, a, b
    expect(countMarkdownWords(md)).toBe(15);
  });
});
