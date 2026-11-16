// Ties a ProseMirror view to the file's Monaco model. The model is the only
// document: every Visual edit is planned by the core session and pushed into
// the model as minimal text edits, and every model change (typing in Code
// mode, undo, a disk reload) flows back into the view. Undo and redo are the
// model's. Nothing here touches the DOM, so it runs in node tests.

import { EditorState, Selection, TextSelection, type Transaction } from "prosemirror-state";
import { ReplaceStep } from "prosemirror-transform";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import type { VisualSession } from "../core";

/** The part of an EditorView the binding uses. */
export interface ViewLike {
  state: EditorState;
  updateState(s: EditorState): void;
}

export interface ModelPosition {
  lineNumber: number;
  column: number;
}

export interface ModelRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** The part of a Monaco ITextModel the binding uses. */
export interface ModelLike {
  getValue(): string;
  getValueLength(): number;
  getPositionAt(offset: number): ModelPosition;
  getOffsetAt(pos: ModelPosition): number;
  pushEditOperations(
    beforeCursorState: null | [],
    ops: { range: ModelRange; text: string }[],
    cursorStateComputer: () => null,
  ): unknown;
  pushStackElement(): void;
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
  getAlternativeVersionId(): number;
  onDidChangeContent(fn: (e: { isUndoing: boolean; isRedoing: boolean }) => void): { dispose(): void };
}

/** A selection as source offsets. */
export interface SourceSel {
  anchor: number;
  head: number;
}

export interface BindingHost {
  toast(text: string): void;
  /** Reports the cursor as a 1-based line and column. */
  setCursor?(pos: { line: number; column: number }): void;
  /** Runs `fn` soon (requestAnimationFrame in the app; tests run it at once). */
  schedule?(fn: () => void): void;
  now?(): number;
  /** Compare the whole model with the planned text after every edit (the length is always checked). */
  dev?: boolean;
  /** Called after the view's state changes for any reason. */
  onChange?(state: EditorState): void;
}

/** Undo steps break after this long without an edit. */
export const GROUP_MS = 1000;
const SEL_MAP_MAX = 1000;
const TOAST_EVERY_MS = 3000;

export const REFUSED_MESSAGE =
  "Visual mode can't make that change safely here. Switch to Code (Ctrl+Shift+E) to edit this part.";

/** Transaction meta: always start a new undo step for this edit. */
export const NEW_UNDO_STEP = "texo.newUndoStep";
/** Transaction meta set on changes that came from the model. */
export const FROM_SOURCE = "fromSource";

/** One character typed or deleted inside a single text block. */
export function isPureTextEdit(tr: Transaction): boolean {
  if (tr.steps.length !== 1) return false;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep)) return false;
  const { from, to, slice } = step;
  const doc = tr.docs[0];
  if (slice.size === 0) {
    if (from === to) return false;
    const $from = doc.resolve(from);
    const $to = doc.resolve(to);
    return $from.parent === $to.parent && $from.parent.isTextblock && !hasAtom(doc, from, to);
  }
  if (from !== to || slice.openStart !== 0 || slice.openEnd !== 0) return false;
  const only = slice.content.childCount === 1 ? slice.content.firstChild : null;
  return !!only && only.isText && doc.resolve(from).parent.isTextblock;
}

function hasAtom(doc: PMNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (n) => {
    if (!n.isText && n.isInline) found = true;
    return !found;
  });
  return found;
}

/**
 * Replaces the top-level children of `tr.doc` that differ (by identity) from
 * `target`'s with target's own nodes, so the view's doc keeps exactly the
 * session's node objects (the core finds unchanged blocks by identity).
 */
export function replaceTopLevel(tr: Transaction, target: PMNode): Transaction {
  const cur = tr.doc;
  const n = cur.childCount;
  const m = target.childCount;
  let a = 0;
  while (a < n && a < m && cur.child(a) === target.child(a)) a++;
  if (a === n && a === m) return tr;
  let b = 0;
  while (b < n - a && b < m - a && cur.child(n - 1 - b) === target.child(m - 1 - b)) b++;
  let from = 0;
  for (let i = 0; i < a; i++) from += cur.child(i).nodeSize;
  let to = from;
  for (let i = a; i < n - b; i++) to += cur.child(i).nodeSize;
  const kids: PMNode[] = [];
  for (let j = a; j < m - b; j++) kids.push(target.child(j));
  tr.replaceWith(from, to, Fragment.from(kids));
  return tr;
}

function sameChildren(a: PMNode, b: PMNode): boolean {
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) if (a.child(i) !== b.child(i)) return false;
  return true;
}

export class Binding {
  readonly session: VisualSession;
  readonly model: ModelLike;
  readonly view: ViewLike;
  readonly selMap: Map<number, SourceSel>;
  private host: BindingHost;
  private applying = false;
  private lastEditAt = -Infinity;
  private lastSelAfter: { anchor: number; head: number } | null = null;
  /** The next outbound edit starts a new undo step (first edit after attaching, after a structural edit, …). */
  private breakNext = true;
  private lastToast = -Infinity;
  private cursorQueued = false;
  private sub: { dispose(): void };
  private disposed = false;
  /** While hidden, model changes only mark the view stale; show() catches up. */
  hidden = false;
  stale = false;

  constructor(opts: { session: VisualSession; model: ModelLike; view: ViewLike; selMap?: Map<number, SourceSel>; host: BindingHost }) {
    this.session = opts.session;
    this.model = opts.model;
    this.view = opts.view;
    this.selMap = opts.selMap ?? new Map();
    this.host = opts.host;
    this.sub = this.model.onDidChangeContent((e) => this.inbound(e));
    // The model may have moved on while no view was attached.
    if (this.session.text !== this.model.getValue() || !sameChildren(this.view.state.doc, this.session.doc)) this.syncNow(false);
  }

  dispose() {
    this.disposed = true;
    this.sub.dispose();
  }

  private now() {
    return this.host.now ? this.host.now() : Date.now();
  }

  // ---------------------------------------------------------------------------
  // Outbound: view → model

  dispatch = (tr: Transaction) => {
    if (this.disposed) return;
    const state = this.view.state;
    if (!tr.docChanged) {
      const next = state.apply(tr);
      this.setState(next);
      if (tr.selectionSet) this.cursorChanged();
      return;
    }
    const next = state.apply(tr);
    const res = this.session.plan(next.doc);
    if (!res.ok) {
      this.refuse(res.reason);
      return;
    }
    if (res.edits.length === 0) {
      this.session.commit(next.doc, res.newText);
      this.setState(next);
      this.cursorChanged();
      return;
    }

    const now = this.now();
    const pure = isPureTextEdit(tr);
    const sel = state.selection;
    const jumped = !!this.lastSelAfter && (sel.anchor !== this.lastSelAfter.anchor || sel.head !== this.lastSelAfter.head);
    if (this.breakNext || !pure || jumped || now - this.lastEditAt > GROUP_MS || tr.getMeta(NEW_UNDO_STEP)) {
      this.model.pushStackElement();
    }

    this.remember(this.model.getAlternativeVersionId(), this.toSource(sel));
    const ops = res.edits.map((e) => ({ range: this.rangeOf(e.offset, e.deleteLength), text: e.insert }));
    this.applying = true;
    try {
      this.model.pushEditOperations([], ops, () => null);
    } finally {
      this.applying = false;
    }
    // The model may store something other than what was planned (a lone LF
    // in a CRLF buffer becomes CRLF). Committing the plan then would leave
    // every later offset off, so check always: the length cheaply, the whole
    // text in dev builds.
    if (this.model.getValueLength() !== res.newText.length || (this.host.dev && this.model.getValue() !== res.newText)) {
      console.error("Visual: the model does not match the planned text; resyncing");
      this.syncNow(false);
      return;
    }
    this.session.commit(next.doc, res.newText);
    this.setState(next);
    this.remember(this.model.getAlternativeVersionId(), this.toSource(next.selection));
    this.lastEditAt = now;
    this.lastSelAfter = { anchor: next.selection.anchor, head: next.selection.head };
    // Structural edits stand alone in the undo history.
    this.breakNext = !pure;
    if (!pure) this.model.pushStackElement();
    this.cursorChanged();
  };

  private refuse(reason: string) {
    console.warn("Visual: refused an edit:", reason);
    const now = this.now();
    if (now - this.lastToast >= TOAST_EVERY_MS) {
      this.lastToast = now;
      this.host.toast(REFUSED_MESSAGE);
    }
  }

  private rangeOf(offset: number, length: number): ModelRange {
    const a = this.model.getPositionAt(offset);
    const b = this.model.getPositionAt(offset + length);
    return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
  }

  private remember(version: number, sel: SourceSel) {
    this.selMap.delete(version);
    this.selMap.set(version, sel);
    while (this.selMap.size > SEL_MAP_MAX) {
      const oldest = this.selMap.keys().next().value as number;
      this.selMap.delete(oldest);
    }
  }

  private toSource(sel: Selection): SourceSel {
    return { anchor: this.session.pmToSrc(sel.anchor), head: this.session.pmToSrc(sel.head) };
  }

  /** A selection in `doc` (the session's current doc) for source offsets. */
  selectionFor(doc: PMNode, src: SourceSel): Selection {
    const size = doc.content.size;
    const clamp = (p: number) => Math.max(0, Math.min(size, p));
    const a = clamp(this.session.srcToPm(src.anchor));
    const h = clamp(this.session.srcToPm(src.head));
    try {
      return TextSelection.between(doc.resolve(a), doc.resolve(h));
    } catch {
      return Selection.near(doc.resolve(h));
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound: model → view

  private inbound(e: { isUndoing: boolean; isRedoing: boolean }) {
    if (this.applying || this.disposed) return;
    if (this.hidden) {
      this.stale = true;
      return;
    }
    this.syncNow(e.isUndoing || e.isRedoing);
  }

  /** Brings the view up to the model's text; with `restore`, puts back the selection remembered for this version. */
  syncNow(restore: boolean) {
    this.session.syncFromText(this.model.getValue());
    this.stale = false;
    this.breakNext = true;
    this.lastSelAfter = null;
    const state = this.view.state;
    const target = this.session.doc;
    let tr = state.tr;
    if (state.doc !== target) tr = replaceTopLevel(tr, target);
    const saved = restore ? this.selMap.get(this.model.getAlternativeVersionId()) : undefined;
    let next: EditorState;
    if (sameChildren(tr.doc, target)) {
      if (saved) tr.setSelection(this.selectionFor(tr.doc, saved));
      tr.setMeta(FROM_SOURCE, true).setMeta("addToHistory", false);
      // The doc wrapper differs from the session's, but its blocks are the
      // session's own nodes, which is all the core compares. Applying (rather
      // than rebuilding) keeps plugin state: compile issues, find, stored marks.
      next = state.apply(tr);
    } else {
      const selection = saved ? this.selectionFor(target, saved) : this.mapSelection(state.selection, target);
      next = EditorState.create({ doc: target, selection, plugins: state.plugins });
    }
    if (!sameChildren(next.doc, target)) {
      next = EditorState.create({ doc: target, selection: this.mapSelection(next.selection, target), plugins: state.plugins });
    }
    this.setState(next);
    this.cursorChanged();
  }

  private mapSelection(sel: Selection, doc: PMNode): Selection {
    const size = doc.content.size;
    const h = Math.max(0, Math.min(size, sel.head));
    const a = Math.max(0, Math.min(size, sel.anchor));
    try {
      return TextSelection.between(doc.resolve(a), doc.resolve(h));
    } catch {
      return Selection.atStart(doc);
    }
  }

  /** Call when the view becomes visible again. */
  show() {
    this.hidden = false;
    this.breakNext = true;
    if (this.stale || this.session.text !== this.model.getValue()) this.syncNow(false);
  }

  hide() {
    this.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Commands for the UI

  /** Starts a new undo step before the next edit. */
  breakUndo() {
    this.model.pushStackElement();
    this.breakNext = true;
  }

  undo() {
    this.model.pushStackElement();
    void this.model.undo();
  }

  redo() {
    void this.model.redo();
  }

  /** The cursor (head) as a source offset. */
  sourceOffset(): number {
    return this.session.pmToSrc(this.view.state.selection.head);
  }

  /** Moves the selection to a source offset without editing anything. */
  selectSource(offset: number) {
    const state = this.view.state;
    const sel = this.selectionFor(state.doc, { anchor: offset, head: offset });
    this.setState(state.apply(state.tr.setSelection(sel)));
    this.cursorChanged();
  }

  private setState(next: EditorState) {
    this.view.updateState(next);
    this.host.onChange?.(next);
  }

  private cursorChanged() {
    const set = this.host.setCursor;
    if (!set || this.cursorQueued) return;
    this.cursorQueued = true;
    const run = () => {
      this.cursorQueued = false;
      if (this.disposed || this.hidden) return;
      const pos = this.model.getPositionAt(this.sourceOffset());
      set({ line: pos.lineNumber, column: pos.column });
    };
    if (this.host.schedule) this.host.schedule(run);
    else run();
  }
}
