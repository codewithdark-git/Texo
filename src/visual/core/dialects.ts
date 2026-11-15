// The per-dialect codec the session works through: how a file splits into
// preamble, body blocks and postamble, how one block parses, and how nodes
// serialize. Both dialects implement the same shape.

import type { Node as PMNode } from "prosemirror-model";
import type { SerializeOptions, SourceMap } from "./serialize";
import type { Dialect, DocContext } from "./types";
import { buildBlock, splitLatex, splitLatexFile, parseLatexBlocks, type BlockKind } from "./latex/blocks";
import { parseLatexInline } from "./latex/inline";
import { latexSerialize, latexSerializeWithMap } from "./latex/serialize";
import { buildMarkdownBlock, splitMarkdown, splitMarkdownFile, parseMarkdownBlocks, type MdEnv } from "./markdown/split";
import { parseMarkdownInline } from "./markdown/inline";
import { markdownSerialize, markdownSerializeWithMap } from "./markdown/serialize";

export interface BlockSpan {
  start: number;
  end: number;
  kind: string;
}

export interface FileLayout {
  /** [start, end) of the preamble atom, or null. */
  pre: [number, number] | null;
  post: [number, number] | null;
  body: BlockSpan[];
}

export interface DialectCodec {
  splitFile(text: string, env: MdEnv): FileLayout;
  /** Splits text[from, to) as body blocks. */
  splitRange(text: string, from: number, to: number, env: MdEnv): BlockSpan[];
  build(src: string, kind: string, ctx: DocContext, env: MdEnv): PMNode;
  serialize(node: PMNode, opts?: SerializeOptions): string;
  serializeWithMap(node: PMNode, eol: string): SourceMap;
  parseInline(src: string, env: MdEnv): PMNode[] | null;
  parseBlocks(src: string, ctx: DocContext, env: MdEnv): { nodes: PMNode[]; gaps: string[] };
}

const latex: DialectCodec = {
  splitFile(text) {
    const f = splitLatexFile(text);
    return {
      pre: f.preambleEnd === -1 ? null : [0, f.preambleEnd],
      post: f.postambleStart === -1 ? null : [f.postambleStart, f.postambleEnd],
      body: f.body,
    };
  },
  splitRange: (text, from, to) => splitLatex(text, from, to),
  build: (src, kind, ctx) => buildBlock(src, kind as BlockKind, ctx),
  serialize: latexSerialize,
  serializeWithMap: latexSerializeWithMap,
  parseInline: (src) => parseLatexInline(src, { gid: 1 }),
  parseBlocks: (src, ctx) => parseLatexBlocks(src, ctx),
};

const markdown: DialectCodec = {
  splitFile: splitMarkdownFile,
  splitRange: splitMarkdown,
  build: buildMarkdownBlock,
  serialize: markdownSerialize,
  serializeWithMap: markdownSerializeWithMap,
  parseInline: (src, env) => parseMarkdownInline(src, env, { gid: 1 }),
  parseBlocks: parseMarkdownBlocks,
};

export function codecFor(dialect: Dialect): DialectCodec {
  return dialect === "latex" ? latex : markdown;
}
