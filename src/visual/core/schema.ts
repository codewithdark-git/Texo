// The one ProseMirror schema both dialects share. Every node and mark keeps
// the exact source spelling it came from in its attrs, so the serializer can
// write it back byte for byte. toDOM / parseDOM carry all attrs as data-*
// attributes, so copy and paste inside Visual mode keeps the source.

import { Schema } from "prosemirror-model";
import type { DOMOutputSpec, MarkSpec, NodeSpec, TagParseRule } from "prosemirror-model";
import { cssColor, SIZE_SCALE } from "./latex/style";

type AttrDefaults = Record<string, unknown>;

/** Turns an attrs record into data-* attributes (non-strings as JSON). */
function dataAttrs(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out["data-" + k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/** Reads attrs back from data-* attributes, falling back to the defaults. */
function readAttrs(dom: HTMLElement, defaults: AttrDefaults): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(defaults)) {
    const raw = dom.getAttribute("data-" + k);
    if (raw === null) out[k] = def;
    else if (typeof def === "string") out[k] = raw;
    else {
      try {
        out[k] = JSON.parse(raw);
      } catch {
        out[k] = def;
      }
    }
  }
  return out;
}

function attrSpec(defaults: AttrDefaults) {
  const spec: Record<string, { default: unknown }> = {};
  for (const [k, v] of Object.entries(defaults)) spec[k] = { default: v };
  return spec;
}

/** A node spec whose DOM form is `<tag data-node=name data-*>`. */
function node(name: string, tag: string, defaults: AttrDefaults, extra: Partial<NodeSpec>): NodeSpec {
  const hasContent = extra.content !== undefined && extra.content !== "";
  return {
    attrs: attrSpec(defaults),
    ...extra,
    toDOM(n): DOMOutputSpec {
      const attrs = { "data-node": name, ...dataAttrs(n.attrs) };
      return hasContent ? [tag, attrs, 0] : [tag, attrs];
    },
    parseDOM: [
      {
        tag: `${tag}[data-node="${name}"]`,
        getAttrs: (dom: HTMLElement) => readAttrs(dom, defaults),
        ...(extra.code ? { preserveWhitespace: "full" as const } : {}),
      },
    ],
  };
}

const BLOCK_ATOM = { atom: true, selectable: true, group: "block" };
const INLINE_ATOM = { atom: true, inline: true, group: "inline", selectable: true };

const nodes: Record<string, NodeSpec> = {
  doc: { content: "preamble? block* postamble?" },
  preamble: node("preamble", "div", { src: "" }, { atom: true, selectable: true }),
  postamble: node("postamble", "div", { src: "" }, { atom: true, selectable: true }),
  paragraph: {
    content: "inline*",
    group: "block",
    toDOM: () => ["p", 0],
    parseDOM: [{ tag: "p" }],
  },
  heading: node(
    "heading",
    "h2",
    { cmd: "section", level: 2, open: "\\section{", close: "}", trail: "" },
    { content: "inline*", group: "block", defining: true },
  ),
  list: node(
    "list",
    "div",
    { kind: "bullet", begin: "", end: "", gaps: [] },
    { content: "list_item+", group: "block" },
  ),
  list_item: node("list_item", "div", { head: "", indent: "", gaps: [] }, { content: "block+", defining: true }),
  container: node(
    "container",
    "div",
    // align: "center" | "left" | "right" for center / flushleft / flushright, else "".
    { kind: "quote", env: "quote", label: "", begin: "", end: "", prefix: "", gaps: [], align: "" },
    { content: "block*", group: "block", defining: true },
  ),
  math_display: node("math_display", "div", { open: "\\[", body: "", close: "\\]", env: "" }, BLOCK_ATOM),
  code_block: node(
    "code_block",
    "pre",
    { begin: "", end: "", lang: "" },
    { content: "text*", marks: "", code: true, group: "block", defining: true },
  ),
  figure: node(
    "figure",
    "figure",
    { head: "", tail: "", path: "", label: "" },
    { content: "figure_caption?", group: "block" },
  ),
  figure_caption: node("figure_caption", "figcaption", { open: "", close: "" }, { content: "inline*" }),
  table_block: node("table_block", "div", { src: "", caption: "", label: "" }, BLOCK_ATOM),
  raw_block: node("raw_block", "div", { src: "", label: "" }, BLOCK_ATOM),
  comment_block: node("comment_block", "div", { src: "" }, BLOCK_ATOM),
  command_block: node("command_block", "div", { src: "", kind: "", target: "" }, BLOCK_ATOM),
  // A line that only adds vertical space or starts a new page (\vspace{..},
  // \bigskip, \newpage, \clearpage). kind: "vspace" | "pagebreak"; amount is
  // a CSS length hint ("6pt", "1.2em", "fill") or "".
  spacer_block: node("spacer_block", "div", { src: "", kind: "vspace", amount: "" }, BLOCK_ATOM),
  text: { group: "inline" },
  softbreak: node("softbreak", "span", { src: "\n" }, INLINE_ATOM),
  glyph: node("glyph", "span", { src: "", display: "" }, INLINE_ATOM),
  // Spacing and break commands inside text (\quad, \hspace{..}, \noindent,
  // \\, \par, \newpage). kind: "hspace" | "vspace" | "noindent" | "break" |
  // "pagebreak" | "thin"; amount as for spacer_block.
  spacing: node("spacing", "span", { src: "", kind: "hspace", amount: "" }, INLINE_ATOM),
  math_inline: node("math_inline", "span", { open: "$", body: "", close: "$" }, INLINE_ATOM),
  cite: node("cite", "span", { src: "", cmd: "cite", keys: [] }, INLINE_ATOM),
  ref: node("ref", "span", { src: "", cmd: "ref", keys: [] }, INLINE_ATOM),
  label: node("label", "span", { src: "", key: "" }, INLINE_ATOM),
  footnote: node("footnote", "span", { src: "", body: "" }, INLINE_ATOM),
  url: node("url", "span", { src: "", url: "" }, INLINE_ATOM),
  image: node("image", "span", { src: "", path: "", alt: "" }, INLINE_ATOM),
  raw_inline: node("raw_inline", "span", { src: "", label: "" }, INLINE_ATOM),
};

/** Canonical LaTeX spellings, used for pasted HTML without data attributes. */
const CANONICAL: Record<string, [string, string]> = {
  bold: ["\\textbf{", "}"],
  italic: ["\\emph{", "}"],
  underline: ["\\underline{", "}"],
  code: ["\\texttt{", "}"],
  smallcaps: ["\\textsc{", "}"],
  sans: ["\\textsf{", "}"],
  sup: ["\\textsuperscript{", "}"],
  sub: ["\\textsubscript{", "}"],
  strike: ["~~", "~~"],
  link: ["\\href{}{", "}"],
  size: ["{\\normalsize ", "}"],
  color: ["\\textcolor{black}{", "}"],
};

/**
 * A mark spec. `extra` adds attrs beyond the spelling (a size's command, a
 * colour's name) and `style` gives the inline CSS that shows the mark.
 */
function mark(
  name: string,
  tag: string,
  cls: string | null,
  inclusive: boolean,
  extra: AttrDefaults = {},
  style?: (attrs: Record<string, unknown>) => string | null,
): MarkSpec {
  const isLink = name === "link";
  const defaults: AttrDefaults = { open: CANONICAL[name][0], close: CANONICAL[name][1], gid: 0, depth: 0, ...extra };
  if (isLink) defaults.href = "";
  const selector = cls ? `${tag}.${cls}` : tag;
  const rules: TagParseRule[] = [
    {
      tag: selector,
      getAttrs: (dom: HTMLElement) => {
        const attrs = readAttrs(dom, defaults);
        if (isLink && !dom.hasAttribute("data-href")) {
          const href = dom.getAttribute("href") ?? "";
          attrs.href = href;
          if (!dom.hasAttribute("data-open")) attrs.open = `\\href{${href}}{`;
        }
        return attrs;
      },
    },
  ];
  return {
    attrs: attrSpec(defaults),
    inclusive,
    toDOM(m): DOMOutputSpec {
      const attrs: Record<string, string> = {
        "data-open": m.attrs.open,
        "data-close": m.attrs.close,
        "data-gid": String(m.attrs.gid),
        "data-depth": String(m.attrs.depth),
      };
      if (cls) attrs.class = cls;
      for (const k of Object.keys(extra)) attrs["data-" + k] = String(m.attrs[k]);
      const css = style?.(m.attrs);
      if (css) attrs.style = css;
      if (isLink) {
        // Never render a live href: a document could hold `javascript:` or
        // other unsafe URLs. The UI opens links through a click handler that
        // allows only http(s) and mailto, in the user's browser.
        attrs["data-href"] = m.attrs.href;
        attrs.title = m.attrs.href;
      }
      return [tag, attrs, 0];
    },
    parseDOM: rules,
  };
}

const marks: Record<string, MarkSpec> = {
  bold: mark("bold", "strong", null, true),
  italic: mark("italic", "em", null, true),
  underline: mark("underline", "u", null, true),
  code: mark("code", "code", null, false),
  smallcaps: mark("smallcaps", "span", "sc", true),
  sans: mark("sans", "span", "sf", true),
  sup: mark("sup", "sup", null, true),
  sub: mark("sub", "sub", null, true),
  strike: mark("strike", "s", null, true),
  link: mark("link", "a", null, false),
  // {\large ..}: cmd is the size command's name.
  size: mark("size", "span", "v-size", true, { cmd: "normalsize" }, (a) => {
    const em = SIZE_SCALE[a.cmd as string];
    return em ? `font-size: ${em}em` : null;
  }),
  // \textcolor{red}{..} or {\color{red} ..}: model is the optional [model].
  color: mark("color", "span", "v-color", true, { color: "black", model: "" }, (a) => {
    const css = cssColor(a.color as string, a.model as string);
    return css ? `color: ${css}` : null;
  }),
};

export const schema = new Schema({ nodes, marks });

/** Block nodes that are atoms and serialize as their `src` attr. */
export const SRC_ATOMS = new Set(["preamble", "postamble", "table_block", "raw_block", "comment_block", "command_block", "spacer_block"]);
