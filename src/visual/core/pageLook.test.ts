// Page look in Visual mode: font sizes, colours, spacing, page breaks and
// alignment parse into marks and atoms (never code chips), round-trip byte for
// byte, and new ones are written in the canonical spelling.

import { describe, expect, it } from "vitest";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import {
  alignOf,
  createSession,
  cssColor,
  cssLength,
  detachDeclarations,
  helpersFor,
  includeCandidates,
  resolveInclude,
  schema,
  semEq,
  serializeNode,
  setAlign,
  spacingAmount,
  unwrapAligned,
  wrapAligned,
  type VisualSession,
} from "./index";
import paper from "./__fixtures__/paper-title.tex?raw";

const latex = helpersFor("latex");
const md = helpersFor("markdown");

function realKids(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.forEach((n) => {
    if (!(n.type.name === "paragraph" && n.content.size === 0)) out.push(n);
  });
  return out;
}

/** Plans newDoc, checks it re-parses to the same thing, commits, and returns the new text. */
function change(s: VisualSession, newDoc: PMNode): string {
  const res = s.plan(newDoc);
  if (!res.ok) throw new Error("plan failed: " + res.reason);
  const reparsed = realKids(createSession("latex", res.newText).doc);
  const wanted = realKids(newDoc);
  expect(reparsed.length).toBe(wanted.length);
  reparsed.forEach((n, i) => expect(semEq(n, wanted[i])).toBe(true));
  s.commit(newDoc, res.newText);
  expect(s.verify()).toEqual({ ok: true });
  return res.newText;
}

/** [from, to) of the first text matching `needle`. */
function rangeOf(doc: PMNode, needle: string): [number, number] {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found !== -1) return false;
    if (n.isText && n.text!.includes(needle)) found = pos + n.text!.indexOf(needle);
    return true;
  });
  if (found === -1) throw new Error("not found: " + needle);
  return [found, found + needle.length];
}

/** The top-level child holding `needle`, with its position. */
function blockWith(doc: PMNode, needle: string): { node: PMNode; pos: number } {
  let out: { node: PMNode; pos: number } | null = null;
  doc.forEach((n, pos) => {
    if (!out && n.textContent.includes(needle)) out = { node: n, pos };
  });
  if (!out) throw new Error("no block with " + needle);
  return out;
}

function markOf(n: PMNode, type: string): Mark | undefined {
  return n.marks.find((m) => m.type.name === type);
}

describe("a real paper's title block and abstract", () => {
  it("round-trips byte for byte", () => {
    const s = createSession("latex", paper);
    expect(s.verify()).toEqual({ ok: true });
    let joined = "";
    let pos = 0;
    s.doc.forEach((n) => {
      const src = serializeNode(n, "latex");
      const at = paper.indexOf(src, pos);
      expect(at).toBeGreaterThanOrEqual(pos);
      expect(paper.slice(pos, at).trim()).toBe("");
      joined += paper.slice(pos, at) + src;
      pos = at + src.length;
    });
    expect(joined + paper.slice(pos)).toBe(paper);
  });

  it("shows no code: no raw chips or raw blocks in the body", () => {
    const s = createSession("latex", paper);
    const raw: string[] = [];
    s.doc.descendants((n) => {
      if (n.type.name === "raw_inline" || n.type.name === "raw_block") raw.push(String(n.attrs.src));
      return true;
    });
    expect(raw).toEqual([]);
    expect(s.rawRatio).toBe(0);
  });

  it("reads the hand-set title as large bold text", () => {
    const s = createSession("latex", paper);
    const center = s.doc.child(1);
    expect(alignOf(center)).toBe("center");
    const title = center.child(0);
    const text = title.child(0);
    expect(text.text).toBe("Groupwise Conformal Coverage Under Source Imbalance in Medical Imaging");
    expect(markOf(text, "size")?.attrs).toMatchObject({ cmd: "LARGE", open: "{\\LARGE", close: "}" });
    expect(markOf(text, "bold")?.attrs).toMatchObject({ open: "\\bfseries ", close: "" });
    expect(title.child(1).type.name).toBe("spacing");
    expect(title.child(1).attrs).toMatchObject({ src: "\\par", kind: "break" });
    expect(center.child(1).type.name).toBe("spacer_block");
    expect(center.child(1).attrs).toMatchObject({ src: "\\vspace{10pt}", kind: "vspace", amount: "10pt" });
  });

  it("reads spacing, glyphs and colours in the abstract", () => {
    const s = createSession("latex", paper);
    const abs = blockWith(s.doc, "Abstract.").node;
    const atoms: string[] = [];
    abs.forEach((n) => {
      if (n.type.name === "spacing") atoms.push(`${n.attrs.kind}:${n.attrs.src.trimEnd()}:${n.attrs.amount}`);
      if (n.type.name === "glyph") atoms.push(`glyph:${n.attrs.src}:${n.attrs.display}`);
    });
    expect(atoms).toEqual([
      "noindent:\\noindent:",
      "glyph:{,}:,",
      "glyph:\\%:%",
      "glyph:~:\u00a0",
      "glyph:\\,:\u2009",
      "hspace:\\enspace:0.5em",
      "glyph:\\%:%",
      "break:\\\\:",
      "hspace:\\hfill:fill",
      "break:\\linebreak:",
      "glyph:\\;:\u2005",
      "glyph:\\::\u2005",
      "glyph:\\!:",
    ]);
    const colors: string[] = [];
    abs.forEach((n) => {
      const c = markOf(n, "color");
      if (c && n.isText) colors.push(`${n.text}=${c.attrs.color}`);
    });
    expect(colors).toEqual(["groupwise calibration=red", "reweighting=blue"]);
  });

  it("reads alignment environments and block-level spacers", () => {
    const s = createSession("latex", paper);
    const kinds: string[] = [];
    s.doc.forEach((n) => {
      if (n.type.name === "container") kinds.push(`align:${alignOf(n)}`);
      if (n.type.name === "spacer_block") kinds.push(`${n.attrs.kind}:${n.attrs.src}:${n.attrs.amount}`);
    });
    expect(kinds).toEqual([
      "align:center",
      "vspace:\\vspace*{6pt}:6pt",
      "vspace:\\medskip:6pt",
      "align:right",
      "align:left",
      "vspace:\\smallskip:3pt",
      "vspace:\\bigskip:12pt",
      "pagebreak:\\newpage:",
      "pagebreak:\\clearpage:",
      "pagebreak:\\pagebreak[4]:",
    ]);
  });

  it("combines size, italic and a model colour in one group", () => {
    const s = createSession("latex", paper);
    const [from] = rangeOf(s.doc, "a styled phrase");
    const n = s.doc.nodeAt(from)!;
    expect(markOf(n, "size")?.attrs.cmd).toBe("Large");
    expect(markOf(n, "italic")?.attrs.open).toBe("\\itshape");
    expect(markOf(n, "color")?.attrs).toMatchObject({ model: "rgb", color: "0.2,0.4,0.6" });
  });
});

describe("new styling is written canonically", () => {
  it("sets and clears a font size", () => {
    const s = createSession("latex", "Some plain words here.\n");
    const [a, b] = rangeOf(s.doc, "plain");
    const size = schema.marks.size.create(latex.sizeMark("large", s.context)!);
    const t1 = change(s, new Transform(s.doc).addMark(a, b, size).doc);
    expect(t1).toBe("Some {\\large plain} words here.\n");
    const t2 = change(s, new Transform(s.doc).removeMark(0, s.doc.content.size, schema.marks.size).doc);
    expect(t2).toBe("Some plain words here.\n");
  });

  it("sets a colour, and refuses names that are not plain xcolor names", () => {
    const s = createSession("latex", "Some plain words here.\n");
    const [a, b] = rangeOf(s.doc, "words");
    const color = schema.marks.color.create(latex.colorMark("red", s.context)!);
    expect(change(s, new Transform(s.doc).addMark(a, b, color).doc)).toBe("Some plain \\textcolor{red}{words} here.\n");
    expect(latex.colorMark("red}\\evil{", s.context)).toBeNull();
    expect(latex.colorMark("blue!40", s.context)).toMatchObject({ open: "\\textcolor{blue!40}{" });
  });

  it("nests a new size inside existing bold", () => {
    const s = createSession("latex", "A \\textbf{bold claim} here.\n");
    const [a, b] = rangeOf(s.doc, "bold claim");
    const size = schema.marks.size.create(latex.sizeMark("Huge", s.context)!);
    expect(change(s, new Transform(s.doc).addMark(a, b, size).doc)).toBe("A \\textbf{{\\Huge bold claim}} here.\n");
  });

  it("restyles part of a hand-set title by respelling its declarations", () => {
    const s = createSession("latex", "{\\LARGE\\bfseries Big Title\\par}\n");
    const [a, b] = rangeOf(s.doc, "Big");
    const doc = new Transform(s.doc).removeMark(a, b, schema.marks.bold).doc;
    // As spelled, \bfseries cannot stop halfway through its group: refused, nothing written.
    expect(s.plan(doc).ok).toBe(false);
    const para = detachDeclarations(doc.child(0), s.context);
    const text = change(s, doc.copy(doc.content.replaceChild(0, para)));
    expect(text).toBe("{\\LARGE{}Big\\textbf{ Title\\par}}\n");
  });

  it("wraps blocks in center, switches to flushright, and unwraps back", () => {
    const src = "Hello world.\n\nSecond.\n";
    const s = createSession("latex", src);
    const first = s.doc.child(0);
    const wrapped = wrapAligned([first], "center", s.context)!;
    const t1 = change(s, s.doc.copy(s.doc.content.replaceChild(0, wrapped)));
    expect(t1).toBe("\\begin{center}\nHello world.\n\\end{center}\n\nSecond.\n");
    const right = setAlign(s.doc.child(0), "right", s.context)!;
    const t2 = change(s, s.doc.copy(s.doc.content.replaceChild(0, right)));
    expect(t2).toBe("\\begin{flushright}\nHello world.\n\\end{flushright}\n\nSecond.\n");
    expect(alignOf(s.doc.child(0))).toBe("right");
    const inner = unwrapAligned(s.doc.child(0))!;
    const tr = new Transform(s.doc).replaceWith(0, s.doc.child(0).nodeSize, inner);
    expect(change(s, tr.doc)).toBe(src);
  });

  it("wraps several blocks at once", () => {
    const s = createSession("latex", "One.\n\nTwo.\n");
    const kids = [s.doc.child(0), s.doc.child(1)];
    const wrapped = wrapAligned(kids, "left", s.context)!;
    const doc = new Transform(s.doc).replaceWith(0, s.doc.content.size, wrapped).doc;
    expect(change(s, doc)).toBe("\\begin{flushleft}\nOne.\n\nTwo.\n\\end{flushleft}\n");
  });

  it("inserts a page break and a vertical gap between paragraphs", () => {
    const s = createSession("latex", "Before.\n\nAfter.\n");
    const pb = schema.nodes.spacer_block.create(latex.spacerAttrs("pagebreak", s.context)!);
    const at = s.doc.child(0).nodeSize;
    expect(change(s, new Transform(s.doc).insert(at, pb).doc)).toBe("Before.\n\n\\newpage\n\nAfter.\n");
    const gap = schema.nodes.spacer_block.create(latex.spacerAttrs("vspace", s.context, "8pt")!);
    expect(gap.attrs.amount).toBe("8pt");
    expect(change(s, new Transform(s.doc).insert(at, gap).doc)).toBe("Before.\n\n\\vspace{8pt}\n\n\\newpage\n\nAfter.\n");
    expect(latex.spacerAttrs("vspace", s.context, "1em}\\x")).toBeNull();
  });

  it("inserts inline spacing atoms and keeps typing after them", () => {
    const s = createSession("latex", "Left right.\n");
    const [, b] = rangeOf(s.doc, "Left");
    const br = schema.nodes.spacing.create(latex.spacingAttrs("break", s.context)!);
    expect(change(s, new Transform(s.doc).insert(b, br).doc)).toBe("Left\\\\ right.\n");
    const [c] = rangeOf(s.doc, "Left");
    const ni = schema.nodes.spacing.create(latex.spacingAttrs("noindent", s.context)!);
    expect(change(s, new Transform(s.doc).insert(c, ni).doc)).toBe("\\noindent Left\\\\ right.\n");
    // Typing "[" right after a line break must not turn into its [length] argument.
    const s2 = createSession("latex", "a b\n");
    const doc = new Transform(s2.doc).insert(2, [br, schema.text("[x]")]).doc;
    expect(change(s2, doc)).toBe("a\\\\{}[x] b\n");
  });

  it("has no page-look helpers for Markdown", () => {
    const s = createSession("markdown", "x\n");
    expect(md.sizeMark("large", s.context)).toBeNull();
    expect(md.colorMark("red", s.context)).toBeNull();
    expect(md.alignAttrs("center", s.context)).toBeNull();
    expect(md.spacerAttrs("pagebreak", s.context)).toBeNull();
    expect(md.spacingAttrs("break", s.context)).toBeNull();
  });
});

describe("falls back to raw rather than guess", () => {
  it("keeps groups it cannot write back exactly as raw chips", () => {
    for (const src of ["{\\large\\large x}", "{\\large}", "{\\color{red}}", "{\\bfseries {\\bf x}}", "{x \\large y}"]) {
      const s = createSession("latex", `A ${src} b\n`);
      expect(s.verify()).toEqual({ ok: true });
      expect(serializeNode(s.doc.child(0), "latex")).toBe(`A ${src} b`);
    }
    const s = createSession("latex", "A {\\large\\large x} b\n");
    expect(s.doc.child(0).child(1).type.name).toBe("raw_inline");
  });

  it("keeps a bare \\vspace without an argument as raw", () => {
    const s = createSession("latex", "Text \\vspace more.\n");
    const names: string[] = [];
    s.doc.child(0).forEach((n) => names.push(n.type.name));
    expect(names).toContain("raw_inline");
    expect(s.verify()).toEqual({ ok: true });
  });
});

describe("lengths and colours for the view", () => {
  it("turns TeX lengths into CSS hints", () => {
    expect(cssLength("6pt")).toBe("6pt");
    expect(cssLength(" -0.5em ")).toBe("-0.5em");
    expect(cssLength("2bp")).toBe("2pt");
    expect(cssLength("1pc")).toBe("12pt");
    expect(cssLength("\\baselineskip")).toBe("1.2em");
    expect(cssLength("2\\baselineskip")).toBe("2.4em");
    expect(cssLength("\\fill")).toBe("fill");
    expect(cssLength("\\stretch{1}")).toBe("fill");
    expect(cssLength("\\mylen")).toBe("");
    expect(cssLength("0.3\\textwidth")).toBe("");
    expect(spacingAmount("\\vspace{6pt}")).toBe("6pt");
    expect(spacingAmount("\\\\[2pt]")).toBe("2pt");
    expect(spacingAmount("\\bigskip % gap")).toBe("12pt");
    expect(spacingAmount("\\qquad ")).toBe("2em");
  });

  it("only ever produces #rrggbb colours", () => {
    expect(cssColor("red")).toBe("#ff0000");
    expect(cssColor("red!50")).toBe("#ff8080");
    expect(cssColor("red!50!blue")).toBe("#800080");
    expect(cssColor("0.2,0.4,0.6", "rgb")).toBe("#336699");
    expect(cssColor("51,102,153", "RGB")).toBe("#336699");
    expect(cssColor("0.5", "gray")).toBe("#808080");
    expect(cssColor("FF8000", "HTML")).toBe("#ff8000");
    expect(cssColor("myColor")).toBeNull();
    expect(cssColor("red; background: url(x)")).toBeNull();
    expect(cssColor("2,0,0", "rgb")).toBeNull();
  });

  it("renders size and colour marks with inline CSS only", () => {
    const size = schema.marks.size.create({ cmd: "LARGE" });
    const sizeDom = schema.marks.size.spec.toDOM!(size, true) as [string, Record<string, string>, number];
    expect(sizeDom[1].style).toBe("font-size: 1.728em");
    expect(sizeDom[1]["data-cmd"]).toBe("LARGE");
    const bad = schema.marks.color.create({ color: "x;y", model: "" });
    const badDom = schema.marks.color.spec.toDOM!(bad, true) as [string, Record<string, string>, number];
    expect(badDom[1].style).toBeUndefined();
  });
});

describe("include targets", () => {
  it("lists candidates next to the current file, then at the root", () => {
    expect(includeCandidates("sec_intro", "main.tex")).toEqual(["sec_intro.tex", "sec_intro"]);
    expect(includeCandidates("sec_intro", "chapters/main.tex")).toEqual([
      "chapters/sec_intro.tex",
      "chapters/sec_intro",
      "sec_intro.tex",
      "sec_intro",
    ]);
    expect(includeCandidates("./parts/a.tex", "main.tex")).toEqual(["parts/a.tex", "parts/a.tex.tex"]);
  });

  it("refuses paths that could leave the project", () => {
    for (const t of ["../secret", "a/../../b", "/etc/passwd", "\\\\server\\share", "C:/Windows/x", "c:x", "~/x", "https://x", "a\\b", "", "  ", "\\macro"]) {
      expect(includeCandidates(t, "chapters/main.tex"), t).toBeNull();
    }
  });

  it("resolves to the first existing file", () => {
    const files = new Set(["sec_intro.tex", "chapters/body.tex"]);
    const exists = (p: string) => files.has(p);
    expect(resolveInclude("sec_intro", "chapters/main.tex", exists)).toBe("sec_intro.tex");
    expect(resolveInclude("body", "chapters/main.tex", exists)).toBe("chapters/body.tex");
    expect(resolveInclude("missing", "main.tex", exists)).toBeNull();
    expect(resolveInclude("../sec_intro", "chapters/main.tex", exists)).toBeNull();
  });
});
