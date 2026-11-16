import { describe, expect, it } from "vitest";
import { compileQuery, searchFiles, searchText, type SearchOptions } from "./searchCore";

const plain: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };

function find(text: string, query: string, options: Partial<SearchOptions> = {}) {
  const re = compileQuery(query, { ...plain, ...options });
  if (!(re instanceof RegExp)) throw new Error("expected a pattern");
  return searchText(text, re).map((h) => [h.line, h.column]);
}

describe("compileQuery", () => {
  it("returns null for an empty query and an error for an invalid regex", () => {
    expect(compileQuery("", plain)).toBeNull();
    const bad = compileQuery("a(b", { ...plain, regex: true });
    expect(bad).not.toBeInstanceOf(RegExp);
    expect(bad && "error" in bad && bad.error.length > 0).toBe(true);
  });
});

describe("searchText", () => {
  const text = "The cat sat.\r\nCat (x) and category\n  catalogue cat";

  it("matches literally and case-insensitively by default", () => {
    expect(find(text, "cat")).toEqual([[1, 5], [2, 1], [2, 13], [3, 3], [3, 13]]);
    // Regex characters are literal unless regex is on.
    expect(find(text, "(x)")).toEqual([[2, 5]]);
  });

  it("can be case-sensitive", () => {
    expect(find(text, "Cat", { caseSensitive: true })).toEqual([[2, 1]]);
  });

  it("can match whole words only, including accented letters", () => {
    expect(find(text, "cat", { wholeWord: true })).toEqual([[1, 5], [2, 1], [3, 13]]);
    expect(find("café cafés", "café", { wholeWord: true })).toEqual([[1, 1]]);
  });

  it("supports regular expressions and skips empty matches", () => {
    expect(find(text, "c[a-z]+gory", { regex: true })).toEqual([[2, 13]]);
    expect(find("ab", "x*", { regex: true })).toEqual([]);
  });

  it("builds a preview with the match position", () => {
    const re = compileQuery("needle", plain) as RegExp;
    const [hit] = searchText(`${" ".repeat(4)}${"x".repeat(60)} needle end`, re);
    expect(hit.preview.startsWith("…")).toBe(true);
    expect(hit.preview.slice(hit.start, hit.end)).toBe("needle");
  });
});

describe("searchFiles", () => {
  it("groups hits by file and stops at the cap", () => {
    const re = compileQuery("a", plain) as RegExp;
    const files = [
      { path: "one.tex", text: "a a a" },
      { path: "none.tex", text: "zzz" },
      { path: "two.tex", text: "a\na" },
      { path: "three.tex", text: "a" },
    ];
    const all = searchFiles(files, re);
    expect(all.files.map((f) => [f.path, f.hits.length])).toEqual([["one.tex", 3], ["two.tex", 2], ["three.tex", 1]]);
    expect(all.capped).toBe(false);

    const capped = searchFiles(files, re, 4);
    expect(capped.total).toBe(4);
    expect(capped.capped).toBe(true);
    expect(capped.files.map((f) => [f.path, f.hits.length])).toEqual([["one.tex", 3], ["two.tex", 1]]);
  });
});
