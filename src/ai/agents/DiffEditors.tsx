// Monaco views for the changeset review: a diff (the file when the agent
// started vs. what will be written, the right side editable) and a plain
// editor for resolving a conflict in place. Models are private to the
// dialog (no file URI), so they never mix with the workspace's editors.

import { useEffect, useRef } from "react";
import { languageFor, monaco } from "../../editor/monaco";

const OPTIONS: monaco.editor.IEditorOptions = {
  minimap: { enabled: false },
  fontSize: 12,
  lineNumbersMinChars: 3,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  wordWrap: "on",
  renderWhitespace: "boundary",
};

// Monaco's diff worker rejects a pending computation with "no diff result
// available" when its models are swapped or disposed mid-way (switching files,
// closing the dialog). Nothing is lost; keep it out of the console as an
// unhandled rejection.
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "");
    if (msg === "no diff result available") e.preventDefault();
  });
}

/** Keeps a model's text equal to `text` without reporting it as the user's edit. */
function useSyncedModel(model: monaco.editor.ITextModel | null, text: string, quiet: { current: boolean }) {
  useEffect(() => {
    if (!model || model.isDisposed() || model.getValue() === text) return;
    quiet.current = true;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    quiet.current = false;
  }, [model, text, quiet]);
}

export interface DiffViewProps {
  path: string;
  original: string;
  modified: string;
  readOnly: boolean;
  /** The user typed in the right side. */
  onEdit?: (text: string) => void;
  /** Scroll the right side to this line (changes each time it is set). */
  reveal?: { line: number; n: number } | null;
}

export function DiffView({ path, original, modified, readOnly, onEdit, reveal }: DiffViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const models = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  const quiet = useRef(false);
  const edit = useRef(onEdit);
  edit.current = onEdit;

  useEffect(() => {
    const ed = monaco.editor.createDiffEditor(host.current!, {
      ...OPTIONS,
      originalEditable: false,
      readOnly,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: false,
    });
    editor.current = ed;
    return () => {
      ed.setModel(null);
      ed.dispose();
      models.current?.original.dispose();
      models.current?.modified.dispose();
      models.current = null;
      editor.current = null;
    };
    // Created once; options and text follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New models per file.
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    const lang = languageFor(path);
    const o = monaco.editor.createModel(original, lang);
    const m = monaco.editor.createModel(modified, lang);
    const sub = m.onDidChangeContent(() => {
      if (!quiet.current) edit.current?.(m.getValue());
    });
    const old = models.current;
    models.current = { original: o, modified: m };
    ed.setModel({ original: o, modified: m });
    old?.original.dispose();
    old?.modified.dispose();
    return () => sub.dispose();
    // Text changes for the same file are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useSyncedModel(models.current?.original ?? null, original, quiet);
  useSyncedModel(models.current?.modified ?? null, modified, quiet);

  useEffect(() => {
    editor.current?.getModifiedEditor().updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    if (reveal) editor.current?.getModifiedEditor().revealLineInCenter(reveal.line);
  }, [reveal]);

  return <div ref={host} className="h-full min-h-0 w-full" />;
}

/** An editor for the merged text of a conflict (with its markers). */
export function MergeEditor({ path, text, onEdit }: { path: string; text: string; onEdit: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const model = useRef<monaco.editor.ITextModel | null>(null);
  const quiet = useRef(false);
  const edit = useRef(onEdit);
  edit.current = onEdit;

  useEffect(() => {
    const m = monaco.editor.createModel(text, languageFor(path));
    model.current = m;
    const ed = monaco.editor.create(host.current!, { ...OPTIONS, model: m });
    const sub = m.onDidChangeContent(() => {
      if (!quiet.current) edit.current(m.getValue());
    });
    // Put the cursor on the first conflict.
    const first = m.findNextMatch("<<<<<<<", { lineNumber: 1, column: 1 }, false, true, null, false);
    if (first) {
      ed.revealLineInCenter(first.range.startLineNumber);
      ed.setPosition(first.range.getStartPosition());
    }
    return () => {
      sub.dispose();
      ed.dispose();
      m.dispose();
      model.current = null;
    };
    // One editor per file; text changes from outside are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useSyncedModel(model.current, text, quiet);

  return <div ref={host} className="h-full min-h-0 w-full" />;
}
