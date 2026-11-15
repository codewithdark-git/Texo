// Markdown inline parsing. markdown-it tokenizes the inline source; an aligner
// walks the tokens against the source with a cursor, checking each token's
// spelling, and builds PM inline nodes whose marks record the exact markup.
// Any mismatch makes the whole block raw (the caller gets null).

import type { Mark, Node as PMNode } from "prosemirror-model";
import type { Token } from "markdown-it";
import { register } from "../registry";
import { schema } from "../schema";
import { escapeIndices } from "./serialize";
import { md, type MdEnv } from "./md";

export interface MdInlineState {
  gid: number;
}

class Mismatch extends Error {}

const MARKS: Record<string, string> = { strong: "bold", em: "italic", s: "strike" };

function atom(type: string, attrs: Record<string, unknown>): PMNode {
  const node = schema.nodes[type].create(attrs);
  return register(node, type === "math_inline" ? `${attrs.open}${attrs.body}${attrs.close}` : (attrs.src as string));
}

/** Index just past the "]" matching the "[" at `at`, honouring backslash escapes and code spans loosely. */
function closeBracket(src: string, at: number): number {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Index just past the ")" closing a link destination whose "(" is at `at`. */
function closeParen(src: string, at: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "<") {
      const e = src.indexOf(">", i);
      if (e !== -1) i = e;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

interface Frame {
  type: string;
  mark: Mark | null;
  start: number;
  nodes: PMNode[];
}

class Aligner {
  pos = 0;
  /** True at the start of the content and after a line break. */
  lineFlag = true;
  frames: Frame[] = [{ type: "root", mark: null, start: 0, nodes: [] }];

  constructor(
    readonly src: string,
    readonly state: MdInlineState,
    lineStart: boolean,
  ) {
    this.lineFlag = lineStart;
  }

  expect(s: string) {
    if (!this.src.startsWith(s, this.pos)) throw new Mismatch(`expected ${JSON.stringify(s)} at ${this.pos}`);
    this.pos += s.length;
  }

  get top(): Frame {
    return this.frames[this.frames.length - 1];
  }

  push(node: PMNode) {
    this.top.nodes.push(node);
    this.lineFlag = false;
  }

  /** True when the cursor is at the first non-space position of a line. */
  atLineStart(): boolean {
    if (!this.lineFlag) return false;
    for (let i = this.pos - 1; i >= 0; i--) {
      const c = this.src[i];
      if (c === "\n") return true;
      if (c !== " " && c !== "\t") return false;
    }
    return true;
  }

  text(content: string) {
    this.expect(content);
    if (content === "") return;
    const ls = this.atLineStartBefore(content);
    let last = 0;
    for (const i of escapeIndices(content, ls)) {
      if (i > last) this.top.nodes.push(schema.text(content.slice(last, i)));
      this.top.nodes.push(atom("glyph", { src: content[i], display: content[i] }));
      last = i + 1;
    }
    if (last < content.length) this.top.nodes.push(schema.text(content.slice(last)));
    this.lineFlag = false;
  }

  /** Line-start state at the beginning of `content`, which the cursor has just passed. */
  atLineStartBefore(content: string): boolean {
    this.pos -= content.length;
    const r = this.atLineStart();
    this.pos += content.length;
    return r;
  }

  open(type: string, markup: string, extra: Record<string, unknown> = {}) {
    const markType = type === "link" ? "link" : type === "code_inline" ? "code" : MARKS[type];
    if (this.frames.some((f) => f.mark?.type.name === markType)) throw new Mismatch("nested " + markType);
    const depth = this.frames.length - 1;
    const attrs = { open: markup, close: "", gid: this.state.gid++, depth, ...extra };
    this.frames.push({ type, mark: schema.marks[markType].create(attrs), start: this.pos - markup.length, nodes: [] });
  }

  close(type: string, markup: string) {
    const f = this.frames.pop()!;
    if (!f || f.type !== type || !f.mark) throw new Mismatch("bad close " + type);
    if (f.nodes.length === 0) throw new Mismatch("empty group");
    const mark = f.mark.type.create({ ...f.mark.attrs, close: markup });
    for (const n of f.nodes) this.top.nodes.push(n.mark(mark.addToSet(n.marks)));
    this.lineFlag = false;
  }

  /** Replaces everything since a frame opened with one raw chip of its source. */
  collapse(f: Frame, end: number, label: string) {
    this.pos = end;
    this.push(atom("raw_inline", { src: this.src.slice(f.start, end), label }));
  }

  run(tokens: Token[]) {
    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      switch (tok.type) {
        case "text":
          this.text(tok.content);
          break;
        case "text_special":
          this.expect(tok.markup);
          this.push(atom("glyph", { src: tok.markup, display: tok.content }));
          break;
        case "softbreak": {
          const m = /^[ \t]*\r?\n[ \t]*/.exec(this.src.slice(this.pos));
          if (!m) throw new Mismatch("softbreak");
          this.pos += m[0].length;
          this.push(atom("softbreak", { src: m[0] }));
          this.lineFlag = true;
          break;
        }
        case "hardbreak": {
          const m = /^(?: {2,}|\\)\r?\n[ \t]*/.exec(this.src.slice(this.pos)) ?? /^[ \t]*\\?\r?\n[ \t]*/.exec(this.src.slice(this.pos));
          if (!m) throw new Mismatch("hardbreak");
          this.pos += m[0].length;
          this.push(atom("raw_inline", { src: m[0], label: "↵" }));
          this.lineFlag = true;
          break;
        }
        case "strong_open":
        case "em_open":
        case "s_open":
          this.expect(tok.markup);
          this.open(tok.type.slice(0, -5), tok.markup);
          break;
        case "strong_close":
        case "em_close":
        case "s_close":
          this.expect(tok.markup);
          this.close(tok.type.slice(0, -6), tok.markup);
          break;
        case "code_inline": {
          const ticks = tok.markup;
          this.expect(ticks);
          const end = this.src.indexOf(ticks, this.pos);
          if (end === -1) throw new Mismatch("code");
          let inner = this.src.slice(this.pos, end);
          if (/[\r\n]/.test(inner) || inner === "") throw new Mismatch("code span");
          let open = ticks;
          let close = ticks;
          if (inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "") {
            open += " ";
            close = " " + close;
            inner = inner.slice(1, -1);
          }
          if (inner !== tok.content) throw new Mismatch("code content");
          const mark = schema.marks.code.create({ open, close, gid: this.state.gid++, depth: this.frames.length - 1 });
          this.push(schema.text(inner, [mark]));
          this.pos = end + ticks.length;
          break;
        }
        case "link_open": {
          if (tok.markup === "autolink") {
            const end = this.src.indexOf(">", this.pos);
            if (this.src[this.pos] !== "<" || end === -1) throw new Mismatch("autolink");
            const src = this.src.slice(this.pos, end + 1);
            this.pos = end + 1;
            // Skip the text and close tokens of the autolink.
            while (t < tokens.length && tokens[t].type !== "link_close") t++;
            this.push(atom("url", { src, url: src.slice(1, -1) }));
            break;
          }
          this.expect("[");
          const f: Frame = { type: "link", mark: null, start: this.pos - 1, nodes: [] };
          this.frames.push(f);
          break;
        }
        case "link_close": {
          const f = this.frames.pop()!;
          if (!f || f.type !== "link") throw new Mismatch("link close");
          if (this.src[this.pos] !== "]") throw new Mismatch("link ]");
          const after = this.pos + 1;
          if (this.src[after] === "(") {
            const end = closeParen(this.src, after);
            if (end === -1) throw new Mismatch("link dest");
            if (f.nodes.length === 0 || this.frames.some((x) => x.mark?.type.name === "link")) {
              this.collapse(f, end, "link");
              break;
            }
            const close = this.src.slice(this.pos, end);
            const dest = /^\]\(\s*(<[^>]*>|[^\s)]*)/.exec(close);
            const href = dest ? dest[1].replace(/^<|>$/g, "") : "";
            const mark = schema.marks.link.create({ open: "[", close, href, gid: this.state.gid++, depth: this.frames.length - 1 });
            for (const n of f.nodes) this.top.nodes.push(n.mark(mark.addToSet(n.marks)));
            this.pos = end;
            this.lineFlag = false;
          } else if (this.src[after] === "[") {
            const end = closeBracket(this.src, after);
            if (end === -1) throw new Mismatch("ref link");
            this.collapse(f, end, "link");
          } else this.collapse(f, after, "link");
          break;
        }
        case "image": {
          if (!this.src.startsWith("![", this.pos)) throw new Mismatch("image");
          const textEnd = closeBracket(this.src, this.pos + 1);
          if (textEnd === -1) throw new Mismatch("image alt");
          let end = textEnd;
          let path = tok.attrGet("src") ?? "";
          if (this.src[textEnd] === "(") {
            end = closeParen(this.src, textEnd);
            if (end === -1) throw new Mismatch("image dest");
            const dest = /^\(\s*(<[^>]*>|[^\s)]*)/.exec(this.src.slice(textEnd, end));
            if (dest) path = dest[1].replace(/^<|>$/g, "");
          } else if (this.src[textEnd] === "[") {
            end = closeBracket(this.src, textEnd);
            if (end === -1) throw new Mismatch("image ref");
          }
          const src = this.src.slice(this.pos, end);
          this.pos = end;
          this.push(atom("image", { src, path, alt: tok.content }));
          break;
        }
        case "html_inline":
          this.expect(tok.content);
          this.push(atom("raw_inline", { src: tok.content, label: "HTML" }));
          break;
        case "math_inline": {
          const src = tok.markup + tok.content + tok.markup;
          this.expect(src);
          this.push(atom("math_inline", { open: tok.markup, body: tok.content, close: tok.markup }));
          break;
        }
        default:
          throw new Mismatch("token " + tok.type);
      }
    }
    if (this.frames.length !== 1) throw new Mismatch("unclosed");
    if (this.pos !== this.src.length) throw new Mismatch("trailing source");
  }
}

/**
 * Parses Markdown inline source into PM nodes. `lineStart` says whether the
 * content begins a line (paragraphs) or follows markup (headings).
 */
export function parseMarkdownInline(src: string, env: MdEnv, state: MdInlineState, lineStart = true): PMNode[] | null {
  if (src === "") return [];
  try {
    const tokens = md.parseInline(src, env)[0]?.children ?? [];
    const a = new Aligner(src, state, lineStart);
    a.run(tokens);
    return a.frames[0].nodes;
  } catch (e) {
    if (e instanceof Mismatch) return null;
    throw e;
  }
}
