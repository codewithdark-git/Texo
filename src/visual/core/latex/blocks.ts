// LaTeX block splitting and block parsing. The splitter cuts a range of text
// into block spans separated by whitespace-only gaps; the parser turns one
// span into a node. A node is structured only when it serializes back to its
// exact source (I4); otherwise it becomes a raw_block holding the source.

import type { Node as PMNode } from "prosemirror-model";
import { register } from "../registry";
import { schema } from "../schema";
import type { DocContext } from "../types";
import { latexSerialize } from "./serialize";
import { matchBrace, matchBracket, parseLatexInline, skipArgs, type InlineState } from "./inline";
import { scan, T, type Token } from "./scanner";

export type BlockKind = "comment" | "env" | "math" | "heading" | "command" | "paragraph" | "raw";

export interface Span {
  start: number;
  end: number;
  kind: BlockKind;
}

const HEADINGS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const COMMANDS: Record<string, string> = {
  maketitle: "maketitle",
  tableofcontents: "toc",
  listoffigures: "lists",
  listoftables: "lists",
  bibliography: "bibliography",
  bibliographystyle: "bibliography",
  printbibliography: "bibliography",
  newpage: "pagebreak",
  clearpage: "pagebreak",
  cleardoublepage: "pagebreak",
  appendix: "appendix",
  frontmatter: "matter",
  mainmatter: "matter",
  backmatter: "matter",
  input: "input",
  include: "include",
  subfile: "include",
};

const isWs = (t: number) => t === T.Space || t === T.Newline || t === T.Parbreak;

/** The split of one text range, as token-level work over a shared token array. */
class Splitter {
  toks: Token[];
  constructor(
    readonly text: string,
    readonly from: number,
    readonly to: number,
  ) {
    this.toks = scan(text, from, to);
  }

  s(k: number) {
    const t = this.toks[k];
    return this.text.slice(t.s, t.e);
  }

  word(k: number): string | null {
    const t = this.toks[k];
    return t && t.t === T.Word ? this.text.slice(t.s + 1, t.e) : null;
  }

  /** True when only spaces separate token k from the start of its line (or the range). */
  atLineStart(k: number): boolean {
    for (let i = this.toks[k].s - 1; i >= this.from; i--) {
      const c = this.text.charCodeAt(i);
      if (c === 10) return true;
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }

  /** The environment name of a \begin or \end at k, or null. */
  envName(k: number): string | null {
    if (k + 1 >= this.toks.length || this.toks[k + 1].t !== T.LBrace) return null;
    const c = matchBrace(this.toks, k + 1);
    if (c === -1) return null;
    const name = this.text.slice(this.toks[k + 1].e, this.toks[c].s);
    return /^[A-Za-z@*]+$/.test(name) ? name : null;
  }

  /** Index of the token ending a line's content: the next Newline/Parbreak or the end. */
  lineEnd(k: number): number {
    let i = k;
    while (i < this.toks.length && this.toks[i].t !== T.Newline && this.toks[i].t !== T.Parbreak) i++;
    return i;
  }

  /** The last non-whitespace token before index k (exclusive), at or after `min`. */
  lastSolid(k: number, min: number): number {
    let i = k - 1;
    while (i > min && isWs(this.toks[i].t)) i--;
    return i;
  }

  /** Raw block from k to the next parbreak at brace depth <= 0, or the end. Returns the end token (exclusive). */
  rawToParbreak(k: number): number {
    let depth = 0;
    let i = k;
    for (; i < this.toks.length; i++) {
      const t = this.toks[i].t;
      if (t === T.Parbreak && depth <= 0 && i > k) break;
      if (t === T.LBrace) depth++;
      else if (t === T.RBrace) depth--;
    }
    return this.lastSolid(i, k) + 1;
  }

  /** After a construct ending at token c (inclusive): end it there, or extend it raw to the line end. */
  restOfLine(c: number): { end: number; raw: boolean } {
    const le = this.lineEnd(c + 1);
    for (let i = c + 1; i < le; i++) {
      if (this.toks[i].t !== T.Space) return { end: this.lastSolid(le, c) + 1, raw: true };
    }
    return { end: c + 1, raw: false };
  }

  tryEnv(k: number): { end: number; kind: BlockKind } | null {
    if (this.word(k) !== "begin") return null;
    const name = this.envName(k);
    if (name === null) return null;
    let depth = 0;
    for (let i = k; i < this.toks.length; i++) {
      const w = this.toks[i].t === T.Word ? this.word(i) : null;
      if (w !== "begin" && w !== "end") continue;
      if (this.envName(i) !== name) continue;
      if (w === "begin") depth++;
      else if (--depth === 0) {
        const c = matchBrace(this.toks, i + 1);
        const r = this.restOfLine(c);
        return { end: r.end, kind: r.raw ? "raw" : "env" };
      }
    }
    return { end: this.rawToParbreak(k), kind: "raw" };
  }

  tryDisplayMath(k: number): { end: number; kind: BlockKind } | null {
    const t = this.toks[k].t;
    if (t !== T.BracketOpen && t !== T.DoubleDollar) return null;
    const close = t === T.BracketOpen ? T.BracketClose : T.DoubleDollar;
    for (let i = k + 1; i < this.toks.length; i++) {
      const u = this.toks[i].t;
      if (u === T.Parbreak) return null;
      if (u === close) {
        const r = this.restOfLine(i);
        return { end: r.end, kind: r.raw ? "raw" : "math" };
      }
    }
    return null;
  }

  tryHeading(k: number): { end: number; kind: BlockKind } | null {
    const w = this.word(k);
    if (w === null || HEADINGS[w.replace(/\*$/, "")] === undefined) return null;
    let i = k + 1;
    if (i < this.toks.length && this.toks[i].t === T.Space) i++;
    if (i < this.toks.length && this.toks[i].t === T.LBracket) {
      const c = matchBracket(this.toks, i);
      if (c === -1) return { end: this.rawToParbreak(k), kind: "raw" };
      i = c + 1;
      if (i < this.toks.length && this.toks[i].t === T.Space) i++;
    }
    if (i >= this.toks.length || this.toks[i].t !== T.LBrace) return null;
    const c = matchBrace(this.toks, i);
    if (c === -1 || this.toks.slice(i, c).some((t) => t.t === T.Parbreak)) return { end: this.rawToParbreak(k), kind: "raw" };
    // trail: the rest of the line, when it is only \label{..} groups and spaces.
    const le = this.lineEnd(c + 1);
    let j = c + 1;
    let lastLabel = -1;
    while (j < le) {
      if (this.toks[j].t === T.Space) j++;
      else if (this.word(j) === "label" && this.toks[j + 1]?.t === T.LBrace) {
        const e = matchBrace(this.toks, j + 1);
        if (e === -1 || e >= le) break;
        lastLabel = e;
        j = e + 1;
      } else break;
    }
    if (j >= le && lastLabel !== -1) return { end: lastLabel + 1, kind: "heading" };
    return { end: c + 1, kind: "heading" };
  }

  tryCommand(k: number): { end: number; kind: BlockKind } | null {
    const w = this.word(k);
    if (w === null || COMMANDS[w] === undefined) return null;
    const e = skipArgs(this.toks, k + 1);
    const le = this.lineEnd(e);
    let last = e - 1;
    for (let i = e; i < le; i++) {
      const t = this.toks[i].t;
      if (t === T.Comment) last = i;
      else if (t !== T.Space) return null;
    }
    return { end: last + 1, kind: "command" };
  }

  /** A block construct (b)-(e) starting at token k at a line start, or null. */
  construct(k: number): { end: number; kind: BlockKind } | null {
    return this.tryEnv(k) ?? this.tryDisplayMath(k) ?? this.tryHeading(k) ?? this.tryCommand(k);
  }

  /** Cheap test used while scanning a paragraph: could a block construct start at k? */
  startsBlock(k: number): boolean {
    const t = this.toks[k];
    if (!t) return false;
    if (t.t === T.BracketOpen || t.t === T.DoubleDollar) return this.tryDisplayMath(k) !== null;
    const w = this.word(k);
    if (w === null) return false;
    if (w === "begin") return this.envName(k) !== null;
    if (HEADINGS[w.replace(/\*$/, "")] !== undefined) return this.tryHeading(k) !== null;
    return this.tryCommand(k) !== null;
  }

  paragraph(k: number): { end: number; kind: BlockKind } {
    const toks = this.toks;
    let depth = 0;
    let math: number | null = null;
    for (let i = k; i < toks.length; i++) {
      const t = toks[i].t;
      if (t === T.Parbreak) {
        if (depth <= 0 && math === null) return { end: this.lastSolid(i, k) + 1, kind: "paragraph" };
        return { end: this.rawToParbreak(k), kind: "raw" };
      }
      if (t === T.Newline && depth <= 0 && math === null) {
        let j = i + 1;
        if (j < toks.length && toks[j].t === T.Space) j++;
        if (this.startsBlock(j)) return { end: this.lastSolid(i, k) + 1, kind: "paragraph" };
      }
      if (t === T.LBrace) depth++;
      else if (t === T.RBrace) depth--;
      else if (t === T.Dollar || t === T.DoubleDollar) math = math === null ? t : math === t ? null : math;
      else if (t === T.ParenOpen && math === null) math = t;
      else if (t === T.ParenClose && math === T.ParenOpen) math = null;
      else if (t === T.BracketOpen && math === null) math = t;
      else if (t === T.BracketClose && math === T.BracketOpen) math = null;
    }
    const end = this.lastSolid(toks.length, k) + 1;
    if (depth > 0 || math !== null) return { end, kind: "raw" };
    return { end, kind: "paragraph" };
  }

  /** A comment run at k: its end, or null when it runs straight into paragraph text. */
  commentRun(k: number): { end: number; kind: BlockKind } | null {
    const toks = this.toks;
    let i = k;
    for (;;) {
      const n = i + 1;
      if (n >= toks.length || toks[n].t === T.Parbreak) return { end: i + 1, kind: "comment" };
      if (toks[n].t !== T.Newline) return null; // impossible: a comment runs to the line end
      let j = n + 1;
      if (j < toks.length && toks[j].t === T.Space) j++;
      if (j >= toks.length) return { end: i + 1, kind: "comment" };
      if (toks[j].t === T.Comment) {
        i = j;
        continue;
      }
      return this.startsBlock(j) ? { end: i + 1, kind: "comment" } : null;
    }
  }

  split(): Span[] {
    const toks = this.toks;
    const spans: Span[] = [];
    let k = 0;
    while (k < toks.length) {
      while (k < toks.length && isWs(toks[k].t)) k++;
      if (k >= toks.length) break;
      const lineStart = this.atLineStart(k);
      let r: { end: number; kind: BlockKind } | null = null;
      if (lineStart && toks[k].t === T.Comment) r = this.commentRun(k);
      if (!r && lineStart) r = this.construct(k);
      if (!r) r = this.paragraph(k);
      const end = Math.max(r.end, k + 1);
      spans.push({ start: toks[k].s, end: toks[end - 1].e, kind: r.kind });
      k = end;
    }
    return spans;
  }
}

/** Splits text[from, to) into block spans. Text between spans is whitespace. */
export function splitLatex(text: string, from = 0, to = text.length): Span[] {
  return new Splitter(text, from, to).split();
}

export interface FileSplit {
  /** End of the preamble atom, or -1 when there is no \begin{document}. */
  preambleEnd: number;
  /** Start of the postamble atom, or -1. */
  postambleStart: number;
  postambleEnd: number;
  body: Span[];
}

/** File-level split: preamble, body blocks, postamble. */
export function splitLatexFile(text: string): FileSplit {
  let preambleEnd = -1;
  const m = /\\begin\s*\{document\}/.exec(text);
  if (m) {
    const nl = text.indexOf("\n", m.index);
    preambleEnd = nl === -1 ? text.length : text[nl - 1] === "\r" ? nl - 1 : nl;
  }
  const bodyStart = preambleEnd === -1 ? 0 : preambleEnd;
  let postambleStart = -1;
  let postambleEnd = -1;
  // The first \end{document} at the start of a line (after spaces) after the preamble.
  let at = preambleEnd === -1 ? -1 : text.indexOf("\\end{document}", bodyStart);
  while (at !== -1) {
    let i = at;
    while (i > bodyStart && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
    if (i > bodyStart && text[i - 1] === "\n") break;
    at = text.indexOf("\\end{document}", at + 1);
  }
  if (at !== -1) {
    postambleStart = at;
    postambleEnd = text.length;
    while (postambleEnd > postambleStart && /\s/.test(text[postambleEnd - 1])) postambleEnd--;
  }
  const bodyEnd = postambleStart === -1 ? text.length : postambleStart;
  return { preambleEnd, postambleStart, postambleEnd, body: splitLatex(text, bodyStart, bodyEnd) };
}

// ---------------------------------------------------------------------------
// Block parsing

const LIST_KINDS: Record<string, string> = { itemize: "bullet", enumerate: "ordered", description: "description" };
const MATH_ENVS = /^(equation|align|gather|multline|flalign|alignat)\*?$|^(displaymath|math)$/;
const CODE_ENVS = new Set(["verbatim", "Verbatim", "lstlisting", "minted"]);
const CONTAINERS: Record<string, string> = {
  quote: "quote",
  quotation: "quote",
  verse: "quote",
  center: "center",
  flushleft: "flush",
  flushright: "flush",
  abstract: "abstract",
  proof: "proof",
};

function rawBlock(src: string, label: string): PMNode {
  return register(schema.nodes.raw_block.create({ src, label }), src);
}

/** Splits `src` with the latex splitter and parses each span; returns children and the gaps between. */
function parseChildren(src: string, ctx: DocContext, state: InlineState): { nodes: PMNode[]; gaps: string[] } | null {
  const spans = splitLatex(src);
  const nodes: PMNode[] = [];
  const gaps: string[] = [];
  let pos = 0;
  for (const sp of spans) {
    gaps.push(src.slice(pos, sp.start));
    nodes.push(buildBlock(src.slice(sp.start, sp.end), sp.kind, ctx, state));
    pos = sp.end;
  }
  gaps.push(src.slice(pos));
  return { nodes, gaps };
}

/** Leading [..] optional argument length at `at`, if any. */
function optArgLen(src: string, at: number): number {
  if (src[at] !== "[") return 0;
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "]" && depth === 0) return i + 1 - at;
    else if (c === "\n") return 0;
  }
  return 0;
}

/** Balanced {..} length at `at`, if any. */
function bracedLen(src: string, at: number): number {
  if (src[at] !== "{") return 0;
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1 - at;
  }
  return 0;
}

interface EnvParts {
  name: string;
  /** "\begin{name}" plus any directly following [..] / {..} arguments. */
  begin: string;
  inner: string;
  end: string;
}

function envParts(src: string): EnvParts | null {
  const m = /^\\begin\{([A-Za-z@*]+)\}/.exec(src);
  if (!m) return null;
  const name = m[1];
  const endStr = `\\end{${name}}`;
  if (!src.endsWith(endStr)) return null;
  let b = m[0].length;
  for (;;) {
    const n = optArgLen(src, b) || bracedLen(src, b);
    if (!n) break;
    b += n;
  }
  const e = src.length - endStr.length;
  if (b > e) return null;
  return { name, begin: src.slice(0, b), inner: src.slice(b, e), end: endStr };
}

function leadingWs(s: string): number {
  return s.length - s.trimStart().length;
}

function trailingWs(s: string): number {
  return s.length - s.trimEnd().length;
}

function buildList(p: EnvParts, kind: string, ctx: DocContext, state: InlineState): PMNode | null {
  // Find \item at depth 0 (braces and environments) in the list's own content.
  const toks = scan(p.inner);
  const items: number[] = [];
  let depth = 0;
  let envDepth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === T.LBrace) depth++;
    else if (t.t === T.RBrace) depth--;
    else if (t.t === T.Word) {
      const w = p.inner.slice(t.s + 1, t.e);
      if (w === "begin") envDepth++;
      else if (w === "end") envDepth--;
      else if (w === "item" && depth === 0 && envDepth === 0) items.push(i);
    }
  }
  if (items.length === 0) return null;
  const first = toks[items[0]].s;
  if (p.inner.slice(0, first).trim() !== "") return null;
  const gaps: string[] = [p.inner.slice(0, first)];
  const itemNodes: PMNode[] = [];
  for (let n = 0; n < items.length; n++) {
    const k = items[n];
    const s = toks[k].s;
    const e = n + 1 < items.length ? toks[items[n + 1]].s : p.inner.length;
    const chunk = p.inner.slice(s, e);
    const tail = trailingWs(chunk);
    const body = chunk.slice(0, chunk.length - tail);
    let h = "\\item".length + optArgLen(body, "\\item".length);
    h += leadingWs(body.slice(h));
    const head = body.slice(0, h);
    const content = body.slice(h);
    let children: PMNode[];
    let childGaps: string[];
    if (content === "") {
      children = [schema.nodes.paragraph.create()];
      childGaps = [];
    } else {
      const parsed = parseChildren(content, ctx, state);
      if (!parsed || parsed.gaps[0] !== "" || parsed.gaps[parsed.gaps.length - 1] !== "") return null;
      children = parsed.nodes;
      childGaps = parsed.gaps.slice(1, -1);
    }
    const item = schema.nodes.list_item.create({ head, indent: "", gaps: childGaps }, children);
    itemNodes.push(register(item, body));
    gaps.push(chunk.slice(chunk.length - tail));
  }
  return schema.nodes.list.create({ kind, begin: p.begin, end: p.end, gaps }, itemNodes);
}

function buildContainer(p: EnvParts, kind: string, label: string, ctx: DocContext, state: InlineState): PMNode | null {
  const parsed = parseChildren(p.inner, ctx, state);
  if (!parsed) return null;
  return schema.nodes.container.create(
    { kind, env: p.name, label, begin: p.begin, end: p.end, prefix: "", gaps: parsed.gaps },
    parsed.nodes,
  );
}

function buildMathEnv(p: EnvParts): PMNode {
  let open = p.begin;
  let inner = p.inner;
  const nl = /^[ \t]*\r?\n/.exec(inner);
  if (nl) {
    open += nl[0];
    inner = inner.slice(nl[0].length);
  }
  let close = p.end;
  const tl = /\r?\n[ \t]*$/.exec(inner);
  if (tl) {
    close = tl[0] + close;
    inner = inner.slice(0, inner.length - tl[0].length);
  }
  return schema.nodes.math_display.create({ open, body: inner, close, env: p.name });
}

function buildCode(p: EnvParts): PMNode {
  let begin = p.begin;
  let inner = p.inner;
  let lang = "";
  if (p.name === "minted") {
    const m = /\{([^}]*)\}\s*$/.exec(p.begin);
    if (m) lang = m[1];
  } else if (p.name === "lstlisting") {
    const m = /language\s*=\s*([^,\]\s]+)/.exec(p.begin);
    if (m) lang = m[1];
  }
  const nl = /^[ \t]*\r?\n/.exec(inner);
  if (nl) {
    begin += nl[0];
    inner = inner.slice(nl[0].length);
  }
  let end = p.end;
  const tl = /\r?\n$/.exec(inner);
  if (tl) {
    end = tl[0] + end;
    inner = inner.slice(0, inner.length - tl[0].length);
  }
  return schema.nodes.code_block.create({ begin, end, lang }, inner ? schema.text(inner) : undefined);
}

/** Tokens allowed in a figure or table float besides its one graphic or tabular. */
const FLOAT_WORDS = new Set(["centering", "small", "footnotesize", "label", "caption"]);

function buildFigure(src: string, p: EnvParts, state: InlineState): PMNode | null {
  const toks = scan(p.inner);
  let graphics = 0;
  let path = "";
  let label = "";
  let cap: { s: number; open: string; inner: string; e: number } | null = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === T.Space || t.t === T.Newline || t.t === T.Parbreak || t.t === T.Comment) continue;
    if (t.t !== T.Word) return null;
    const w = p.inner.slice(t.s + 1, t.e);
    const e = skipArgs(toks, i + 1);
    const lastArg = e - 1 > i ? toks[matchOpen(toks, e - 1)] : null;
    const arg = lastArg && toks[e - 1].t === T.RBrace ? p.inner.slice(lastArg.e, toks[e - 1].s) : "";
    if (w === "includegraphics") {
      if (++graphics > 1 || toks[e - 1].t !== T.RBrace) return null;
      path = arg;
    } else if (w === "caption") {
      if (cap || toks[e - 1].t !== T.RBrace) return null;
      const openEnd = lastArg!.e;
      cap = { s: t.s, open: p.inner.slice(t.s, openEnd), inner: arg, e: toks[e - 1].s };
    } else if (!FLOAT_WORDS.has(w)) return null;
    else if (w === "label") label = arg;
    i = e - 1;
  }
  if (graphics !== 1) return null;
  const off = p.begin.length;
  if (!cap) return schema.nodes.figure.create({ head: src, tail: "", path, label });
  const nodes = parseLatexInline(cap.inner, state);
  if (nodes === null) return null;
  const capNode = register(schema.nodes.figure_caption.create({ open: cap.open, close: "}" }, nodes), cap.open + cap.inner + "}");
  return schema.nodes.figure.create(
    { head: src.slice(0, off + cap.s), tail: src.slice(off + cap.e + 1), path, label },
    capNode,
  );
}

/** For a closing brace at c, the index of its opening brace. */
function matchOpen(toks: Token[], c: number): number {
  let depth = 0;
  for (let i = c; i >= 0; i--) {
    if (toks[i].t === T.RBrace) depth++;
    else if (toks[i].t === T.LBrace && --depth === 0) return i;
  }
  return c;
}

function buildTable(src: string, p: EnvParts): PMNode | null {
  const toks = scan(p.inner);
  let tabulars = 0;
  let caption = "";
  let label = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === T.Space || t.t === T.Newline || t.t === T.Parbreak || t.t === T.Comment) continue;
    if (t.t !== T.Word) return null;
    const w = p.inner.slice(t.s + 1, t.e);
    if (w === "begin") {
      const m = /^\\begin\{(tabular\*?|tabularx)\}/.exec(p.inner.slice(t.s));
      if (!m) return null;
      const endStr = `\\end{${m[1]}}`;
      const close = p.inner.indexOf(endStr, t.s);
      if (close === -1 || ++tabulars > 1) return null;
      const stop = close + endStr.length;
      while (i < toks.length && toks[i].s < stop) i++;
      i--;
      continue;
    }
    if (w !== "centering" && w !== "small" && w !== "caption" && w !== "label" && w !== "footnotesize") return null;
    const e = skipArgs(toks, i + 1);
    if (toks[e - 1]?.t === T.RBrace && e - 1 > i) {
      const arg = p.inner.slice(toks[matchOpen(toks, e - 1)].e, toks[e - 1].s);
      if (w === "caption") caption = arg;
      if (w === "label") label = arg;
    }
    i = e - 1;
  }
  if (tabulars !== 1) return null;
  return schema.nodes.table_block.create({ src, caption, label });
}

function buildEnv(src: string, ctx: DocContext, state: InlineState): PMNode {
  const p = envParts(src);
  if (!p) return rawBlock(src, "\\begin");
  const name = p.name;
  const label = `\\begin{${name}}`;
  let node: PMNode | null = null;
  if (LIST_KINDS[name]) node = buildList(p, LIST_KINDS[name], ctx, state);
  else if (MATH_ENVS.test(name)) node = buildMathEnv(p);
  else if (name === "figure" || name === "figure*") {
    node = buildFigure(src, p, state);
    if (!node) return rawBlock(src, "Figure");
  } else if (name === "table" || name === "table*") node = buildTable(src, p);
  else if (/^(tabular\*?|tabularx)$/.test(name)) node = schema.nodes.table_block.create({ src, caption: "", label: "" });
  else if (CODE_ENVS.has(name)) node = buildCode(p);
  else if (CONTAINERS[name]) node = buildContainer(p, CONTAINERS[name], name, ctx, state);
  else if (ctx.theorems[name] !== undefined) node = buildContainer(p, "theorem", ctx.theorems[name], ctx, state);
  return node ?? rawBlock(src, label);
}

function buildHeading(src: string, ctx: DocContext, state: InlineState): PMNode | null {
  const m = /^\\([a-z]+)(\*?)(\s*)/.exec(src);
  if (!m || HEADINGS[m[1]] === undefined) return null;
  let i = m[0].length;
  const opt = optArgLen(src, i);
  if (opt) {
    i += opt;
    i += /^\s*/.exec(src.slice(i))![0].length;
  }
  const len = bracedLen(src, i);
  if (!len) return null;
  const open = src.slice(0, i + 1);
  const title = src.slice(i + 1, i + len - 1);
  const trail = src.slice(i + len);
  const nodes = parseLatexInline(title, state);
  if (nodes === null) return null;
  const abs = HEADINGS[m[1]];
  const level = abs === 0 ? 0 : ctx.hasChapters ? abs : Math.max(1, abs - 1);
  return schema.nodes.heading.create({ cmd: m[1], level, open, close: "}", trail }, nodes);
}

function buildCommand(src: string): PMNode {
  const m = /^\\([A-Za-z]+)/.exec(src)!;
  const kind = COMMANDS[m[1]] ?? "raw";
  let target = "";
  if (kind === "input" || kind === "include") {
    const a = /^\\[A-Za-z]+\s*\{([^}]*)\}/.exec(src);
    if (a) target = a[1].trim();
  }
  return schema.nodes.command_block.create({ src, kind, target });
}

function buildMathDelims(src: string): PMNode {
  const d = src.startsWith("$$") ? "$$" : "\\[";
  const c = d === "$$" ? "$$" : "\\]";
  return schema.nodes.math_display.create({ open: d, body: src.slice(2, src.length - 2), close: c, env: "" });
}

function rawLabel(src: string): string {
  const m = /^\\begin\{([^}]*)\}/.exec(src);
  if (m) return `\\begin{${m[1]}}`;
  const w = /^\\[A-Za-z@]+/.exec(src);
  return w ? w[0] : "LaTeX";
}

/**
 * Builds one block from its source and the kind the splitter gave it, then
 * checks I4: the node must serialize back to `src`, or it becomes raw.
 */
export function buildBlock(src: string, kind: BlockKind, ctx: DocContext, state: InlineState = { gid: 1 }): PMNode {
  let node: PMNode | null = null;
  switch (kind) {
    case "comment":
      node = schema.nodes.comment_block.create({ src });
      break;
    case "env":
      node = buildEnv(src, ctx, state);
      break;
    case "math":
      node = buildMathDelims(src);
      break;
    case "heading":
      node = buildHeading(src, ctx, state);
      break;
    case "command":
      node = buildCommand(src);
      break;
    case "paragraph": {
      const info = { exact: false };
      const nodes = parseLatexInline(src, state, info);
      if (nodes !== null && nodes.length > 0) node = schema.nodes.paragraph.create(null, nodes);
      // A paragraph is its inline content, which was just checked against src.
      if (node && info.exact) return register(node, src);
      break;
    }
  }
  if (node === null || node.type.name === "raw_block") return node ?? rawBlock(src, rawLabel(src));
  if (latexSerialize(node, { useSrc: false }) !== src) {
    return rawBlock(src, node.type.name === "figure" ? "Figure" : rawLabel(src));
  }
  return register(node, src);
}

/** Parses a block-level snippet into nodes (for paste and inserts). Never throws. */
export function parseLatexBlocks(src: string, ctx: DocContext): { nodes: PMNode[]; gaps: string[] } {
  return parseChildren(src, ctx, { gid: 1 })!;
}
