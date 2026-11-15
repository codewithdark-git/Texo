// Markdown serialization: the shared engine with the Markdown codec. Text
// escapes \ * _ ` [ ] < $ everywhere, and at the start of a line also the
// characters that would begin block syntax (# > + - and "1." / "1)").
// Code text is never escaped.

import type { Node as PMNode } from "prosemirror-model";
import { serializeWith, serializeWithMapWith, type Codec, type Piece, type SerializeOptions, type SourceMap } from "../serialize";

const ALWAYS = new Set(["\\", "*", "_", "`", "[", "]", "<", "$"]);
const LINE_START = new Set(["#", ">", "+", "-"]);

/**
 * Indices in `text` whose character the escaper prefixes with a backslash.
 * The parser uses the same function to keep such characters as glyphs, so
 * parsed text always round-trips.
 */
export function escapeIndices(text: string, lineStart: boolean): number[] {
  const out: number[] = [];
  let i = 0;
  if (lineStart) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (i < text.length) {
      if (LINE_START.has(text[i])) {
        out.push(i);
        i++;
      } else if (/[0-9]/.test(text[i])) {
        let j = i;
        while (j < text.length && /[0-9]/.test(text[j])) j++;
        if (text[j] === "." || text[j] === ")") {
          for (let k = i; k < j; k++) if (ALWAYS.has(text[k])) out.push(k);
          out.push(j);
          i = j + 1;
        }
      }
    }
  }
  for (; i < text.length; i++) if (ALWAYS.has(text[i])) out.push(i);
  return out;
}

function escapePieces(text: string, lineStart: boolean, inCode: boolean): Piece[] {
  if (inCode) return text ? [{ s: text, n: text.length }] : [];
  const pieces: Piece[] = [];
  let last = 0;
  for (const i of escapeIndices(text, lineStart)) {
    if (i > last) pieces.push({ s: text.slice(last, i), n: i - last });
    pieces.push({ s: "\\" + text[i], n: 1 });
    last = i + 1;
  }
  if (last < text.length) pieces.push({ s: text.slice(last), n: text.length - last });
  return pieces;
}

/** Escapes plain text for Markdown (not at a line start). */
export function escapeMarkdown(text: string, lineStart = false): string {
  return escapePieces(text, lineStart, false)
    .map((p) => p.s)
    .join("");
}

export const markdownCodec: Codec = { escapePieces, guard: () => "", escapeInCode: false };

export function markdownSerialize(node: PMNode, opts?: SerializeOptions): string {
  return serializeWith(markdownCodec, node, opts);
}

export function markdownSerializeWithMap(node: PMNode, eol: string): SourceMap {
  return serializeWithMapWith(markdownCodec, node, eol);
}
