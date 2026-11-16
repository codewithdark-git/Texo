// Test doubles for the Visual binding: a Monaco-like text model with undo
// stack elements and alternative version ids, and a bare view.

import type { EditorState } from "prosemirror-state";
import type { ModelLike, ModelPosition, ModelRange, ViewLike } from "./binding";

/** A small stand-in for a Monaco text model: edits, undo stack elements, alternative version ids. */
export class FakeModel implements ModelLike {
  text: string;
  private version = 1;
  private alt = 1;
  private undoStack: { beforeText: string; afterText: string; beforeAlt: number; afterAlt: number; open: boolean }[] = [];
  private redoStack: typeof this.undoStack = [];
  private listeners: ((e: { isUndoing: boolean; isRedoing: boolean }) => void)[] = [];
  edits = 0;
  stackElements = 0;
  /** Like Monaco: line breaks in inserted text take the buffer's own ("\r\n" when the text has one). */
  private normalizeEol: boolean;

  constructor(text: string, opts: { normalizeEol?: boolean } = {}) {
    this.text = text;
    this.normalizeEol = !!opts.normalizeEol;
  }
  getValue() {
    return this.text;
  }
  getValueLength() {
    return this.text.length;
  }
  getPositionAt(offset: number): ModelPosition {
    const before = this.text.slice(0, Math.max(0, Math.min(offset, this.text.length)));
    const lines = before.split("\n");
    return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
  }
  getOffsetAt(pos: ModelPosition): number {
    const lines = this.text.split("\n");
    let off = 0;
    for (let i = 0; i < pos.lineNumber - 1; i++) off += lines[i].length + 1;
    return off + pos.column - 1;
  }
  pushEditOperations(_sel: null | [], ops: { range: ModelRange; text: string }[]) {
    const abs = ops
      .map((o) => ({
        start: this.getOffsetAt({ lineNumber: o.range.startLineNumber, column: o.range.startColumn }),
        end: this.getOffsetAt({ lineNumber: o.range.endLineNumber, column: o.range.endColumn }),
        text: this.normalizeEol && this.text.includes("\r\n") ? o.text.replace(/\r\n|\r|\n/g, "\r\n") : o.text,
      }))
      .sort((a, b) => b.start - a.start);
    const beforeText = this.text;
    const beforeAlt = this.alt;
    let t = this.text;
    for (const o of abs) t = t.slice(0, o.start) + o.text + t.slice(o.end);
    this.text = t;
    this.alt = ++this.version;
    this.edits++;
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.open) {
      top.afterText = t;
      top.afterAlt = this.alt;
    } else this.undoStack.push({ beforeText, afterText: t, beforeAlt, afterAlt: this.alt, open: true });
    this.redoStack = [];
    this.fire(false, false);
    return null;
  }
  pushStackElement() {
    this.stackElements++;
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.open = false;
  }
  undo() {
    const el = this.undoStack.pop();
    if (!el) return;
    el.open = false;
    this.redoStack.push(el);
    this.text = el.beforeText;
    this.version++;
    this.alt = el.beforeAlt;
    this.fire(true, false);
  }
  redo() {
    const el = this.redoStack.pop();
    if (!el) return;
    this.undoStack.push(el);
    this.text = el.afterText;
    this.version++;
    this.alt = el.afterAlt;
    this.fire(false, true);
  }
  getAlternativeVersionId() {
    return this.alt;
  }
  onDidChangeContent(fn: (e: { isUndoing: boolean; isRedoing: boolean }) => void) {
    this.listeners.push(fn);
    return { dispose: () => void (this.listeners = this.listeners.filter((l) => l !== fn)) };
  }
  /** An edit made outside Visual mode (typing in Code mode). */
  external(offset: number, del: number, insert: string) {
    const a = this.getPositionAt(offset);
    const b = this.getPositionAt(offset + del);
    this.pushStackElement();
    this.pushEditOperations([], [
      { range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }, text: insert },
    ]);
  }
  private fire(isUndoing: boolean, isRedoing: boolean) {
    for (const l of this.listeners) l({ isUndoing, isRedoing });
  }
}

export class FakeView implements ViewLike {
  state: EditorState;
  updates = 0;
  constructor(state: EditorState) {
    this.state = state;
  }
  updateState(s: EditorState) {
    this.state = s;
    this.updates++;
  }
}
