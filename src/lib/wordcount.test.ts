import { describe, expect, it } from "vitest";
import { countWords } from "./wordcount";

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
