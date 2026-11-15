// The source registry: every node the parser creates is remembered here with
// its exact original bytes, so an untouched node always serializes to them.
// It is keyed by node identity, which ProseMirror keeps for unchanged nodes.

import type { Node as PMNode } from "prosemirror-model";

export const SRC = new WeakMap<PMNode, string>();

/** Remembers `node`'s source and returns the node, for chaining. */
export function register<T extends PMNode>(node: T, src: string): T {
  SRC.set(node, src);
  return node;
}

let nextGid = 1_000_000;

/** A mark group id that cannot collide with the per-block ids the parser uses. */
export function freshGid(): number {
  return nextGid++;
}
