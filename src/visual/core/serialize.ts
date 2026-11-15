// The serializer engine both dialects share. A node that is still in the SRC
// registry is written from its original bytes; anything else is rebuilt from
// the spelling recorded in its attrs. A dialect only supplies a Codec (text
// escaping and adjacency guards). The engine can also record a position map,
// [pmOffset, srcOffset] pairs, which the session uses to move the cursor
// between the two views.

import type { Mark, Node as PMNode } from "prosemirror-model";
import { SRC } from "./registry";

/** One piece of escaped text: `s` is what is written, `n` the PM characters it covers. */
export interface Piece {
  s: string;
  n: number;
}

export interface Codec {
  /** Splits text into pieces. Unescaped runs have s.length === n. */
  escapePieces(text: string, lineStart: boolean, inCode: boolean): Piece[];
  /** What to insert between `tail` (output so far) and `next`, usually "". */
  guard(tail: string, next: string): string;
  /** Whether code-mark text is escaped like normal text (LaTeX \texttt). */
  escapeInCode: boolean;
}

export interface SerializeOptions {
  /** Use the SRC registry for nodes found there (the default). */
  useSrc?: boolean;
  eol?: string;
}

/** The output buffer, plus the optional position map and line-prefix state. */
class Out {
  s = "";
  /** The last few characters of `s`. Reading the end of a long concatenated
   * string flattens it, so guards and line-start checks look here instead. */
  tail = "";
  pm = 0;
  map: number[] | null;
  /** Markdown continuation prefixes (list indents, "> "), outermost first. */
  prefixes: string[] = [];
  /** True when the next non-empty line must get the prefixes. */
  pending = false;
  constructor(
    readonly codec: Codec,
    readonly useSrc: boolean,
    readonly eol: string,
    withMap: boolean,
  ) {
    this.map = withMap ? [] : null;
  }

  mark() {
    if (this.map) this.map.push(this.pm, this.s.length);
  }

  add(str: string) {
    this.s += str;
    this.tail = str.length >= 48 ? str.slice(-48) : (this.tail + str).slice(-48);
  }

  /** Appends raw source, inserting line prefixes after each newline. */
  write(str: string) {
    if (str === "") return;
    if (this.prefixes.length === 0) {
      this.add(str);
      return;
    }
    let i = 0;
    while (i < str.length) {
      if (this.pending) {
        const empty = str[i] === "\n" || (str[i] === "\r" && str[i + 1] === "\n");
        const prefix = this.prefixes.join("");
        this.add(empty ? prefix.trimEnd() : prefix);
        this.pending = false;
      }
      const nl = str.indexOf("\n", i);
      if (nl === -1) {
        this.add(str.slice(i));
        return;
      }
      this.add(str.slice(i, nl + 1));
      this.pending = true;
      i = nl + 1;
    }
  }

  /** Appends with the dialect's adjacency guard. */
  append(str: string) {
    if (str === "") return;
    const g = this.codec.guard(this.tail, str);
    if (g) this.write(g);
    this.write(str);
  }
}

/** True when the output is at the start of a (prefixed) line. */
function atLineStart(out: Out): boolean {
  if (out.pending || out.s === "") return true;
  const t = out.tail.length < out.s.length && /^[ \t]*$/.test(out.tail) ? out.s : out.tail;
  for (let i = t.length - 1; i >= 0; i--) {
    const c = t[i];
    if (c === "\n") return true;
    if (c !== " " && c !== "\t") return false;
  }
  return true;
}

function attrStr(node: PMNode, name: string): string {
  const v = node.attrs[name];
  return typeof v === "string" ? v : "";
}

function gapsOf(node: PMNode): string[] {
  const g = node.attrs.gaps;
  return Array.isArray(g) ? (g as string[]) : [];
}

/** The most common interior gap of a list, used for new items. */
function commonGap(gaps: string[], eol: string): string {
  const counts = new Map<string, number>();
  for (let i = 1; i < gaps.length - 1; i++) counts.set(gaps[i], (counts.get(gaps[i]) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [g, c] of counts) {
    if (c > bestCount) {
      best = g;
      bestCount = c;
    }
  }
  if (best !== null) return best;
  const first = gaps[0] ?? "";
  const indent = /[ \t]*$/.exec(first)?.[0] ?? "";
  return eol + indent;
}

/**
 * The gap before child i (0..n), where gap n is the one after the last child.
 * The first and last gaps always come from the hint's ends, so adding a child
 * never moves the gap before an \end line.
 */
function gapAt(gaps: string[], i: number, n: number, interior: () => string, edge: string): string {
  if (i === 0) return gaps.length > 0 ? gaps[0] : edge;
  if (i === n) return gaps.length > 1 ? gaps[gaps.length - 1] : edge;
  return i < gaps.length - 1 ? gaps[i] : interior();
}

function emitBlock(node: PMNode, out: Out) {
  const start = out.pm;
  out.mark();
  const src = out.useSrc ? SRC.get(node) : undefined;
  if (src !== undefined && out.map === null) {
    out.write(src);
    out.pm = start + node.nodeSize;
    return;
  }
  const t = node.type.name;
  const eol = out.eol;
  switch (t) {
    case "paragraph":
      out.pm = start + 1;
      emitInline(node, out, true);
      break;
    case "heading":
      out.append(attrStr(node, "open"));
      out.pm = start + 1;
      out.mark();
      emitInline(node, out, false);
      out.append(attrStr(node, "close"));
      out.write(attrStr(node, "trail"));
      break;
    case "list": {
      const gaps = gapsOf(node);
      const n = node.childCount;
      const edgeBegin = attrStr(node, "begin") === "" ? "" : eol;
      out.write(attrStr(node, "begin"));
      out.pm = start + 1;
      node.forEach((item, _o, i) => {
        out.write(gapAt(gaps, i, n, () => commonGap(gaps, eol), edgeBegin));
        emitBlock(item, out);
      });
      out.write(gapAt(gaps, n, n, () => commonGap(gaps, eol), attrStr(node, "end") === "" ? "" : eol));
      out.write(attrStr(node, "end"));
      break;
    }
    case "list_item": {
      const gaps = gapsOf(node);
      out.write(attrStr(node, "head"));
      const indent = attrStr(node, "indent");
      if (indent) out.prefixes.push(indent);
      out.pm = start + 1;
      node.forEach((child, _o, i) => {
        if (i > 0) out.write(i - 1 < gaps.length ? gaps[i - 1] : eol);
        emitBlock(child, out);
      });
      if (indent) {
        out.prefixes.pop();
        out.pending = false;
      }
      break;
    }
    case "container": {
      const gaps = gapsOf(node);
      const n = node.childCount;
      const prefix = attrStr(node, "prefix");
      const begin = attrStr(node, "begin");
      out.write(begin);
      if (prefix) {
        out.prefixes.push(prefix);
        out.pending = true;
      }
      out.pm = start + 1;
      const edge = begin === "" ? "" : eol;
      node.forEach((child, _o, i) => {
        out.write(gapAt(gaps, i, n, () => eol, edge));
        emitBlock(child, out);
      });
      if (n === 0) out.write(gaps[0] ?? "");
      else out.write(gapAt(gaps, n, n, () => eol, attrStr(node, "end") === "" ? "" : eol));
      if (prefix) {
        out.prefixes.pop();
        out.pending = false;
      }
      out.write(attrStr(node, "end"));
      break;
    }
    case "math_display":
      out.write(attrStr(node, "open") + attrStr(node, "body") + attrStr(node, "close"));
      break;
    case "code_block":
      out.write(attrStr(node, "begin"));
      out.pm = start + 1;
      out.mark();
      out.write(node.textContent);
      out.pm = start + 1 + node.content.size;
      out.mark();
      out.write(attrStr(node, "end"));
      break;
    case "figure":
      out.write(attrStr(node, "head"));
      out.pm = start + 1;
      node.forEach((cap) => emitBlock(cap, out));
      out.write(attrStr(node, "tail"));
      break;
    case "figure_caption":
      out.append(attrStr(node, "open"));
      out.pm = start + 1;
      out.mark();
      emitInline(node, out, false);
      out.append(attrStr(node, "close"));
      break;
    default:
      out.write(attrStr(node, "src"));
  }
  out.pm = start + node.nodeSize;
  out.mark();
}

function hasMark(marks: readonly Mark[], m: Mark): boolean {
  for (const x of marks) if (x.eq(m)) return true;
  return false;
}

/** The serialized form of an inline atom. */
function inlineAtomSrc(node: PMNode, useSrc: boolean): string {
  const src = useSrc ? SRC.get(node) : undefined;
  if (src !== undefined) return src;
  if (node.type.name === "math_inline") return attrStr(node, "open") + attrStr(node, "body") + attrStr(node, "close");
  return attrStr(node, "src");
}

/**
 * Inline content with mark groups. A stack of open groups (keyed by mark
 * identity, which includes gid) is closed down to the longest prefix the next
 * node still has; new groups open longest-extent first, then by depth. An
 * outer group that ends while an inner continues closes and reopens the inner.
 */
function emitInline(parent: PMNode | readonly PMNode[], out: Out, paragraphStart: boolean) {
  let kids: readonly PMNode[];
  if (Array.isArray(parent)) kids = parent;
  else {
    const list: PMNode[] = [];
    (parent as PMNode).forEach((c) => list.push(c));
    kids = list;
  }
  const active: Mark[] = [];
  let lineStart = paragraphStart;
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i];
    const marks = node.marks;
    let keep = 0;
    while (keep < active.length && hasMark(marks, active[keep])) keep++;
    for (let k = active.length - 1; k >= keep; k--) out.append(active[k].attrs.close as string);
    active.length = keep;
    const toOpen = marks.filter((m) => !hasMark(active, m));
    if (toOpen.length > 0) {
      const extent = (m: Mark) => {
        let j = i;
        while (j < kids.length && hasMark(kids[j].marks, m)) j++;
        return j - i;
      };
      const ext = new Map(toOpen.map((m) => [m, extent(m)]));
      toOpen.sort((a, b) => ext.get(b)! - ext.get(a)! || (a.attrs.depth as number) - (b.attrs.depth as number));
      for (const m of toOpen) {
        out.append(m.attrs.open as string);
        active.push(m);
      }
    }
    if (node.isText) {
      const inCode = marks.some((m) => m.type.name === "code") && !out.codec.escapeInCode;
      const ls = lineStart && atLineStart(out);
      const pieces = out.codec.escapePieces(node.text!, ls, inCode);
      for (const p of pieces) {
        out.mark();
        out.append(p.s);
        out.pm += p.n;
      }
      out.mark();
    } else {
      out.mark();
      out.append(inlineAtomSrc(node, out.useSrc));
      out.pm += node.nodeSize;
      out.mark();
    }
    lineStart = node.type.name === "softbreak";
  }
  for (let k = active.length - 1; k >= 0; k--) out.append(active[k].attrs.close as string);
}

/** Serializes one node (block or inline). */
export function serializeWith(codec: Codec, node: PMNode, opts: SerializeOptions = {}): string {
  const out = new Out(codec, opts.useSrc !== false, opts.eol ?? "\n", false);
  if (node.isInline) {
    if (node.isText) {
      for (const p of codec.escapePieces(node.text!, false, false)) out.append(p.s);
    } else out.append(inlineAtomSrc(node, out.useSrc));
    return out.s;
  }
  emitBlock(node, out);
  return out.s;
}

/** Serializes a node's inline content only (for headings, captions, snippets). */
/** Serializes inline content: a parent's children, or a plain array of inline nodes. */
export function serializeInlineWith(codec: Codec, parent: PMNode | readonly PMNode[], opts: SerializeOptions = {}, lineStart = true): string {
  const out = new Out(codec, opts.useSrc !== false, opts.eol ?? "\n", false);
  emitInline(parent, out, lineStart);
  return out.s;
}

export interface SourceMap {
  text: string;
  /** Flat [pmOffset, srcOffset] pairs, both non-decreasing. */
  pairs: number[];
}

/** Structural serialization of a block with its position map (offsets relative to the node start). */
export function serializeWithMapWith(codec: Codec, node: PMNode, eol: string): SourceMap {
  const out = new Out(codec, false, eol, true);
  emitBlock(node, out);
  return { text: out.s, pairs: out.map! };
}

/** Maps a PM offset to a source offset with a SourceMap. */
export function mapPmToSrc(map: SourceMap, pm: number): number {
  const p = map.pairs;
  let lo = 0;
  let hi = p.length / 2 - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p[mid * 2] <= pm) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Prefer the last pair at exactly this PM offset (after any mark opens).
  const pm0 = p[best * 2];
  const s0 = p[best * 2 + 1];
  if (pm0 === pm) return s0;
  const next = best + 1 < p.length / 2 ? best + 1 : -1;
  if (next !== -1 && p[next * 2] - pm0 === p[next * 2 + 1] - s0) return s0 + (pm - pm0);
  return s0;
}

/** Maps a source offset to the nearest PM offset at or before it. */
export function mapSrcToPm(map: SourceMap, src: number): number {
  const p = map.pairs;
  let lo = 0;
  let hi = p.length / 2 - 1;
  let last = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p[mid * 2 + 1] <= src) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const pm0 = p[last * 2];
  const s0 = p[last * 2 + 1];
  const next = last + 1 < p.length / 2 ? last + 1 : -1;
  if (src > s0 && next !== -1 && p[next * 2] - pm0 === p[next * 2 + 1] - s0) return pm0 + (src - s0);
  // Several pairs at the same source offset: take the first (the earliest PM spot).
  let first = last;
  while (first > 0 && p[(first - 1) * 2 + 1] === s0) first--;
  return p[first * 2];
}
