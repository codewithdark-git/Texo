import { describe, expect, it } from "vitest";
import { applyPlaced, badEditPath, diffLines, locateEdit, normalizePath, placeEdits, previewEdit, validPackageName } from "./fixEdits";

describe("badEditPath", () => {
  it("accepts project text files", () => {
    expect(badEditPath("main.tex")).toBeNull();
    expect(badEditPath("chapters/intro.tex")).toBeNull();
    expect(badEditPath("refs.bib")).toBeNull();
    expect(badEditPath("style/my.sty")).toBeNull();
  });

  it("refuses paths outside the project", () => {
    expect(badEditPath("../other/main.tex")).toMatch(/outside/);
    expect(badEditPath("a/../../b.tex")).toMatch(/outside/);
    expect(badEditPath("/etc/passwd.tex")).toMatch(/outside/);
    expect(badEditPath("C:/Users/x/main.tex")).toMatch(/outside/);
    expect(badEditPath("C:\\Users\\x\\main.tex")).toMatch(/outside/);
    expect(badEditPath("~/main.tex")).toMatch(/outside/);
    expect(badEditPath("a//b.tex")).toMatch(/outside/);
  });

  it("refuses binary and unknown files", () => {
    expect(badEditPath("figure.png")).toMatch(/text file/);
    expect(badEditPath("main.pdf")).toMatch(/text file/);
    expect(badEditPath("main.aux.exe")).toMatch(/text file/);
    expect(badEditPath("")).toMatch(/which file/);
    // latexmkrc runs Perl code on compile, so the fixer never edits it.
    expect(badEditPath("latexmkrc")).toBeTruthy();
    expect(badEditPath(".latexmkrc")).toBeTruthy();
    expect(badEditPath(".texo/state.tex")).toBeTruthy();
  });

  it("normalizes separators", () => {
    expect(normalizePath(".\\chapters\\a.tex")).toBe("chapters/a.tex");
    expect(normalizePath("./main.tex")).toBe("main.tex");
  });
});

describe("locateEdit", () => {
  const text = "\\begin{document}\nHello \\textbf{world\n\\end{document}\n";

  it("finds text that occurs exactly once", () => {
    const at = locateEdit(text, { find: "\\textbf{world", replace: "\\textbf{world}" });
    expect(at).toEqual({ ok: true, start: text.indexOf("\\textbf"), end: text.indexOf("\\textbf") + 13 });
  });

  it("rejects missing, repeated, empty and no-op edits", () => {
    expect(locateEdit(text, { find: "nope", replace: "x" })).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't in the file/) });
    expect(locateEdit(text, { find: "document", replace: "x" })).toMatchObject({ ok: false, reason: expect.stringMatching(/more than once/) });
    expect(locateEdit(text, { find: "", replace: "x" })).toMatchObject({ ok: false });
    expect(locateEdit(text, { find: "Hello", replace: "Hello" })).toMatchObject({ ok: false, reason: expect.stringMatching(/doesn't change/) });
  });

  it("counts overlapping repeats", () => {
    expect(locateEdit("aaa", { find: "aa", replace: "b" })).toMatchObject({ ok: false });
  });
});

describe("placeEdits / applyPlaced", () => {
  it("applies several edits against the original offsets", () => {
    const text = "one two three";
    const { placed, failed } = placeEdits(text, [
      { find: "three", replace: "3" },
      { find: "one", replace: "1" },
    ]);
    expect(failed).toEqual([]);
    expect(applyPlaced(text, placed)).toBe("1 two 3");
    expect(placed.map((p) => p.index)).toEqual([1, 0]);
  });

  it("refuses overlapping edits and keeps the first", () => {
    const text = "alpha beta gamma";
    const { placed, failed } = placeEdits(text, [
      { find: "alpha beta", replace: "A B" },
      { find: "beta gamma", replace: "B G" },
    ]);
    expect(placed).toHaveLength(1);
    expect(failed).toEqual([{ index: 1, reason: expect.stringMatching(/overlaps/) }]);
    expect(applyPlaced(text, placed)).toBe("A B gamma");
  });
});

describe("diffLines", () => {
  it("marks changed lines and keeps the rest", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a", line: 1 },
      { kind: "del", text: "b", line: 2 },
      { kind: "add", text: "B", line: 2 },
      { kind: "same", text: "c", line: 3 },
    ]);
  });

  it("handles inserts and deletes", () => {
    expect(diffLines("a\nc", "a\nb\nc").map((l) => l.kind)).toEqual(["same", "add", "same"]);
    expect(diffLines("a\nb\nc", "a\nc").map((l) => l.kind)).toEqual(["same", "del", "same"]);
    expect(diffLines("", "x").map((l) => l.kind)).toEqual(["del", "add"]);
  });

  it("reproduces both sides", () => {
    const before = "x\ny\nz\nw";
    const after = "x\nq\nz\nr\nw";
    const d = diffLines(before, after);
    expect(d.filter((l) => l.kind !== "add").map((l) => l.text).join("\n")).toBe(before);
    expect(d.filter((l) => l.kind !== "del").map((l) => l.text).join("\n")).toBe(after);
  });
});

describe("previewEdit", () => {
  const text = ["l1", "l2", "l3", "\\usepackage{microtype}", "l5", "l6", "l7"].join("\n");

  it("shows the changed line with context and real line numbers", () => {
    const p = previewEdit(text, { find: "\\usepackage{microtype}", replace: "\\usepackage[expansion=false]{microtype}" }, 1)!;
    expect(p.firstLine).toBe(3);
    expect(p.lines).toEqual([
      { kind: "same", text: "l3", line: 3 },
      { kind: "del", text: "\\usepackage{microtype}", line: 4 },
      { kind: "add", text: "\\usepackage[expansion=false]{microtype}", line: 4 },
      { kind: "same", text: "l5", line: 5 },
    ]);
  });

  it("works at the start and end of the file", () => {
    expect(previewEdit(text, { find: "l1", replace: "L1" }, 2)!.firstLine).toBe(1);
    const end = previewEdit(text, { find: "l7", replace: "L7" }, 2)!;
    expect(end.lines.at(-1)).toEqual({ kind: "add", text: "L7", line: 7 });
  });

  it("is null when the edit no longer applies", () => {
    expect(previewEdit(text, { find: "gone", replace: "x" })).toBeNull();
  });
});

describe("validPackageName", () => {
  it("allows plain package names only", () => {
    expect(validPackageName("cm-super")).toBe(true);
    expect(validPackageName("collection-fontsrecommended")).toBe(true);
    expect(validPackageName("pgf_3.1")).toBe(true);
    expect(validPackageName("")).toBe(false);
    expect(validPackageName("cm-super; rm -rf /")).toBe(false);
    expect(validPackageName("a b")).toBe(false);
    expect(validPackageName("--admin")).toBe(false);
  });
});
