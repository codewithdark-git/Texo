// Editing commands for Visual mode. Everything new is spelled by the dialect
// helpers, so what lands in the file is ordinary LaTeX or Markdown.

import { NodeSelection, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Fragment, type Mark, type MarkType, type Node as PMNode, type NodeType } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { chainCommands, liftEmptyBlock, splitBlock } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { schema, type Dialect, type DialectHelpers, type MarkName, type VisualSession } from "../core";
import type { Binding } from "./binding";
import { NEW_UNDO_STEP } from "./binding";

/** What commands, plugins and node views need to know about the open file. */
export interface VisualEnv {
  path: string;
  dialect: Dialect;
  session: VisualSession;
  binding: Binding;
  helpers: DialectHelpers;
  view: EditorView;
  toast(text: string, kind?: "success" | "info" | "error"): void;
  /** Leaves Visual mode with the cursor at a source offset. */
  openInCode(offset?: number): void;
}

/** Commands take the env lazily: the pane swaps it when the file changes. */
export type GetEnv = () => VisualEnv | null;

/**
 * Text from the DOM (a textarea, the clipboard) with the file's own line
 * breaks. Textareas hand back bare "\n"; written as-is into a CRLF file, the
 * code editor would store something other than the planned text.
 */
export function toEol(text: string, eol: string): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

/** toEol for the env's file. */
export function fileEol(env: VisualEnv, text: string): string {
  return toEol(text, env.session.context.eol);
}

/** `base` if no label in `taken` has it, else `base2`, `base3`, … */
export function uniqueLabel(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(base + i)) i++;
  return base + i;
}

const { nodes: N, marks: M } = schema;

export const isLatex = (env: VisualEnv) => env.dialect === "latex";

// -----------------------------------------------------------------------------
// Marks

export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** Can this dialect spell the mark at all? */
export function markSupported(env: VisualEnv, name: MarkName): boolean {
  return env.helpers.newMark(name, env.session.context) !== null;
}

export function toggleMark(getEnv: GetEnv, name: MarkName, href?: string): Command {
  return (state, dispatch) => {
    const env = getEnv();
    if (!env) return false;
    const type = M[name];
    const { from, to, empty, $from } = state.selection;
    if (!$from.parent.inlineContent || $from.parent.type.spec.code) return false;
    const active = markActive(state, type);
    const attrs = active ? null : env.helpers.newMark(name, env.session.context, href);
    if (!active && !attrs) return false;
    if (!dispatch) return true;
    if (empty) {
      dispatch(active ? state.tr.removeStoredMark(type) : state.tr.addStoredMark(type.create(attrs)));
      return true;
    }
    const tr = active ? state.tr.removeMark(from, to, type) : state.tr.addMark(from, to, type.create(attrs));
    dispatch(tr.setMeta(NEW_UNDO_STEP, true));
    return true;
  };
}

// -----------------------------------------------------------------------------
// Blocks

/** The textblock around the cursor, with its position. */
function textblockAt(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return null;
  return { node: $from.parent, pos: $from.before() };
}

/** Current block type for the toolbar: 0 = paragraph, 1-4 = heading level, -1 = other. */
export function blockLevel(state: EditorState): number {
  const tb = textblockAt(state);
  if (!tb) return -1;
  if (tb.node.type === N.paragraph) return 0;
  if (tb.node.type === N.heading) return Math.max(1, Math.min(4, tb.node.attrs.level as number));
  return -1;
}

/** Paragraph (level 0) or heading level 1-4. A heading's trailing source is never dropped. */
export function setBlock(getEnv: GetEnv, level: 0 | 1 | 2 | 3 | 4): Command {
  return (state, dispatch) => {
    const env = getEnv();
    const tb = textblockAt(state);
    if (!env || !tb) return false;
    const { node, pos } = tb;
    if (node.type !== N.paragraph && node.type !== N.heading) return false;
    if (level === 0 && node.type === N.paragraph) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    if (level === 0) {
      tr.setNodeMarkup(pos, N.paragraph, null);
      const trail = node.attrs.trail as string;
      if (trail) {
        // What followed the title (\label{..}, a comment) stays, as inline content.
        const end = pos + node.nodeSize - 1;
        const frag = env.session.parseInlineSnippet(trail);
        tr.insert(end, frag.size ? frag : N.raw_inline.create({ src: trail, label: "LaTeX" }));
      }
    } else {
      const prev = node.type === N.heading ? (node.attrs as Record<string, unknown>) : undefined;
      tr.setNodeMarkup(pos, N.heading, env.helpers.headingAttrs(level, env.session.context, prev));
    }
    dispatch(tr.setMeta(NEW_UNDO_STEP, true));
    return true;
  };
}

export type ListKind = "bullet" | "ordered" | "description";

function listAround(state: EditorState): { node: PMNode; pos: number; depth: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type === N.list) return { node: n, pos: $from.before(d), depth: d };
  }
  return null;
}

export function listKindAt(state: EditorState): ListKind | null {
  return (listAround(state)?.node.attrs.kind as ListKind | undefined) ?? null;
}

/** Item attrs for a list kind in this dialect. */
function itemAttrs(env: VisualEnv, kind: ListKind, index: number) {
  return env.helpers.itemAttrs(kind, index, env.session.context);
}

/** Wraps the paragraph in a list, switches the list's kind, or (same kind) lifts it out. */
export function toggleList(getEnv: GetEnv, kind: ListKind): Command {
  return (state, dispatch) => {
    const env = getEnv();
    if (!env) return false;
    const around = listAround(state);
    if (around) {
      if (around.node.attrs.kind === kind) return liftItem(getEnv)(state, dispatch);
      if (!dispatch) return true;
      const fresh = env.helpers.listAttrs(kind, env.session.context);
      const tr = state.tr.setNodeMarkup(around.pos, null, { ...around.node.attrs, ...fresh, gaps: around.node.attrs.gaps });
      let p = around.pos + 1;
      around.node.forEach((item, _o, i) => {
        tr.setNodeMarkup(p, null, { ...item.attrs, ...itemAttrs(env, kind, i), gaps: item.attrs.gaps });
        p += item.nodeSize;
      });
      dispatch(tr.setMeta(NEW_UNDO_STEP, true));
      return true;
    }
    const tb = textblockAt(state);
    if (!tb || tb.node.type !== N.paragraph) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    wrapInList(env, tr, kind);
    dispatch(tr.setMeta(NEW_UNDO_STEP, true));
    return true;
  };
}

/** Wraps the paragraph at tr's selection in a new list. False when the cursor isn't in a paragraph. */
export function wrapInList(env: VisualEnv, tr: Transaction, kind: ListKind): boolean {
  const { $from } = tr.selection;
  const para = $from.parent;
  if (para.type !== N.paragraph) return false;
  const pos = $from.before();
  const offset = tr.selection.from - pos;
  const item = N.list_item.create(itemAttrs(env, kind, 0), para);
  const list = N.list.create(env.helpers.listAttrs(kind, env.session.context), item);
  tr.replaceWith(pos, pos + para.nodeSize, list);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2 + offset)));
  return true;
}

/** Wraps the paragraph at tr's selection in a quote. */
export function wrapInQuote(env: VisualEnv, tr: Transaction): boolean {
  const { $from } = tr.selection;
  const para = $from.parent;
  if (para.type !== N.paragraph) return false;
  const pos = $from.before();
  const offset = tr.selection.from - pos;
  const quote = N.container.create(env.helpers.containerAttrs("quote", env.session.context), para);
  tr.replaceWith(pos, pos + para.nodeSize, quote);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1 + offset)));
  return true;
}

/** Turns the paragraph at tr's selection into a heading. */
export function makeHeading(env: VisualEnv, tr: Transaction, level: 1 | 2 | 3 | 4): boolean {
  const { $from } = tr.selection;
  if ($from.parent.type !== N.paragraph) return false;
  tr.setNodeMarkup($from.before(), N.heading, env.helpers.headingAttrs(level, env.session.context));
  return true;
}

/** Wraps the paragraph in a quote, or unwraps a quote around it. */
export function toggleQuote(getEnv: GetEnv): Command {
  return (state, dispatch) => {
    const env = getEnv();
    if (!env) return false;
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type === N.container && n.attrs.kind === "quote") {
        if (!dispatch) return true;
        const pos = $from.before(d);
        const tr = state.tr.replaceWith(pos, pos + n.nodeSize, n.content);
        dispatch(tr.setMeta(NEW_UNDO_STEP, true));
        return true;
      }
    }
    const tb = textblockAt(state);
    if (!tb || tb.node.type !== N.paragraph) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    wrapInQuote(env, tr);
    dispatch(tr.setMeta(NEW_UNDO_STEP, true));
    return true;
  };
}

export function quoteActive(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type === N.container && n.attrs.kind === "quote") return true;
  }
  return false;
}

/**
 * prosemirror-schema-list makes nested lists and items with default attrs
 * (no \begin, no \item). Gives them this dialect's spelling, following the
 * enclosing list's kind.
 */
export function spellNewLists(env: VisualEnv, tr: Transaction) {
  const start = tr.doc.content.findDiffStart(tr.before.content);
  if (start === null) return;
  const end = tr.doc.content.findDiffEnd(tr.before.content);
  const to = Math.min(tr.doc.content.size, Math.max(start, end ? end.a : tr.doc.content.size));
  const fixes: { pos: number; attrs: Record<string, unknown> }[] = [];
  tr.doc.nodesBetween(start, to, (node, pos, parent, index) => {
    if (node.type === N.list && (node.attrs.gaps as unknown[]).length === 0 && node.attrs.begin === "") {
      const $pos = tr.doc.resolve(pos);
      let kind = node.attrs.kind as ListKind;
      for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).type === N.list) {
          kind = $pos.node(d).attrs.kind as ListKind;
          break;
        }
      }
      fixes.push({ pos, attrs: env.helpers.listAttrs(kind, env.session.context) });
    } else if (node.type === N.list_item && node.attrs.head === "" && parent?.type === N.list) {
      fixes.push({ pos, attrs: itemAttrs(env, parent.attrs.kind as ListKind, index) });
    }
    return !node.isTextblock;
  });
  for (const f of fixes) {
    const node = tr.doc.nodeAt(f.pos);
    if (!node) continue;
    const attrs = { ...node.attrs, ...f.attrs };
    // Already spelled (a fresh Markdown list has no begin and no gaps): leave it.
    if (Object.keys(attrs).every((k) => JSON.stringify(attrs[k]) === JSON.stringify(node.attrs[k]))) continue;
    tr.setNodeMarkup(f.pos, null, attrs);
  }
}

/**
 * Gives every user transaction's new lists and items their dialect spelling
 * before it is planned. Backspace (joinBackward) and drag and drop can make
 * list items with default attrs, which would otherwise serialize without
 * their \item or "- " and be refused.
 */
export function normalizeTransaction(env: VisualEnv, tr: Transaction): Transaction {
  if (!tr.docChanged || tr.getMeta("fromSource")) return tr;
  spellNewLists(env, tr);
  return tr;
}

/** Runs a list command into a transaction, spells what it made, and dispatches it. */
function listCommand(getEnv: GetEnv, cmd: Command): Command {
  return (state, dispatch, view) => {
    const env = getEnv();
    let made: Transaction | null = null;
    if (!cmd(state, (tr) => (made = tr), view)) return false;
    if (!dispatch) return true;
    const tr = made as Transaction | null;
    if (!tr) return true;
    if (env) spellNewLists(env, tr);
    dispatch(tr.setMeta(NEW_UNDO_STEP, true));
    return true;
  };
}

export const sinkItem = (getEnv: GetEnv): Command => listCommand(getEnv, sinkListItem(N.list_item));
export const liftItem = (getEnv: GetEnv): Command => listCommand(getEnv, liftListItem(N.list_item));

/** Enter: split a list item (exit on an empty one), otherwise split the block. */
export function enter(getEnv: GetEnv): Command {
  return (state, dispatch, view) => {
    const env = getEnv();
    const around = listAround(state);
    if (env && around && state.selection.$from.parent.isTextblock) {
      const kind = around.node.attrs.kind as ListKind;
      const index = state.selection.$from.index(around.depth) + 1;
      const split = listCommand(getEnv, splitListItem(N.list_item, itemAttrs(env, kind, index)));
      if (state.selection.$from.parent.content.size === 0) {
        // Leaving the list from an empty item. In the middle of a Markdown
        // list that would make two lists the file can't keep apart: stay put.
        let lifted: Transaction | null = null;
        if (liftItem(getEnv)(state, (tr) => (lifted = tr))) {
          const tr = lifted as Transaction | null;
          if (tr && !env.session.plan(tr.doc).ok) return true;
          if (tr && dispatch) dispatch(tr);
          return true;
        }
      }
      if (split(state, dispatch, view)) return true;
    }
    // Enter on an empty paragraph in a quote (or other box) leaves the box.
    const { $from, empty } = state.selection;
    if (empty && $from.depth > 1 && $from.parent.type === N.paragraph && $from.parent.content.size === 0 && $from.node(-1).type === N.container) {
      if (liftEmptyBlock(state, dispatch && ((tr) => dispatch(tr.setMeta(NEW_UNDO_STEP, true))), view)) return true;
    }
    return chainCommands(splitBlock)(state, dispatch, view);
  };
}

/** Shift+Enter: a LaTeX line break (\\ and a new line), or Markdown's hard break. */
export function hardBreak(getEnv: GetEnv): Command {
  return (state, dispatch) => {
    const env = getEnv();
    const { $from } = state.selection;
    if (!env || !$from.parent.inlineContent || $from.parent.type.spec.code) return false;
    if (!dispatch) return true;
    const eol = env.session.context.eol;
    const src = isLatex(env) ? "\\\\" : "\\";
    const tr = state.tr.replaceSelectionWith(N.raw_inline.create({ src, label: "line break" }), false);
    const at = tr.selection.from;
    tr.insert(at, N.softbreak.create({ src: eol }));
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
    dispatch(tr.setMeta(NEW_UNDO_STEP, true).scrollIntoView());
    return true;
  };
}

// -----------------------------------------------------------------------------
// Inserting

/** Inserts inline nodes at the selection. */
export function insertInline(view: EditorView, content: Fragment | PMNode, marks?: readonly Mark[]) {
  const { state } = view;
  const frag = content instanceof Fragment ? content : Fragment.from(content);
  if (frag.size === 0) return;
  const tr = state.tr.replaceWith(state.selection.from, state.selection.to, frag);
  if (marks) tr.ensureMarks(marks);
  view.dispatch(tr.setMeta(NEW_UNDO_STEP, true).scrollIntoView());
}

/** Where a new block goes: the empty paragraph the cursor is in, or after the top-level block. */
function blockSlot(state: EditorState): { from: number; to: number } {
  const { $from } = state.selection;
  if (state.selection instanceof NodeSelection && $from.depth === 0) {
    const end = state.selection.to;
    return { from: end, to: end };
  }
  if ($from.depth >= 1) {
    const top = $from.node(1);
    const start = $from.before(1);
    if (top.type === N.paragraph && top.content.size === 0) return { from: start, to: start + top.nodeSize };
    if (top.type === N.preamble) return { from: start + top.nodeSize, to: start + top.nodeSize };
    return { from: start + top.nodeSize, to: start + top.nodeSize };
  }
  const pos = Math.min($from.pos, state.doc.content.size);
  return { from: pos, to: pos };
}

/** Inserts blocks parsed from source. `pkgs` are added to the preamble in the same transaction. */
export function insertBlocks(env: VisualEnv, src: string, pkgs: string[] = []) {
  const view = env.view;
  const frag = env.session.parseSnippet(fileEol(env, src));
  if (frag.size === 0) return;
  const tr = view.state.tr;
  const slot = blockSlot(view.state);
  // Never insert after the postamble.
  const last = tr.doc.lastChild;
  let { from, to } = slot;
  if (last && last.type === N.postamble) {
    const pStart = tr.doc.content.size - last.nodeSize;
    if (from > pStart) from = to = pStart;
  }
  tr.replaceWith(from, to, frag);
  const added = ensurePackages(env, tr, pkgs);
  const after = Math.min(tr.doc.content.size, from + frag.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(after), -1));
  view.dispatch(tr.setMeta(NEW_UNDO_STEP, true).scrollIntoView());
  for (const p of added) env.toast(`Added \\usepackage{${p}}`, "info");
}

/** Adds \usepackage lines to the preamble node in `tr`. Returns the packages it added. */
export function ensurePackages(env: VisualEnv, tr: Transaction, pkgs: string[]): string[] {
  const first = tr.doc.firstChild;
  if (!first || first.type !== N.preamble || pkgs.length === 0) return [];
  let src = first.attrs.src as string;
  const added: string[] = [];
  for (const pkg of pkgs) {
    const next = env.helpers.ensurePackage(src, pkg, env.session.context);
    if (next !== null) {
      src = next;
      added.push(pkg);
    }
  }
  if (added.length) tr.setNodeMarkup(0, null, { ...first.attrs, src });
  return added;
}

/** Inserts inline source (\cite{..}, \ref{..}, \footnote{..}, …) parsed as chips. */
export function insertInlineSrc(env: VisualEnv, src: string) {
  insertInline(env.view, env.session.parseInlineSnippet(fileEol(env, src)));
}

export function insertMathInline(env: VisualEnv, body: string) {
  insertInline(env.view, N.math_inline.create(env.helpers.mathInlineAttrs(fileEol(env, body))));
}

export function insertMathDisplay(env: VisualEnv, body: string, style: "brackets" | "equation") {
  body = fileEol(env, body);
  const attrs = env.helpers.mathDisplayAttrs(body, env.session.context, style);
  const view = env.view;
  const tr = view.state.tr;
  const slot = blockSlot(view.state);
  tr.replaceWith(slot.from, slot.to, N.math_display.create(attrs));
  // equation* and the multi-line environments are amsmath's.
  const pkgs = isLatex(env) && (style === "equation" || /\\begin\{(align|gather|multline)/.test(body)) ? ["amsmath"] : [];
  const added = ensurePackages(env, tr, pkgs);
  view.dispatch(tr.setMeta(NEW_UNDO_STEP, true).scrollIntoView());
  for (const p of added) env.toast(`Added \\usepackage{${p}}`, "info");
}

/** Replaces the node at `pos` with new attrs (atoms: maths body, raw source, keys…). */
export function setAttrs(view: EditorView, pos: number, attrs: Record<string, unknown>, type?: NodeType) {
  const tr = view.state.tr.setNodeMarkup(pos, type ?? null, attrs);
  view.dispatch(tr.setMeta(NEW_UNDO_STEP, true));
}

/** Replaces the node at `pos` with nodes parsed from source. */
export function replaceWithSource(env: VisualEnv, pos: number, src: string, inline: boolean) {
  const view = env.view;
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  src = fileEol(env, src);
  const frag = inline ? env.session.parseInlineSnippet(src) : env.session.parseSnippet(src);
  const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, frag);
  view.dispatch(tr.setMeta(NEW_UNDO_STEP, true));
}

/** The link mark at the cursor, with its extent. */
export function linkAt(state: EditorState): { mark: Mark; from: number; to: number } | null {
  const { $from } = state.selection;
  const type = M.link;
  const mark = type.isInSet($from.marks()) ?? ($from.nodeAfter ? type.isInSet($from.nodeAfter.marks) : undefined);
  if (!mark) return null;
  const start = $from.start();
  // Runs of children carrying this exact mark; return the one around the cursor.
  let runFrom = -1;
  let runTo = -1;
  let found: { from: number; to: number } | null = null;
  $from.parent.forEach((child, offset) => {
    if (found) return;
    const a = start + offset;
    const b = a + child.nodeSize;
    if (mark.isInSet(child.marks)) {
      if (runFrom === -1) runFrom = a;
      runTo = b;
    } else {
      if (runFrom !== -1 && runFrom <= $from.pos && $from.pos <= runTo) found = { from: runFrom, to: runTo };
      runFrom = -1;
    }
  });
  if (!found && runFrom !== -1 && runFrom <= $from.pos && $from.pos <= runTo) found = { from: runFrom, to: runTo };
  return found ? { mark, ...(found as { from: number; to: number }) } : null;
}

/** Only web and mail links open from Visual mode. */
export function safeUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}
