// Markdown block splitting and block parsing. markdown-it's level-0 block
// tokens give line spans; text between them must be whitespace, so anything
// else there (such as link reference definitions) becomes a raw block. Each
// block then parses on its own and must serialize back to its source (I4).

import type { Node as PMNode } from "prosemirror-model";
import { register } from "../registry";
import { schema } from "../schema";
import type { DocContext } from "../types";
import { parseMarkdownInline } from "./inline";
import { md, type MdEnv } from "./md";
import { markdownSerialize } from "./serialize";

export type { MdEnv };

export interface MdSpan {
  start: number;
  end: number;
  kind: string;
}

const KINDS: Record<string, string> = {
  heading_open: "heading",
  paragraph_open: "paragraph",
  bullet_list_open: "list",
  ordered_list_open: "list",
  blockquote_open: "quote",
  fence: "fence",
  code_block: "raw",
  hr: "hr",
  math_block: "math",
  table_open: "table",
  html_block: "raw",
};

const isWsChar = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/** Splits text[from, to) into Markdown block spans. */
export function splitMarkdown(text: string, from: number, to: number, env: MdEnv): MdSpan[] {
  const body = text.slice(from, to);
  const lineStarts = [0];
  for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineEnd = (line: number) => (line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : body.length);
  const tokens = md.parse(body, env);
  const raw: MdSpan[] = [];
  for (const tok of tokens) {
    if (tok.level !== 0 || tok.nesting === -1 || !tok.map) continue;
    let s = lineStarts[tok.map[0]] ?? body.length;
    let e = lineEnd(tok.map[1] - 1);
    while (s < e && isWsChar(body.charCodeAt(s))) s++;
    while (e > s && isWsChar(body.charCodeAt(e - 1))) e--;
    if (e > s) raw.push({ start: s, end: e, kind: KINDS[tok.type] ?? "raw" });
  }
  // Non-whitespace between blocks becomes raw blocks of its own.
  const spans: MdSpan[] = [];
  let pos = 0;
  const gap = (a: number, b: number) => {
    let s = a;
    let e = b;
    while (s < e && isWsChar(body.charCodeAt(s))) s++;
    while (e > s && isWsChar(body.charCodeAt(e - 1))) e--;
    if (e > s) spans.push({ start: s, end: e, kind: "raw" });
  };
  for (const sp of raw) {
    if (sp.start < pos) {
      // Overlap should not happen; merge defensively into one raw block.
      const prev = spans.pop();
      spans.push({ start: prev ? prev.start : sp.start, end: Math.max(sp.end, prev ? prev.end : sp.end), kind: "raw" });
      pos = Math.max(pos, sp.end);
      continue;
    }
    gap(pos, sp.start);
    spans.push(sp);
    pos = sp.end;
  }
  gap(pos, body.length);
  return spans.map((s) => ({ start: s.start + from, end: s.end + from, kind: s.kind }));
}

/** End of the front matter block ("---" ... "---" or "..."), or -1. */
function frontMatterEnd(text: string): number {
  if (!/^---[ \t]*\r?\n/.test(text)) return -1;
  const re = /^(---|\.\.\.)[ \t]*$/gm;
  re.lastIndex = text.indexOf("\n") + 1;
  const m = re.exec(text);
  if (!m) return -1;
  let end = m.index + m[0].length;
  if (text[end - 1] === "\r") end--;
  return end;
}

export function splitMarkdownFile(text: string, env: MdEnv) {
  const pre = frontMatterEnd(text);
  const from = pre === -1 ? 0 : pre;
  return {
    pre: pre === -1 ? null : ([0, pre] as [number, number]),
    post: null,
    body: splitMarkdown(text, from, text.length, env),
  };
}

// ---------------------------------------------------------------------------
// Block parsing

function rawBlock(src: string, label: string): PMNode {
  return register(schema.nodes.raw_block.create({ src, label }), src);
}

/** Lines of `s` with their line ends kept separately ("\n", "\r\n" or ""). */
function lines(s: string): { text: string; eol: string }[] {
  const out: { text: string; eol: string }[] = [];
  let i = 0;
  while (i <= s.length) {
    const nl = s.indexOf("\n", i);
    if (nl === -1) {
      out.push({ text: s.slice(i), eol: "" });
      break;
    }
    const cr = nl > i && s[nl - 1] === "\r";
    out.push({ text: s.slice(i, cr ? nl - 1 : nl), eol: cr ? "\r\n" : "\n" });
    i = nl + 1;
  }
  return out;
}

/**
 * Strips `prefix` from every line after the first (or from all lines when
 * `first` is true). An empty line may carry the trimmed prefix instead.
 * Returns null on a line that has neither (a lazy continuation).
 */
function stripPrefix(s: string, prefix: string, first: boolean): string | null {
  const ls = lines(s);
  const short = prefix.trimEnd();
  let out = "";
  for (let i = 0; i < ls.length; i++) {
    const { text, eol } = ls[i];
    if (i === 0 && !first) out += text;
    else if (text.startsWith(prefix) && text.length > prefix.length) out += text.slice(prefix.length);
    else if (text === short) out += "";
    else if (text === prefix && short === prefix) out += "";
    else return null;
    out += eol;
  }
  return out;
}

function parseChildren(src: string, ctx: DocContext, env: MdEnv): { nodes: PMNode[]; gaps: string[] } {
  const spans = splitMarkdown(src, 0, src.length, env);
  const nodes: PMNode[] = [];
  const gaps: string[] = [];
  let pos = 0;
  for (const sp of spans) {
    gaps.push(src.slice(pos, sp.start));
    nodes.push(buildMarkdownBlock(src.slice(sp.start, sp.end), sp.kind, ctx, env));
    pos = sp.end;
  }
  gaps.push(src.slice(pos));
  return { nodes, gaps };
}

function buildHeading(src: string, env: MdEnv): PMNode | null {
  const atx = /^(#{1,6})([ \t]+|$)/.exec(src);
  if (atx && !src.includes("\n")) {
    const open = atx[0];
    let content = src.slice(open.length);
    const closing = /(^|[ \t]+)#+[ \t]*$/.exec(content);
    let close = "";
    if (closing) {
      close = closing[0];
      content = content.slice(0, content.length - close.length);
    }
    const nodes = parseMarkdownInline(content, env, { gid: 1 }, false);
    if (nodes === null) return null;
    return schema.nodes.heading.create({ cmd: "atx", level: atx[1].length, open, close, trail: "" }, nodes);
  }
  const m = /(\r?\n)[ \t]*(=+|-+)[ \t]*$/.exec(src);
  if (!m) return null;
  const content = src.slice(0, m.index);
  const nodes = parseMarkdownInline(content, env, { gid: 1 }, true);
  if (nodes === null) return null;
  const level = m[2][0] === "=" ? 1 : 2;
  return schema.nodes.heading.create({ cmd: "setext", level, open: "", close: m[0], trail: "" }, nodes);
}

const MARKER = /^([-+*]|\d{1,9}[.)])( *)/;

function buildList(src: string, ctx: DocContext, env: MdEnv): PMNode | null {
  const tokens = md.parse(src, env);
  const ordered = tokens[0]?.type === "ordered_list_open";
  const lineStarts = [0];
  for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const starts: number[] = [];
  for (const t of tokens) {
    if (t.type === "list_item_open" && t.level === 1 && t.map) {
      let s = lineStarts[t.map[0]];
      while (src[s] === " ") s++;
      starts.push(s);
    }
  }
  if (starts.length === 0 || starts[0] !== 0) return null;
  const gaps: string[] = [""];
  const items: PMNode[] = [];
  for (let n = 0; n < starts.length; n++) {
    const chunkEnd = n + 1 < starts.length ? starts[n + 1] : src.length;
    const chunk = src.slice(starts[n], chunkEnd);
    const body = chunk.trimEnd();
    const m = MARKER.exec(body);
    if (!m) return null;
    let head = m[0];
    const rest = body.slice(head.length);
    // An empty first line, or more than four spaces: keep only one space in the head.
    if (rest.startsWith("\n") || rest.startsWith("\r\n") || rest === "") head = m[1] + m[2];
    else if (m[2].length > 4) head = m[1] + " ";
    const indent = " ".repeat(head.length);
    const content = stripPrefix(body.slice(head.length), indent, false);
    if (content === null) return null;
    let children: PMNode[];
    let childGaps: string[];
    if (content === "") {
      children = [schema.nodes.paragraph.create()];
      childGaps = [];
    } else {
      const parsed = parseChildren(content, ctx, env);
      if (parsed.gaps[0] !== "" || parsed.gaps[parsed.gaps.length - 1] !== "" || parsed.nodes.length === 0) return null;
      children = parsed.nodes;
      childGaps = parsed.gaps.slice(1, -1);
    }
    items.push(register(schema.nodes.list_item.create({ head, indent, gaps: childGaps }, children), body));
    gaps.push(chunk.slice(body.length));
  }
  gaps[gaps.length - 1] = "";
  return schema.nodes.list.create({ kind: ordered ? "ordered" : "bullet", begin: "", end: "", gaps }, items);
}

function buildQuote(src: string, ctx: DocContext, env: MdEnv): PMNode | null {
  const prefix = src.startsWith("> ") ? "> " : ">";
  const inner = stripPrefix(src, prefix, true);
  if (inner === null) return null;
  const parsed = parseChildren(inner, ctx, env);
  return schema.nodes.container.create(
    { kind: "quote", env: "", label: "Quote", begin: "", end: "", prefix, gaps: parsed.gaps },
    parsed.nodes,
  );
}

function buildFence(src: string): PMNode | null {
  const ls = lines(src);
  if (ls.length < 2) return null;
  const open = /^(`{3,}|~{3,})(.*)$/.exec(ls[0].text);
  const last = ls[ls.length - 1].text;
  const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(last);
  if (!open || !close || close[1][0] !== open[1][0] || close[1].length < open[1].length) return null;
  const lang = open[2].trim().split(/\s+/)[0] ?? "";
  const firstEol = ls[0].text.length + ls[0].eol.length;
  const lastStart = src.length - last.length;
  const lastEol = ls[ls.length - 2].eol;
  let begin: string;
  let body: string;
  let end: string;
  if (ls.length === 2) {
    begin = ls[0].text;
    body = "";
    end = ls[0].eol + last;
  } else {
    begin = src.slice(0, firstEol);
    body = src.slice(firstEol, lastStart - lastEol.length);
    end = lastEol + last;
  }
  return schema.nodes.code_block.create({ begin, end, lang }, body ? schema.text(body) : undefined);
}

function buildMath(src: string): PMNode | null {
  if (!src.startsWith("$$") || !src.endsWith("$$") || src.length < 4) return null;
  const first = /^\$\$[ \t]*\r?\n/.exec(src);
  const last = /\r?\n[ \t]*\$\$$/.exec(src);
  if (first && last && last.index >= first[0].length - 1) {
    const body = src.slice(first[0].length, last.index);
    if (first[0].length > last.index + 1 && body === "") return null;
    return schema.nodes.math_display.create({ open: first[0], body: src.slice(first[0].length, last.index), close: last[0], env: "" });
  }
  return schema.nodes.math_display.create({ open: "$$", body: src.slice(2, -2), close: "$$", env: "" });
}

export function buildMarkdownBlock(src: string, kind: string, ctx: DocContext, env: MdEnv): PMNode {
  let node: PMNode | null = null;
  switch (kind) {
    case "heading":
      node = buildHeading(src, env);
      break;
    case "paragraph": {
      const nodes = parseMarkdownInline(src, env, { gid: 1 }, true);
      if (nodes && nodes.length > 0) node = schema.nodes.paragraph.create(null, nodes);
      break;
    }
    case "list":
      node = buildList(src, ctx, env);
      break;
    case "quote":
      node = buildQuote(src, ctx, env);
      break;
    case "fence":
      node = buildFence(src);
      break;
    case "hr":
      node = schema.nodes.command_block.create({ src, kind: "hr", target: "" });
      break;
    case "math":
      node = buildMath(src);
      break;
    case "table":
      node = schema.nodes.table_block.create({ src, caption: "", label: "" });
      break;
  }
  const label = src.startsWith("<") ? "HTML" : "Markdown";
  if (node === null) return rawBlock(src, label);
  if (markdownSerialize(node, { useSrc: false }) !== src) return rawBlock(src, label);
  return register(node, src);
}

export function parseMarkdownBlocks(src: string, ctx: DocContext, env: MdEnv): { nodes: PMNode[]; gaps: string[] } {
  return parseChildren(src, ctx, env);
}
