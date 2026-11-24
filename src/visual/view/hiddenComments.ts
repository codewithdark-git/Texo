// Backspace and Delete next to a hidden LaTeX comment. With "Show LaTeX
// comments" off, comment blocks and inline comments are invisible atoms, and
// ProseMirror's own Backspace/Delete would remove them: nothing changes on
// screen, but the comment is gone from the source. These commands step over
// hidden comments instead, so the key does what the user sees (joins the two
// paragraphs, deletes the visible character) and the comment's bytes stay.

import { NodeSelection, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

/** A `% ...` line inside a paragraph (a raw_inline whose source is a comment). */
function isInlineComment(node: PMNode | null | undefined): boolean {
  return !!node && node.type.name === "raw_inline" && /^\s*%/.test((node.attrs.src as string) ?? "");
}

function isCommentBlock(node: PMNode | null | undefined): boolean {
  return !!node && node.type.name === "comment_block";
}

/** Comments are hidden when the pane carries the v-hide-comments class. */
export function commentsHiddenInDom(view?: EditorView): boolean {
  const dom = view?.dom as (HTMLElement & { closest?: (s: string) => Element | null }) | undefined;
  return !!dom?.closest?.(".v-hide-comments");
}

type Dir = -1 | 1;

/**
 * Joins the textblock at the caret with its neighbour across one or more
 * hidden comment blocks. The comments move to just after the joined block, so
 * every byte of them stays in the source.
 */
function joinAcrossComments(state: EditorState, dir: Dir, dispatch?: (tr: Transaction) => void): boolean {
  const { $from } = state.selection;
  const parent = $from.parent;
  if (!parent.isTextblock) return false;
  const atEdge = dir < 0 ? $from.parentOffset === 0 : $from.parentOffset === parent.content.size;
  if (!atEdge || $from.depth < 1) return false;
  const container = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  // The run of comment blocks between this block and its neighbour.
  let i = index + dir;
  while (i >= 0 && i < container.childCount && isCommentBlock(container.child(i))) i += dir;
  const comments = Math.abs(i - index) - 1;
  if (comments === 0) return false;
  const blockStart = $from.before();
  const blockEnd = $from.after();
  const commentSize = (from: number, to: number) => {
    let size = 0;
    for (let k = from; k <= to; k++) size += container.child(k).nodeSize;
    return size;
  };
  const neighbour = i >= 0 && i < container.childCount ? container.child(i) : null;
  if (!neighbour?.isTextblock) {
    // Nothing to join with: select a neighbouring atom the way the key would,
    // or do nothing, but never delete the hidden comment.
    if (neighbour && NodeSelection.isSelectable(neighbour) && dispatch) {
      const size = dir < 0 ? commentSize(i + 1, index - 1) : commentSize(index + 1, i - 1);
      const at = dir < 0 ? blockStart - size - neighbour.nodeSize : blockEnd + size;
      dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)).scrollIntoView());
    }
    return true;
  }
  if (!dispatch) return true;
  const [first, last] = dir < 0 ? [i + 1, index - 1] : [index + 1, i - 1];
  const size = commentSize(first, last);
  // The two block edges to stitch together: the end of the first block's
  // content and the start of the second's.
  const from = dir < 0 ? blockStart - size - 1 : $from.pos;
  const to = dir < 0 ? $from.pos : blockEnd + size + 1;
  const commentStart = dir < 0 ? blockStart - size : blockEnd;
  const moved = state.doc.slice(commentStart, commentStart + size).content;
  const tr = state.tr.delete(from, to);
  const joinedEnd = tr.doc.resolve(from).after();
  tr.insert(joinedEnd, moved);
  tr.setSelection(TextSelection.create(tr.doc, from)).scrollIntoView();
  dispatch(tr);
  return true;
}

/**
 * Inside a paragraph: deletes the visible character or atom on the other side
 * of hidden inline comments, keeping the comments.
 */
function deleteAcrossInlineComments(state: EditorState, dir: Dir, dispatch?: (tr: Transaction) => void): boolean {
  const { $from } = state.selection;
  const parent = $from.parent;
  if (!parent.isTextblock) return false;
  if (!isInlineComment(dir < 0 ? $from.nodeBefore : $from.nodeAfter)) return false;
  // Next to an atom the caret is between children, so index() is the one after it.
  let index = dir < 0 ? $from.index() - 1 : $from.index();
  let skipped = 0;
  while (index >= 0 && index < parent.childCount && isInlineComment(parent.child(index))) {
    skipped += parent.child(index).nodeSize;
    index += dir;
  }
  if (skipped === 0) return false;
  if (!dispatch) return true;
  const edge = dir < 0 ? $from.pos - skipped : $from.pos + skipped;
  const target = index >= 0 && index < parent.childCount ? parent.child(index) : null;
  // At the start (or end) of the paragraph past the comments: nothing visible to delete here.
  if (!target) return true;
  const width = target.isText ? 1 : target.nodeSize;
  const [a, b] = dir < 0 ? [edge - width, edge] : [edge, edge + width];
  const tr = state.tr.delete(a, b);
  // Keep the caret where the user sees it: next to the deleted spot.
  tr.setSelection(TextSelection.create(tr.doc, dir < 0 ? tr.mapping.map($from.pos) : $from.pos)).scrollIntoView();
  dispatch(tr);
  return true;
}

/**
 * Backspace (dir -1) or Delete (dir 1) that steps over hidden comments.
 * Falls through (returns false) when comments are shown or none are next to
 * the caret, so the base keymap handles everything else.
 */
export function skipHiddenComments(dir: Dir, hidden: (view?: EditorView) => boolean = commentsHiddenInDom): Command {
  return (state, dispatch, view) => {
    if (!state.selection.empty || !hidden(view)) return false;
    return joinAcrossComments(state, dir, dispatch) || deleteAcrossInlineComments(state, dir, dispatch);
  };
}
