// Restyling hand-set groups. In {\LARGE\bfseries Title\par} the bold mark is
// spelled "\bfseries " with no closing text: the group's brace ends it. That
// spelling only holds while the bold covers the whole group. Once the user
// changes part of it (un-bolds a word, drops the size), these helpers respell
// such marks the canonical way (\textbf{..}, {\large ..}), so the block can be
// written back with exactly the styling the user sees.

import type { Mark, Node as PMNode } from "prosemirror-model";
import { schema } from "../schema";
import type { DocContext, MarkName, SizeCmd } from "../types";
import { latexHelpers } from "./helpers";

/** A mark whose spelling only works inside an enclosing group: a declaration with no close. */
export function isDeclarationMark(mark: Mark): boolean {
  return mark.attrs.close === "" && typeof mark.attrs.open === "string" && (mark.attrs.open as string).startsWith("\\");
}

/** The canonical attrs for a mark like `mark`, or null when it cannot be respelled. */
function canonical(mark: Mark, ctx: DocContext): Record<string, unknown> | null {
  const name = mark.type.name;
  if (name === "size") return latexHelpers.sizeMark(mark.attrs.cmd as SizeCmd, ctx);
  if (name === "color") {
    const model = mark.attrs.model as string;
    const color = mark.attrs.color as string;
    if (model === "") return latexHelpers.colorMark(color, ctx);
    const attrs = latexHelpers.colorMark("black", ctx)!;
    return { ...attrs, open: `\\textcolor[${model}]{${color}}{`, color, model };
  }
  return latexHelpers.newMark(name as MarkName, ctx);
}

/**
 * The textblock with every declaration mark respelled canonically. Marks
 * that are already self-contained keep their exact spelling. Returns the same
 * node when nothing needed changing.
 */
export function detachDeclarations(block: PMNode, ctx: DocContext): PMNode {
  if (!block.isTextblock) return block;
  const fresh = new Map<Mark, Mark | null>();
  let changed = false;
  const kids: PMNode[] = [];
  block.forEach((child) => {
    let marks = child.marks;
    for (const m of child.marks) {
      if (!isDeclarationMark(m)) continue;
      // One replacement per mark, so a run keeps a single group.
      let found: Mark | null | undefined;
      for (const [k, v] of fresh) if (k.eq(m)) found = v;
      if (found === undefined) {
        const attrs = canonical(m, ctx);
        found = attrs ? schema.marks[m.type.name].create(attrs) : null;
        fresh.set(m, found);
      }
      if (found) {
        marks = found.addToSet(m.removeFromSet(marks));
        changed = true;
      }
    }
    kids.push(marks === child.marks ? child : child.mark(marks));
  });
  return changed ? block.type.create(block.attrs, kids, block.marks) : block;
}
