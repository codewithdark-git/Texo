import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { createSession, helpersFor, readContext, serializeNode } from "./index";

function doc(src: string) {
  const s = createSession("markdown", src);
  expect(s.verify()).toEqual({ ok: true });
  return s.doc;
}

function names(d: PMNode): string[] {
  const out: string[] = [];
  d.forEach((n) => out.push(n.type.name));
  return out;
}

function inline(p: PMNode): string[] {
  const out: string[] = [];
  p.forEach((n) => {
    const m = n.marks.map((x) => `${x.type.name}(${x.attrs.open}|${x.attrs.close})`).join("+");
    out.push((m ? `[${m}]` : "") + (n.isText ? n.text : `<${n.type.name}:${n.attrs.src ?? n.attrs.open + n.attrs.body + n.attrs.close}>`));
  });
  return out;
}

describe("markdown blocks", () => {
  it("splits headings, paragraphs, lists, quotes, code, hr, maths and tables", () => {
    const src = "# A\n\nText.\n\nSetext\n---\n\n- x\n- y\n\n> q\n\n```py\nprint(1)\n```\n\n---\n\n$$\nx^2\n$$\n\n| a |\n|---|\n| 1 |\n";
    expect(names(doc(src))).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "container",
      "code_block",
      "command_block",
      "math_display",
      "table_block",
    ]);
  });

  it("records heading spellings", () => {
    const d = doc("## Title ##\n\nSub\n===\n");
    expect(d.child(0).attrs).toMatchObject({ open: "## ", close: " ##", level: 2 });
    expect(d.child(1).attrs).toMatchObject({ open: "", close: "\n===", level: 1 });
  });

  it("keeps list markers, indents and tightness", () => {
    const d = doc("1. one\n2. two\n\n   more\n");
    const list = d.child(0);
    expect(list.attrs.kind).toBe("ordered");
    expect(list.child(1).attrs).toMatchObject({ head: "2. ", indent: "   " });
    expect(list.child(1).childCount).toBe(2);
    expect(list.attrs.gaps).toEqual(["", "\n", ""]);
  });

  it("makes a list with a lazy continuation raw", () => {
    expect(names(doc("- item\nlazy line\n"))).toEqual(["raw_block"]);
  });

  it("parses a blockquote with its prefix", () => {
    const q = doc("> a\n>\n> b\n").child(0);
    expect(q.type.name).toBe("container");
    expect(q.attrs.prefix).toBe("> ");
    expect(q.childCount).toBe(2);
  });

  it("keeps front matter as the preamble and reference definitions raw", () => {
    const d = doc("---\ntitle: X\n---\n\nSee [a][r].\n\n[r]: http://x\n");
    expect(names(d)).toEqual(["preamble", "paragraph", "raw_block"]);
    expect(d.child(2).attrs.src).toBe("[r]: http://x");
    expect(readContext("markdown", "---\ntitle: \"My Doc\"\n---\n").title).toBe("My Doc");
  });

  it("keeps html and indented code raw", () => {
    expect(names(doc("<div>\nx\n</div>\n\n    code\n"))).toEqual(["raw_block", "raw_block"]);
  });
});

describe("markdown inline", () => {
  it("maps emphasis, strong, strike and code with their markup", () => {
    const p = doc("*a* _b_ **c** __d__ ~~e~~ `f` `` g ``").child(0);
    expect(inline(p)).toEqual([
      "[italic(*|*)]a",
      " ",
      "[italic(_|_)]b",
      " ",
      "[bold(**|**)]c",
      " ",
      "[bold(__|__)]d",
      " ",
      "[strike(~~|~~)]e",
      " ",
      "[code(`|`)]f",
      " ",
      "[code(`` | ``)]g",
    ]);
  });

  it("maps links, autolinks, reference links and images", () => {
    const p = doc('[t](http://u "T") <http://a> [r][x] ![alt](p.png)\n\n[x]: http://x').child(0);
    expect(inline(p)).toEqual([
      '[link([|](http://u "T"))]t',
      " ",
      "<url:<http://a>>",
      " ",
      "<raw_inline:[r][x]>",
      " ",
      "<image:![alt](p.png)>",
    ]);
    expect(p.child(6).attrs).toMatchObject({ path: "p.png", alt: "alt" });
  });

  it("maps breaks, escapes, entities, html and maths", () => {
    const p = doc("a  \nb\\\nc\n  d \\* &amp; <b>x</b> $m$").child(0);
    expect(inline(p)).toEqual([
      "a",
      "<raw_inline:  \n>",
      "b",
      "<raw_inline:\\\n>",
      "c",
      "<softbreak:\n  >",
      "d ",
      "<glyph:\\*>",
      " ",
      "<glyph:&amp;>",
      " ",
      "<raw_inline:<b>>",
      "x",
      "<raw_inline:</b>>",
      " ",
      "<math_inline:$m$>",
    ]);
  });

  it("keeps characters the escaper would touch as glyphs", () => {
    const p = doc("snake_case and a lone * star").child(0);
    expect(serializeNode(p, "markdown")).toBe("snake_case and a lone * star");
    expect(inline(p).filter((s) => s.startsWith("<"))).toEqual(["<glyph:_>", "<glyph:*>"]);
  });
});

describe("markdown helpers", () => {
  it("follows the file's bullet and emphasis style", () => {
    const ctx = readContext("markdown", "* a\n* b\n\n_x_ and _y_\n");
    const h = helpersFor("markdown");
    expect(h.itemAttrs("bullet", 0, ctx).head).toBe("* ");
    expect(h.newMark("italic", ctx)).toMatchObject({ open: "_", close: "_" });
    expect(h.newMark("underline", ctx)).toBeNull();
    expect(h.figureSrc("img/a.png", "", ctx)).toBe("![](img/a.png)");
    expect(h.ensurePackage("", "x", ctx)).toBeNull();
    expect(h.tableSrc(1, 2, ctx).split("\n")).toHaveLength(3);
    expect(h.headingAttrs(3, ctx)).toMatchObject({ open: "### ", close: "" });
  });
});
