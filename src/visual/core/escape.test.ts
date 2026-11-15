import { describe, expect, it } from "vitest";
import { createSession, helpersFor, schema, semEq } from "./index";
import { latexSerialize } from "./latex/serialize";
import * as mdSer from "./markdown/serialize";

const latex = helpersFor("latex");
const md = helpersFor("markdown");

/** The text a reader sees in a parsed paragraph (text plus glyph displays). */
function rendered(dialect: "latex" | "markdown", src: string): string {
  const s = createSession(dialect, src);
  const p = s.doc.firstChild!;
  expect(p.type.name).toBe("paragraph");
  let out = "";
  p.forEach((n) => (out += n.isText ? n.text : n.type.name === "glyph" ? n.attrs.display : `<${n.type.name}>`));
  return out;
}

describe("latex escaping", () => {
  it("escapes every special character", () => {
    expect(latex.escapeText("\\ { } % $ & # _ ^ ~ `")).toBe(
      "\\textbackslash{} \\{ \\} \\% \\$ \\& \\# \\_ \\^{} \\~{} \\textasciigrave{}",
    );
    expect(latex.escapeText("a--b---c")).toBe("a-{}-b-{}-{}-c");
    expect(latex.escapeText("plain text, with 'quotes'.")).toBe("plain text, with 'quotes'.");
  });

  it("round-trips escaped text to the same rendered text", () => {
    for (const s of ["50% off & more", "a_b^c ~ d", "\\path{x}", "#1 $5", "back`tick", "x--y", "-", "a-", "--"]) {
      expect(rendered("latex", "Z" + latex.escapeText(s) + "Z")).toBe("Z" + s + "Z");
    }
  });

  it("adds guards after control words, between $ and $, and between - and -", () => {
    const glyph = schema.nodes.glyph.create({ src: "\\LaTeX", display: "LaTeX" });
    const para = schema.nodes.paragraph.create(null, [glyph, schema.text("ish")]);
    expect(latexSerialize(para)).toBe("\\LaTeX{}ish");
    const m1 = schema.nodes.math_inline.create({ open: "$", body: "a", close: "$" });
    const m2 = schema.nodes.math_inline.create({ open: "$", body: "b", close: "$" });
    expect(latexSerialize(schema.nodes.paragraph.create(null, [m1, m2]))).toBe("$a${}$b$");
    const dash = schema.nodes.glyph.create({ src: "--", display: "\u2013" });
    expect(latexSerialize(schema.nodes.paragraph.create(null, [schema.text("a-"), dash]))).toBe("a-{}--");
    // A guard never changes what a reader sees.
    const s = createSession("latex", "\\LaTeX{}ish");
    expect(semEq(s.doc.firstChild!, para)).toBe(true);
  });

  it("never escapes code block text", () => {
    const cb = schema.nodes.code_block.create({ begin: "\\begin{verbatim}\n", end: "\n\\end{verbatim}", lang: "" }, schema.text("50% {x} $"));
    expect(latexSerialize(cb)).toBe("\\begin{verbatim}\n50% {x} $\n\\end{verbatim}");
  });
});

describe("markdown escaping", () => {
  it("always escapes the inline specials", () => {
    expect(md.escapeText("a*b_c`d[e]f<g$h\\i")).toBe("a\\*b\\_c\\`d\\[e\\]f\\<g\\$h\\\\i");
  });

  it("escapes block starters only at the start of a line", () => {
    expect(md.escapeText("# not a heading")).toBe("# not a heading");
    const para = schema.nodes.paragraph.create(null, schema.text("# not a heading - 1. x"));
    const { markdownSerialize } = mdSer;
    expect(markdownSerialize(para)).toBe("\\# not a heading - 1. x");
    expect(markdownSerialize(schema.nodes.paragraph.create(null, schema.text("12. item")))).toBe("12\\. item");
    expect(markdownSerialize(schema.nodes.paragraph.create(null, schema.text("- dash")))).toBe("\\- dash");
    expect(markdownSerialize(schema.nodes.paragraph.create(null, schema.text("> quote")))).toBe("\\> quote");
  });

  it("round-trips escaped text to the same rendered text", () => {
    for (const s of ["a*b*c", "snake_case_name", "[x](y)", "<b>", "$5", "back\\slash", "`tick`"]) {
      expect(rendered("markdown", "Z" + md.escapeText(s) + "Z")).toBe("Z" + s + "Z");
    }
  });

  it("does not escape inside code", () => {
    const code = schema.marks.code.create({ open: "`", close: "`", gid: 1, depth: 0 });
    const para = schema.nodes.paragraph.create(null, schema.text("a*b_c", [code]));
    expect(mdSer.markdownSerialize(para)).toBe("`a*b_c`");
  });
});
