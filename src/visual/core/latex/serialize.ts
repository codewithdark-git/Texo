// LaTeX serialization: the shared engine with the LaTeX codec.

import type { Node as PMNode } from "prosemirror-model";
import { serializeInlineWith, serializeWith, serializeWithMapWith, type SerializeOptions, type SourceMap } from "../serialize";
import { latexCodec } from "./escape";

export function latexSerialize(node: PMNode, opts?: SerializeOptions): string {
  return serializeWith(latexCodec, node, opts);
}

export function latexSerializeInline(parent: PMNode, opts?: SerializeOptions): string {
  return serializeInlineWith(latexCodec, parent, opts, false);
}

export function latexSerializeWithMap(node: PMNode, eol: string): SourceMap {
  return serializeWithMapWith(latexCodec, node, eol);
}
