import { describe, expect, it, afterEach } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { atoms, createSession, helpersFor, schema, semEq, type TextEdit, type VisualSession } from "./index";
import { testHooks } from "./session";

/** Applies edits (sorted, against the old text) to a string. */
function applyEdits(text: string, edits: TextEdit[]): string {
  let out = "";
  let pos = 0;
  for (const e of edits) {
    expect(e.offset).toBeGreaterThanOrEqual(pos);
    out += text.slice(pos, e.offset) + e.insert;
    pos = e.offset + e.deleteLength;
  }
  return out + text.slice(pos);
}

function realKids(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.forEach((n) => {
    if (!(n.type.name === "paragraph" && n.content.size === 0)) out.push(n);
  });
  return out;
}

/** Plans newDoc, checks every invariant, commits, and returns the edits. */
function change(s: VisualSession, newDoc: PMNode): TextEdit[] {
  const before = s.text;
  const res = s.plan(newDoc);
  if (!res.ok) throw new Error("plan failed: " + res.reason);
  expect(applyEdits(before, res.edits)).toBe(res.newText);
  const reparsed = realKids(createSession(s.dialect, res.newText).doc);
  const wanted = realKids(newDoc);
  expect(reparsed.length).toBe(wanted.length);
  reparsed.forEach((n, i) => expect(semEq(n, wanted[i])).toBe(true));
  s.commit(newDoc, res.newText);
  expect(s.text).toBe(res.newText);
  expect(s.verify()).toEqual({ ok: true });
  expect(s.syncFromText(res.newText).changed).toBe(false);
  return res.edits;
}

/** Position just inside the start of the first text matching `needle`. */
function posOf(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found !== -1) return false;
    if (n.isText && n.text!.includes(needle)) found = pos + n.text!.indexOf(needle);
    return true;
  });
  if (found === -1) throw new Error("not found: " + needle);
  return found;
}

/** The position of the top-level child at `index`. */
function childPos(doc: PMNode, index: number): number {
  let p = 0;
  for (let i = 0; i < index; i++) p += doc.child(i).nodeSize;
  return p;
}

const BODY = "\\section{Intro}\n\nHello world, this is text.\n\nSecond paragraph here.\n";

afterEach(() => {
  testHooks.corruptRegion = null;
});

describe("session edits", () => {
  it("types one character as exactly one 1-char edit", () => {
    const s = createSession("latex", BODY);
    const at = posOf(s.doc, "world");
    const edits = change(s, ins(new Transform(s.doc), "X", at).doc);
    expect(edits).toEqual([{ offset: BODY.indexOf("world"), deleteLength: 0, insert: "X" }]);
  });

  it("escapes special characters as they are typed", () => {
    const s = createSession("latex", BODY);
    const at = posOf(s.doc, "world");
    const edits = change(s, ins(new Transform(s.doc), "50% & a_b $ ", at).doc);
    expect(edits).toEqual([{ offset: BODY.indexOf("world"), deleteLength: 0, insert: "50\\% \\& a\\_b \\$ " }]);
  });

  it("bolds a word and changes nothing else", () => {
    const s = createSession("latex", BODY);
    const at = posOf(s.doc, "world");
    const attrs = helpersFor("latex").newMark("bold", s.context)!;
    const doc = new Transform(s.doc).addMark(at, at + 5, schema.marks.bold.create(attrs)).doc;
    change(s, doc);
    expect(s.text).toBe(BODY.replace("world", "\\textbf{world}"));
  });

  it("splits a paragraph, then typing in the new one inserts a blank line and text", () => {
    const s = createSession("latex", BODY);
    const end = posOf(s.doc, "text.") + 5;
    const split = new Transform(s.doc).split(end).doc;
    expect(change(s, split)).toEqual([]);
    const inside = end + 2;
    const edits = change(s, ins(new Transform(s.doc), "New", inside).doc);
    const at = BODY.indexOf("text.") + 5;
    expect(edits).toEqual([{ offset: at, deleteLength: 0, insert: "\n\nNew" }]);
  });

  it("joins two paragraphs", () => {
    const s = createSession("latex", BODY);
    const second = childPos(s.doc, 2);
    change(s, new Transform(s.doc).join(second).doc);
    expect(s.text).toBe("\\section{Intro}\n\nHello world, this is text.Second paragraph here.\n");
  });

  it("changes \\section to \\subsection by the command name only", () => {
    const s = createSession("latex", "\\section*[Short]{Intro}\\label{s}\n\nText.\n");
    const h = s.doc.firstChild!;
    const attrs = helpersFor("latex").headingAttrs(2, s.context, h.attrs);
    const edits = change(s, new Transform(s.doc).setNodeMarkup(0, undefined, attrs).doc);
    expect(s.text).toBe("\\subsection*[Short]{Intro}\\label{s}\n\nText.\n");
    expect(edits).toHaveLength(1);
    expect(edits[0].deleteLength).toBe(0);
    expect(edits[0].insert.length).toBe(3);
  });

  it("adds a list item with the inferred indentation", () => {
    const text = "\\begin{itemize}\n    \\item a\n    \\item b\n\\end{itemize}\n";
    const s = createSession("latex", text);
    const list = s.doc.firstChild!;
    expect(list.type.name).toBe("list");
    const h = helpersFor("latex");
    const item = schema.nodes.list_item.create(h.itemAttrs("bullet", 2, s.context), schema.nodes.paragraph.create(null, schema.text("c")));
    const doc = new Transform(s.doc).insert(list.nodeSize - 1, item).doc;
    change(s, doc);
    expect(s.text).toBe("\\begin{itemize}\n    \\item a\n    \\item b\n    \\item c\n\\end{itemize}\n");
  });

  it("edits a maths body through atoms.setMathBody", () => {
    const text = "Before.\n\n\\begin{equation}\n  a = b\n\\end{equation}\n\nAfter.\n";
    const s = createSession("latex", text);
    const pos = childPos(s.doc, 1);
    const math = s.doc.child(1);
    change(s, new Transform(s.doc).setNodeMarkup(pos, undefined, atoms.setMathBody(math.attrs, (math.attrs.body as string).replace("b", "c"))).doc);
    expect(s.text).toBe(text.replace("a = b", "a = c"));
  });

  it("edits only a figure caption", () => {
    const text = "\\begin{figure}\n  \\centering\n  \\includegraphics{x.png}\n  \\caption{Old}\n  \\label{fig:x}\n\\end{figure}\n";
    const s = createSession("latex", text);
    expect(s.doc.firstChild!.type.name).toBe("figure");
    const at = posOf(s.doc, "Old");
    const edits = change(s, ins(new Transform(s.doc), "New ", at).doc);
    expect(edits).toEqual([{ offset: text.indexOf("Old"), deleteLength: 0, insert: "New " }]);
  });

  it("deletes a block together with one gap", () => {
    const s = createSession("latex", BODY);
    const p = childPos(s.doc, 1);
    change(s, new Transform(s.doc).delete(p, p + s.doc.child(1).nodeSize).doc);
    expect(s.text).toBe("\\section{Intro}\n\nSecond paragraph here.\n");
  });

  it("deletes the last block", () => {
    const s = createSession("latex", BODY);
    const p = childPos(s.doc, 2);
    change(s, new Transform(s.doc).delete(p, p + s.doc.child(2).nodeSize).doc);
    expect(s.text).toBe("\\section{Intro}\n\nHello world, this is text.\n");
  });

  it("gives separate edits for a preamble package and a body insert", () => {
    const text = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\nHello.\n\n\\end{document}\n";
    const s = createSession("latex", text);
    const pre = s.doc.firstChild!;
    const newPre = helpersFor("latex").ensurePackage(pre.attrs.src, "hyperref", s.context)!;
    expect(newPre).not.toBeNull();
    const tr = new Transform(s.doc).setNodeMarkup(0, undefined, { src: newPre });
    ins(tr, "!", posOf(tr.doc, "Hello") + 5);
    const edits = change(s, tr.doc);
    expect(edits).toHaveLength(2);
    expect(s.text).toBe(text.replace("\\begin{document}", "\\usepackage{hyperref}\n\\begin{document}").replace("Hello.", "Hello!."));
    expect(helpersFor("latex").ensurePackage(s.doc.firstChild!.attrs.src, "hyperref", s.context)).toBeNull();
  });

  it("keeps the identity of unchanged blocks on inbound edits", () => {
    const paras = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with some words.`);
    const text = paras.join("\n\n") + "\n";
    const s = createSession("latex", text);
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let cur = text;
    for (let round = 0; round < 30; round++) {
      const oldKids: PMNode[] = [];
      s.doc.forEach((n) => oldKids.push(n));
      const target = Math.floor(rnd() * 40);
      const at = cur.indexOf(`number ${target} `) + 7;
      cur = cur.slice(0, at) + "x" + cur.slice(at);
      const r = s.syncFromText(cur);
      expect(r.changed).toBe(true);
      expect(s.verify()).toEqual({ ok: true });
      let same = 0;
      s.doc.forEach((n, _o, i) => {
        if (n === oldKids[i]) same++;
      });
      expect(same).toBe(39);
      // The diff window covers exactly the changed paragraph.
      const tr = new Transform(oldKidsDoc(oldKids)).replaceWith(r.from, r.toOld, r.doc.slice(r.from, r.toNew).content);
      expect(tr.doc.eq(s.doc)).toBe(true);
    }
  });

  it("refuses a change whose text would not parse back", () => {
    const s = createSession("latex", BODY);
    const at = posOf(s.doc, "world");
    testHooks.corruptRegion = (src) => src.replace("X", "\\textbf{");
    const res = s.plan(ins(new Transform(s.doc), "X", at).doc);
    expect(res.ok).toBe(false);
    expect(s.text).toBe(BODY);
  });

  it("refuses text that would merge into the next block", () => {
    const s = createSession("latex", "Para one.\n\nPara two.\n");
    // A raw block whose source opens a group swallows what follows.
    const tr = new Transform(s.doc).replaceWith(0, s.doc.child(0).nodeSize, schema.nodes.raw_block.create({ src: "{open", label: "x" }));
    expect(s.plan(tr.doc).ok).toBe(false);
  });

  it("maps positions both ways", () => {
    const s = createSession("latex", BODY);
    const at = posOf(s.doc, "world");
    expect(s.pmToSrc(at)).toBe(BODY.indexOf("world"));
    expect(s.srcToPm(BODY.indexOf("world"))).toBe(at);
    const h = posOf(s.doc, "Intro");
    expect(s.pmToSrc(h)).toBe(BODY.indexOf("Intro"));
    expect(s.srcToPm(0)).toBe(1);
    const blk = s.topBlockAt(at);
    expect(blk.index).toBe(1);
    expect(s.doc.nodeAt(blk.start)!.type.name).toBe("paragraph");
  });

  it("maps through escapes", () => {
    const text = "Cost 50\\% of \\textbf{all} items.\n";
    const s = createSession("latex", text);
    const at = posOf(s.doc, "all");
    expect(s.pmToSrc(at)).toBe(text.indexOf("all"));
    expect(s.srcToPm(text.indexOf("of"))).toBe(posOf(s.doc, "of"));
  });

  it("serializes slices and parses snippets", () => {
    const s = createSession("latex", BODY);
    const frag = s.parseSnippet("\\section{A}\n\nSome \\emph{b} text.");
    expect(frag.childCount).toBe(2);
    expect(frag.child(0).type.name).toBe("heading");
    const inl = s.parseInlineSnippet("x \\emph{y}");
    expect(inl.childCount).toBe(2);
    const slice = s.doc.slice(childPos(s.doc, 1), childPos(s.doc, 3));
    expect(s.serializeSlice(slice)).toBe("Hello world, this is text.\n\nSecond paragraph here.");
    expect(s.parseSnippet("{unclosed").child(0).type.name).toBe("raw_block");
  });

  it("types a space at the end of a paragraph, then the next word", () => {
    for (const [dialect, text] of [
      ["latex", BODY],
      ["markdown", "# Intro\n\nHello world, this is text.\n\nSecond paragraph here.\n"],
    ] as const) {
      const s = createSession(dialect, text);
      const end = posOf(s.doc, "text.") + 5;
      change(s, ins(new Transform(s.doc), " ", end).doc);
      expect(s.text).toBe(text.replace("text.", "text. "));
      change(s, ins(new Transform(s.doc), "More", end + 1).doc);
      expect(s.text).toBe(text.replace("text.", "text. More"));
    }
  });

  it("accepts an empty list item, as Enter in a list makes", () => {
    for (const [dialect, text] of [
      ["latex", "\\begin{itemize}\n  \\item a\n\\end{itemize}\n\nAfter.\n"],
      ["markdown", "- a\n\nAfter.\n"],
    ] as const) {
      const s = createSession(dialect, text);
      const list = s.doc.firstChild!;
      const item = schema.nodes.list_item.create(helpersFor(dialect).itemAttrs("bullet", 1, s.context), schema.nodes.paragraph.create());
      change(s, new Transform(s.doc).insert(list.nodeSize - 1, item).doc);
      const typed = posOf(s.doc, "a") + 1;
      expect(typed).toBeGreaterThan(0);
    }
  });

  it("inserts new display maths in either style and parses it back the same", () => {
    for (const style of ["brackets", "equation"] as const) {
      const text = "Before.\n\nAfter.\n";
      const s = createSession("latex", text);
      const math = schema.nodes.math_display.create(helpersFor("latex").mathDisplayAttrs("E = mc^2", s.context, style));
      change(s, new Transform(s.doc).insert(childPos(s.doc, 1), math).doc);
      expect(s.text).toBe(
        style === "brackets"
          ? "Before.\n\n\\[\n  E = mc^2\n\\]\n\nAfter.\n"
          : "Before.\n\n\\begin{equation*}\n  E = mc^2\n\\end{equation*}\n\nAfter.\n",
      );
    }
  });

  it("splits a paragraph inside a quote with a blank line, in both dialects", () => {
    const cases = [
      ["latex", "Before.\n\n\\begin{quote}\nQuoted text.\n\\end{quote}\n", "\\begin{quote}\nQuoted \n\ntext.\n\\end{quote}"],
      ["markdown", "Before.\n\n> quote text\n", "> quote \n>\n> text"],
    ] as const;
    for (const [dialect, text, want] of cases) {
      const s = createSession(dialect, text);
      const at = posOf(s.doc, dialect === "latex" ? "text." : "text");
      change(s, new Transform(s.doc).split(at).doc);
      expect(s.text).toContain(want);
    }
  });

  it("accepts Enter at the end of a quote, then typing in the new paragraph", () => {
    const cases = [
      ["latex", "Before.\n\n\\begin{quote}\nQuoted.\n\\end{quote}\n\nAfter.\n", "\\begin{quote}\nQuoted.\n\nNext\n\\end{quote}"],
      ["markdown", "Before.\n\n> Quoted.\n\nAfter.\n", "> Quoted.\n>\n> Next\n"],
    ] as const;
    for (const [dialect, text, want] of cases) {
      const s = createSession(dialect, text);
      const end = posOf(s.doc, "Quoted.") + "Quoted.".length;
      // The new empty paragraph writes nothing yet.
      expect(change(s, new Transform(s.doc).split(end).doc)).toEqual([]);
      expect(s.text).toBe(text);
      change(s, ins(new Transform(s.doc), "Next", end + 2).doc);
      expect(s.text).toContain(want);
    }
  });

  it("adds a second paragraph to a list item with a blank line", () => {
    const md = "- one\n";
    const s = createSession("markdown", md);
    const list = s.doc.firstChild!;
    const end = list.nodeSize - 2;
    change(s, new Transform(s.doc).insert(end, schema.nodes.paragraph.create(null, schema.text("two"))).doc);
    expect(s.text).toBe("- one\n\n  two\n");
  });

  it("works for Markdown too", () => {
    const md = "# Title\n\nSome *text* here.\n\n- a\n- b\n";
    const s = createSession("markdown", md);
    const at = posOf(s.doc, "here");
    change(s, ins(new Transform(s.doc), "_x* ", at).doc);
    expect(s.text).toBe("# Title\n\nSome *text* \\_x\\* here.\n\n- a\n- b\n");
    const h = s.doc.firstChild!;
    change(s, new Transform(s.doc).setNodeMarkup(0, undefined, helpersFor("markdown").headingAttrs(2, s.context, h.attrs)).doc);
    expect(s.text.startsWith("## Title\n")).toBe(true);
  });
});

/** Inserts text at pos with the marks there, as typing does. */
function ins(tr: Transform, text: string, pos: number): Transform {
  return tr.insert(pos, schema.text(text, tr.doc.resolve(pos).marks()));
}

function oldKidsDoc(kids: PMNode[]): PMNode {
  return schema.nodes.doc.create(null, kids);
}
