import { describe, expect, it } from "vitest";
import { firstToken, issueKind, markerSpan, undefinedCommand } from "./markers";

const warning = (message: string) => ({ severity: "warning" as const, message, context: null });
/** The text a span covers on `line`. */
const text = (line: string, span: { startColumn: number; endColumn: number } | null) =>
  span && line.slice(span.startColumn - 1, span.endColumn - 1);

describe("issueKind", () => {
  it("reads citation and reference keys in both quote styles", () => {
    expect(issueKind(warning("Citation `knuth' on page 1 undefined on input line 20"))).toEqual({ kind: "citation", key: "knuth" });
    expect(issueKind(warning("natbib: Citation `a:b' on page 1 undefined on input line 2 with extra detail."))).toEqual({
      kind: "citation",
      key: "a:b",
    });
    expect(issueKind(warning("Citation 'lamport94' on page 3 undefined on input line 9."))).toEqual({ kind: "citation", key: "lamport94" });
    expect(issueKind(warning("Reference `fig:missing' on page 1 undefined on input line 7."))).toEqual({
      kind: "reference",
      key: "fig:missing",
    });
  });

  it("knows layout boxes, undefined commands and the rest", () => {
    expect(issueKind({ severity: "badbox", message: "Overfull \\hbox (12.0pt too wide)", context: null })).toEqual({ kind: "badbox" });
    expect(issueKind({ severity: "error", message: "Undefined control sequence.", context: "l.14 \\foo\n          bar" })).toEqual({
      kind: "command",
      name: "\\foo",
    });
    expect(issueKind({ severity: "error", message: "Missing $ inserted.", context: null })).toEqual({ kind: "other" });
  });
});

describe("undefinedCommand", () => {
  it("takes the last command on TeX's l.N line", () => {
    expect(undefinedCommand("l.14 Some text \\textbf{a} \\foo\n   bar")).toBe("\\foo");
    expect(undefinedCommand("<argument> \\mathbb\n\nl.9 $\\mathbb\n R$")).toBe("\\mathbb");
    expect(undefinedCommand(null)).toBeNull();
    expect(undefinedCommand("l.3 plain words")).toBeNull();
  });
});

describe("markerSpan", () => {
  const para = "As shown by \\citet{lamport94} and others \\cite[p.~3]{a, knuth ,b} the method works well in a long paragraph.";

  it("marks only the undefined key inside the cite command", () => {
    expect(text(para, markerSpan(warning("Citation `knuth' on page 1 undefined"), para))).toBe("knuth");
    expect(text(para, markerSpan(warning("Citation `lamport94' on page 1 undefined"), para))).toBe("lamport94");
  });

  it("falls back to the cite command, then the first token", () => {
    expect(text(para, markerSpan(warning("Citation `zzz' on page 1 undefined"), para))).toBe("\\citet");
    expect(text("Plain words here", markerSpan(warning("Citation `zzz' on page 1 undefined"), "Plain words here"))).toBe("Plain");
  });

  it("marks the reference key", () => {
    const line = "See Figure~\\ref{fig:a} and \\eqref{eq:missing}.";
    expect(text(line, markerSpan(warning("Reference `eq:missing' on page 1 undefined"), line))).toBe("eq:missing");
  });

  it("marks the undefined command, not a longer one that starts the same", () => {
    const line = "  \\foobar and \\foo{x} here";
    const issue = { severity: "error" as const, message: "Undefined control sequence.", context: "l.3   \\foobar and \\foo" };
    expect(text(line, markerSpan(issue, line))).toBe("\\foo");
    expect(markerSpan(issue, line)!.startColumn).toBe(15);
  });

  it("doesn't squiggle layout boxes", () => {
    expect(markerSpan({ severity: "badbox", message: "Underfull \\hbox (badness 10000)", context: null }, para)).toBeNull();
  });

  it("never covers the whole line otherwise", () => {
    const span = markerSpan(warning("Font shape `OT1/cmr/bx/sc' undefined"), para)!;
    expect(text(para, span)).toBe("As");
  });
});

describe("firstToken", () => {
  it("is a command, a word, or nothing on a blank line", () => {
    expect(firstToken("   \\section{Intro}")).toEqual({ startColumn: 4, endColumn: 12 });
    expect(firstToken("word, more")).toEqual({ startColumn: 1, endColumn: 6 });
    expect(firstToken("   ")).toEqual({ startColumn: 1, endColumn: 1 });
    expect(firstToken("\\\\ next").endColumn).toBe(3);
    expect(firstToken("x".repeat(200)).endColumn).toBe(41);
  });
});
