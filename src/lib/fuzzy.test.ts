import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

const files = [
  "main.tex",
  "references.bib",
  "chapters/introduction.tex",
  "chapters/methods.tex",
  "figures/main-result.png",
  "appendix/maths.tex",
];

describe("fuzzyMatch", () => {
  it("needs the characters in order", () => {
    expect(fuzzyMatch("mtx", "main.tex")).not.toBeNull();
    expect(fuzzyMatch("xtm", "main.tex")).toBeNull();
    expect(fuzzyMatch("intro", "chapters/introduction.tex")?.positions).toEqual([9, 10, 11, 12, 13]);
  });

  it("ignores case and spaces", () => {
    expect(fuzzyMatch("REF bib", "references.bib")).not.toBeNull();
  });
});

describe("fuzzyFilter", () => {
  it("ranks file-name matches above folder matches", () => {
    expect(fuzzyFilter("ma", files)[0].path).toBe("main.tex");
    expect(fuzzyFilter("meth", files)[0].path).toBe("chapters/methods.tex");
    expect(fuzzyFilter("intro", files).map((m) => m.path)).toEqual(["chapters/introduction.tex"]);
  });

  it("keeps the original order for an empty query", () => {
    expect(fuzzyFilter("", files).map((m) => m.path)).toEqual(files);
  });
});
