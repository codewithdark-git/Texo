// Which editor is in front (the code editor or Visual mode), so the outline,
// compile log, search, and PDF can move its cursor without knowing which one
// it is. Also switches a file between Code and Visual.

import type { monaco } from "../editor/monaco";
import { hideMathHover } from "../editor/mathHover";
import { toast } from "../ui";
import { getModel, modeFor, useWorkspace, visualSupported, type EditorMode } from "./store";

export interface ActiveEditor {
  revealLine(line: number): void;
  getLine(): number | null;
  focus(): void;
  zoom(step: 1 | -1 | 0): void;
  /** The file this editor is showing, if any. */
  readonly path?: string | null;
  /** The cursor as an offset in the file's text (Visual mode reports it on switching back). */
  sourceOffset?(): number | null;
}

/** Visual mode handles files up to this size. */
export const VISUAL_MAX_BYTES = 2 * 1024 * 1024;

let active: ActiveEditor | null = null;
let fallback: ActiveEditor | null = null;
let codeEditor: monaco.editor.IStandaloneCodeEditor | null = null;

/** Visual mode registers itself here while it is showing a file; null hands back to the code editor. */
export function setActiveEditor(ed: ActiveEditor | null) {
  active = ed;
}

export function getActiveEditor(): ActiveEditor | null {
  return active ?? fallback;
}

/** The always-mounted code editor: the fallback when Visual mode isn't showing. */
export function setCodeEditor(ed: ActiveEditor | null, raw: monaco.editor.IStandaloneCodeEditor | null) {
  fallback = ed;
  codeEditor = raw;
}

/** Whether the file shows in Visual mode right now (supported, chosen, and small enough). */
export function showsVisual(path: string | null, modes?: Record<string, EditorMode>): boolean {
  if (!path || !visualSupported(path) || modeFor(path, modes) !== "visual") return false;
  const model = getModel(path);
  return !model || model.getValueLength() <= VISUAL_MAX_BYTES;
}

// Where Visual mode should put the cursor when it opens a file (a source offset).
const visualStart = new Map<string, number>();

export function takeVisualStart(path: string): number | undefined {
  const at = visualStart.get(path);
  visualStart.delete(path);
  return at;
}

/** Switches a file between Code and Visual, carrying the cursor across. */
export function switchMode(path: string, mode: EditorMode, at?: number) {
  // What is on screen, not the saved mode: a file too large for Visual shows Code.
  if (!visualSupported(path) || (showsVisual(path) ? "visual" : "code") === mode) return;
  // A maths preview over the code editor would stay behind once it is hidden.
  hideMathHover();
  const ws = useWorkspace.getState();
  const model = getModel(path);
  if (mode === "visual") {
    if (model && model.getValueLength() > VISUAL_MAX_BYTES) {
      toast("This file is too large for Visual mode (over 2 MB).", "info");
      return;
    }
    if (model) {
      // Edits made in Visual mode start their own undo step.
      model.pushStackElement();
      let offset = at;
      const pos = codeEditor?.getModel() === model ? codeEditor.getPosition() : null;
      if (offset === undefined && pos) offset = model.getOffsetAt(pos);
      if (offset !== undefined) visualStart.set(path, offset);
    }
    ws.setMode(path, "visual");
    return;
  }
  const visual = active && active.path === path ? active : null;
  const offset = at ?? visual?.sourceOffset?.() ?? null;
  model?.pushStackElement();
  ws.setMode(path, "code");
  const ed = codeEditor;
  if (!ed || !model) return;
  requestAnimationFrame(() => {
    if (ed.getModel() !== model) return;
    if (offset !== null) {
      const pos = model.getPositionAt(offset);
      ed.setPosition(pos);
      ed.revealPositionInCenterIfOutsideViewport(pos);
    }
    ed.focus();
  });
}

export function toggleMode(path: string) {
  switchMode(path, showsVisual(path) ? "code" : "visual");
}

/** What the code editor has selected in `path`, as whole lines plus the exact text (null when nothing is selected). */
export function editorSelection(path: string | null): { startLine: number; endLine: number; text: string } | null {
  const ed = codeEditor;
  const model = path ? getModel(path) : undefined;
  if (!ed || !model || ed.getModel() !== model || showsVisual(path)) return null;
  const sel = ed.getSelection();
  if (!sel || sel.isEmpty()) return null;
  const text = model.getValueInRange(sel);
  if (!text.trim()) return null;
  return { startLine: sel.startLineNumber, endLine: sel.endLineNumber, text };
}

/** Puts `text` at the cursor of the file in front (replacing a selection in the code editor) as one undo step.
 * Returns the file it went into, or null when no text file is open. */
export function insertAtCursor(text: string): string | null {
  const path = useWorkspace.getState().active;
  const model = path ? getModel(path) : undefined;
  if (!path || !model) return null;
  const visual = active && active.path === path ? active : null;
  const ed = codeEditor?.getModel() === model ? codeEditor : null;
  model.pushStackElement();
  if (visual) {
    // Visual mode follows the model, so the text goes in at its cursor's source offset.
    const offset = visual.sourceOffset?.() ?? model.getValueLength();
    const pos = model.getPositionAt(offset);
    model.pushEditOperations([], [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text }], () => null);
    model.pushStackElement();
    visual.focus();
    return path;
  }
  if (ed) {
    const sel = ed.getSelection();
    const end = model.getFullModelRange().getEndPosition();
    const range = sel ?? { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column };
    ed.executeEdits("texo-ai-insert", [{ range, text, forceMoveMarkers: true }]);
    model.pushStackElement();
    ed.focus();
    return path;
  }
  const end = model.getFullModelRange().getEndPosition();
  model.pushEditOperations([], [{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text }], () => null);
  model.pushStackElement();
  return path;
}
