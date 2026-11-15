import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { createSession, serializeNode } from "./index";

/** Parses one LaTeX paragraph and returns it. */
function para(src: string): PMNode {
  const s = createSession("latex", src);
  expect(s.verify()).toEqual({ ok: true });
  expect(s.doc.childCount).toBe(1);
  const p = s.doc.firstChild!;
  expect(serializeNode(p, "latex")).toBe(src);
  return p;
}

/** A compact description of a paragraph's inline content. */
function describeInline(p: PMNode): string[] {
  const out: string[] = [];
  p.forEach((n) => {
    const marks = n.marks.map((m) => `${m.type.name}${m.attrs.depth}`).join("+");
    const prefix = marks ? `[${marks}]` : "";
    if (n.isText) out.push(`${prefix}${n.text}`);
    else out.push(`${prefix}<${n.type.name}:${n.attrs.src ?? n.attrs.open + n.attrs.body + n.attrs.close}>`);
  });
  return out;
}

describe("latex inline marks", () => {
  it("parses each command form with its exact open spelling", () => {
    const cases: [string, string, string][] = [
      ["\\textbf{x}", "bold", "\\textbf{"],
      ["\\textit{x}", "italic", "\\textit{"],
      ["\\emph{x}", "italic", "\\emph{"],
      ["\\underline{x}", "underline", "\\underline{"],
      ["\\uline{x}", "underline", "\\uline{"],
      ["\\texttt{x}", "code", "\\texttt{"],
      ["\\textsc{x}", "smallcaps", "\\textsc{"],
      ["\\textsf{x}", "sans", "\\textsf{"],
      ["\\textsuperscript{x}", "sup", "\\textsuperscript{"],
      ["\\textsubscript{x}", "sub", "\\textsubscript{"],
      ["\\textbf {x}", "bold", "\\textbf {"],
    ];
    for (const [src, type, open] of cases) {
      const p = para(`A ${src} b`);
      const mark = p.child(1).marks[0];
      expect(mark.type.name).toBe(type);
      expect(mark.attrs.open).toBe(open);
      expect(mark.attrs.close).toBe("}");
    }
  });

  it("parses declaration groups", () => {
    for (const [cmd, type] of [
      ["bfseries", "bold"],
      ["bf", "bold"],
      ["itshape", "italic"],
      ["it", "italic"],
      ["em", "italic"],
      ["ttfamily", "code"],
      ["scshape", "smallcaps"],
      ["sffamily", "sans"],
    ]) {
      const p = para(`Say {\\${cmd} loud} now`);
      expect(p.child(1).marks[0].type.name).toBe(type);
      expect(p.child(1).marks[0].attrs.open).toBe(`{\\${cmd} `);
      expect(p.child(1).text).toBe("loud");
    }
  });

  it("nests marks in both orders with depth", () => {
    expect(describeInline(para("\\textbf{a \\emph{b} c}"))).toEqual(["[bold0]a ", "[bold0+italic1]b", "[bold0] c"]);
    expect(describeInline(para("\\emph{a \\textbf{b}}"))).toEqual(["[italic0]a ", "[bold1+italic0]b"]);
  });

  it("keeps adjacent groups apart", () => {
    const p = para("\\textbf{a}\\textbf{b}");
    expect(p.childCount).toBe(2);
    expect(p.child(0).marks[0].attrs.gid).not.toBe(p.child(1).marks[0].attrs.gid);
  });

  it("lets a mark span maths and a citation", () => {
    expect(describeInline(para("\\textbf{see $x$ and \\cite{k}}"))).toEqual([
      "[bold0]see ",
      "[bold0]<math_inline:$x$>",
      "[bold0] and ",
      "[bold0]<cite:\\cite{k}>",
    ]);
  });

  it("demotes a mark nested in the same mark, and only that", () => {
    const d = describeInline(para("\\textbf{a \\textbf{b} c} \\emph{ok}"));
    expect(d).toEqual(["[bold0]a ", "[bold0]<raw_inline:\\textbf{b}>", "[bold0] c", " ", "[italic0]ok"]);
  });

  it("turns an empty group into a raw chip", () => {
    expect(describeInline(para("x \\textbf{} y"))).toEqual(["x ", "<raw_inline:\\textbf{}>", " y"]);
  });

  it("parses \\href as a link mark", () => {
    const p = para("Go \\href{https://a.b}{here} now");
    const m = p.child(1).marks[0];
    expect(m.type.name).toBe("link");
    expect(m.attrs.href).toBe("https://a.b");
    expect(m.attrs.open).toBe("\\href{https://a.b}{");
  });
});

describe("latex inline glyphs and chips", () => {
  it("recognises every glyph", () => {
    const glyphs: [string, string][] = [
      ["~", "\u00a0"],
      ["``", "\u201c"],
      ["''", "\u201d"],
      ["`", "\u2018"],
      ["--", "\u2013"],
      ["---", "\u2014"],
      ["\\%", "%"],
      ["\\&", "&"],
      ["\\#", "#"],
      ["\\_", "_"],
      ["\\$", "$"],
      ["\\{", "{"],
      ["\\}", "}"],
      ["\\,", "\u2009"],
      ["\\ ", " "],
      ["\\@", ""],
      ["\\/", ""],
      ["\\-", ""],
      ["\\:", "\u2005"],
      ["\\;", "\u2005"],
      ["\\ldots", "\u2026"],
      ["\\dots{}", "\u2026"],
      ["\\textellipsis", "\u2026"],
      ["\\LaTeX{}", "LaTeX"],
      ["\\TeX", "TeX"],
      ["\\today", "today"],
      ["\\textbackslash{}", "\\"],
      ["\\textasciitilde", "~"],
      ["\\textasciicircum", "^"],
      ["\\textasciigrave", "`"],
      ["{}", ""],
      ["\\^{}", "^"],
      ["\\~{}", "~"],
    ];
    for (const [src, display] of glyphs) {
      const p = para(`a${src}.`);
      const g = p.child(1);
      expect(g.type.name, src).toBe("glyph");
      expect(g.attrs.src).toBe(src);
      expect(g.attrs.display).toBe(display);
    }
  });

  it("parses chips", () => {
    const p = para("\\cite[p.~1][see]{a, b} \\eqref{e} \\label{l} \\footnote[2]{note} \\url{u} \\Cref*{x}");
    const types = describeInline(p).filter((s) => s.startsWith("<"));
    expect(types).toEqual([
      "<cite:\\cite[p.~1][see]{a, b}>",
      "<ref:\\eqref{e}>",
      "<label:\\label{l}>",
      "<footnote:\\footnote[2]{note}>",
      "<url:\\url{u}>",
      "<ref:\\Cref*{x}>",
    ]);
    expect(p.child(0).attrs.keys).toEqual(["a", "b"]);
    expect(p.child(6).attrs.body).toBe("note");
  });

  it("parses maths in every inline form", () => {
    const d = describeInline(para("$a$ \\(b\\) \\[c\\] $$d$$ ${e}$"));
    expect(d.filter((s) => s.startsWith("<"))).toEqual([
      "<math_inline:$a$>",
      "<math_inline:\\(b\\)>",
      "<math_inline:\\[c\\]>",
      "<math_inline:$$d$$>",
      "<math_inline:${e}$>",
    ]);
  });

  it("keeps unknowns as raw chips with their arguments", () => {
    const d = describeInline(para("\\foo*[o]{a}{b} x \\\\ y \\\\*[2pt] z & # ^ _ {grp} \\verb|{| \\item"));
    expect(d.filter((s) => s.startsWith("<"))).toEqual([
      "<raw_inline:\\foo*[o]{a}{b}>",
      "<raw_inline:\\\\>",
      "<raw_inline:\\\\*[2pt]>",
      "<raw_inline:&>",
      "<raw_inline:#>",
      "<raw_inline:^>",
      "<raw_inline:_>",
      "<raw_inline:{grp}>",
      "<raw_inline:\\verb|{|>",
      "<raw_inline:\\item>",
    ]);
  });

  it("makes softbreaks that keep the indentation, and comments that keep their line end", () => {
    const p = para("one  \n    two % note\n  three");
    expect(describeInline(p)).toEqual(["one  ", "<softbreak:\n    >", "two ", "<raw_inline:% note\n  >", "three"]);
  });

  it("makes the paragraph raw when maths never closes", () => {
    const s = createSession("latex", "Text $x and more");
    expect(s.doc.firstChild!.type.name).toBe("raw_block");
    expect(s.doc.firstChild!.attrs.src).toBe("Text $x and more");
  });
});
