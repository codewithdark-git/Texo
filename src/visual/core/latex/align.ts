// Paragraph alignment as Word shows it: LaTeX writes it as a center,
// flushleft or flushright environment around the blocks. These pure helpers
// build, change and remove that wrapper; the view puts the result in a
// transaction and the session plans the text edit as for any other change.

import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../schema";
import type { Align, DocContext } from "../types";
import { latexHelpers } from "./helpers";
import { ALIGN_OF_ENV } from "./blocks";

/** The alignment a block sets for its content: a center / flushleft / flushright container, else null. */
export function alignOf(node: PMNode): Align | null {
  if (node.type !== schema.nodes.container) return null;
  const a = node.attrs.align as string;
  if (a === "center" || a === "left" || a === "right") return a;
  return ALIGN_OF_ENV[node.attrs.env as string] ?? null;
}

/** A new alignment container holding `blocks` (\begin{center} .. \end{center}). */
export function wrapAligned(blocks: readonly PMNode[], align: Align, ctx: DocContext): PMNode | null {
  const attrs = latexHelpers.alignAttrs(align, ctx);
  if (!attrs || blocks.length === 0) return null;
  return schema.nodes.container.createChecked(attrs, blocks);
}

/** The blocks inside an alignment container, to put in its place (back to plain). */
export function unwrapAligned(node: PMNode): PMNode[] | null {
  if (alignOf(node) === null) return null;
  const out: PMNode[] = [];
  node.forEach((child) => {
    if (!(child.type === schema.nodes.paragraph && child.content.size === 0)) out.push(child);
  });
  return out.length > 0 ? out : [schema.nodes.paragraph.create()];
}

/**
 * The same container with another alignment: only the environment name
 * changes, so the children and the gaps between them keep their bytes.
 */
export function setAlign(node: PMNode, align: Align, ctx: DocContext): PMNode | null {
  if (alignOf(node) === null) return null;
  const fresh = latexHelpers.alignAttrs(align, ctx)!;
  const oldEnv = node.attrs.env as string;
  const begin = (node.attrs.begin as string).replace(`\\begin{${oldEnv}}`, fresh.begin as string);
  const end = (node.attrs.end as string).replace(`\\end{${oldEnv}}`, fresh.end as string);
  return node.type.create({ ...node.attrs, ...fresh, begin, end, gaps: node.attrs.gaps }, node.content, node.marks);
}
