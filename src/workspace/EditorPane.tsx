import { useEffect, useRef } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, FileQuestion, FolderOpen, Loader2 } from "lucide-react";
import { monaco } from "../editor/monaco";
import { Button } from "../components/Dialog";
import { useCompile } from "./compileStore";
import { syncToPdf } from "./PdfViewer";
import { nativePath } from "./paths";
import { getModel, useWorkspace } from "./store";

/** Lets other panels (outline, search) move the editor's cursor. */
export const editorBridge: { editor: monaco.editor.IStandaloneCodeEditor | null } = { editor: null };

/** Opens a project file and moves the cursor to a line. */
export async function revealSource(file: string, line: number) {
  const ws = useWorkspace.getState();
  ws.expandTo(file);
  await ws.openFile(file);
  // Let the editor switch models before moving the cursor.
  setTimeout(() => revealLine(line), 30);
}

export function revealLine(line: number) {
  const ed = editorBridge.editor;
  if (!ed) return;
  ed.revealLineInCenter(line);
  ed.setPosition({ lineNumber: line, column: 1 });
  ed.focus();
}

const PREFS_KEY = "texo.editor";

function loadWrap(): boolean {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}").wordWrap ?? true;
  } catch {
    return true;
  }
}

function saveWrap(wordWrap: boolean) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ wordWrap }));
  } catch {
    // Not important enough to report.
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function EditorPane() {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const shownPath = useRef<string | null>(null);

  const active = useWorkspace((s) => s.active);
  const view = useWorkspace((s) => (s.active ? s.views[s.active] : undefined));
  const conflict = useWorkspace((s) => (s.active ? s.status[s.active]?.conflict : false));
  const project = useWorkspace((s) => s.project);

  useEffect(() => {
    const editor = monaco.editor.create(container.current!, {
      model: null,
      automaticLayout: true,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: 14,
      lineHeight: 22,
      wordWrap: loadWrap() ? "on" : "off",
      minimap: { enabled: false },
      stickyScroll: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      unicodeHighlight: { ambiguousCharacters: true, invisibleCharacters: true },
      quickSuggestions: { other: true, comments: false, strings: true },
      suggest: { showWords: false },
      tabSize: 2,
      padding: { top: 8 },
      smoothScrolling: true,
    });
    editorRef.current = editor;
    editorBridge.editor = editor;

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const path = useWorkspace.getState().active;
      if (path) void useWorkspace.getState().save(path);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void useCompile.getState().compile());
    editor.addAction({
      id: "texo.syncToPdf",
      label: "Show Position in PDF",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyJ],
      contextMenuGroupId: "navigation",
      run: (ed) => {
        const path = useWorkspace.getState().active;
        const pos = ed.getPosition();
        if (path && pos) void syncToPdf(path, pos.lineNumber).catch(() => {});
      },
    });
    editor.addAction({
      id: "texo.toggleWordWrap",
      label: "Toggle Word Wrap",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
      run: (ed) => {
        const on = ed.getOption(monaco.editor.EditorOption.wordWrap) !== "on";
        ed.updateOptions({ wordWrap: on ? "on" : "off" });
        saveWrap(on);
      },
    });
    editor.addAction({
      id: "texo.bold",
      label: "Bold",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
      run: (ed) => wrapSelection(ed, "\\textbf{", "}"),
    });
    editor.addAction({
      id: "texo.italic",
      label: "Italic",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      run: (ed) => wrapSelection(ed, "\\textit{", "}"),
    });
    editor.onDidChangeCursorPosition((e) =>
      useWorkspace.getState().setCursor({ line: e.position.lineNumber, column: e.position.column }),
    );

    return () => {
      editorBridge.editor = null;
      editor.dispose();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (shownPath.current) viewStates.current.set(shownPath.current, editor.saveViewState());
    const model = active && view?.kind === "text" ? getModel(active) : undefined;
    editor.setModel(model ?? null);
    shownPath.current = model ? active : null;
    if (model && active) {
      const state = viewStates.current.get(active);
      if (state) editor.restoreViewState(state);
      editor.focus();
      const pos = editor.getPosition();
      useWorkspace.getState().setCursor(pos ? { line: pos.lineNumber, column: pos.column } : null);
    } else {
      useWorkspace.getState().setCursor(null);
    }
  }, [active, view?.kind]);

  const showEditor = view?.kind === "text";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {showEditor && conflict && active && <ConflictBar path={active} />}
      <div ref={container} className={`min-h-0 flex-1 ${showEditor ? "" : "invisible"}`} />

      {!showEditor && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-auto p-6 text-center text-muted">
          {!active && <p>Select a file in the sidebar, or create a new one.</p>}
          {view?.kind === "loading" && <Loader2 className="animate-spin" />}
          {view?.kind === "image" && (
            <>
              <img
                src={view.dataUrl}
                alt={active ?? ""}
                className="max-h-[75%] max-w-full rounded border border-border bg-white object-contain"
              />
              <p className="text-xs">{formatSize(view.size)}</p>
            </>
          )}
          {(view?.kind === "binary" || view?.kind === "tooLarge") && (
            <>
              <FileQuestion size={32} />
              <p className="font-medium text-text">
                {view.kind === "tooLarge" ? "This file is too large for the editor" : "This file can't be edited here"}
              </p>
              <p className="max-w-sm text-sm">
                {view.kind === "tooLarge"
                  ? `It's ${formatSize(view.size)}; the editor opens text files up to 5 MB.`
                  : "It isn't a text file. It stays in the project and is used when compiling."}
              </p>
              {project && active && (
                <Button onClick={() => void revealItemInDir(nativePath(project.path, active))}>
                  <FolderOpen size={15} /> Show in File Explorer
                </Button>
              )}
            </>
          )}
          {view?.kind === "error" && (
            <>
              <AlertTriangle size={28} className="text-danger" />
              <p className="max-w-sm text-sm">{view.message}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ConflictBar({ path }: { path: string }) {
  const resolve = useWorkspace((s) => s.resolveConflict);
  return (
    <div role="alert" className="flex items-center gap-3 border-b border-border bg-amber-500/10 px-4 py-2 text-sm">
      <AlertTriangle size={15} className="text-amber-400" />
      <span className="flex-1">This file changed on disk while you had unsaved edits.</span>
      <Button onClick={() => void resolve(path, "disk")}>Use disk version</Button>
      <Button variant="primary" onClick={() => void resolve(path, "mine")}>
        Keep mine
      </Button>
    </div>
  );
}

function wrapSelection(ed: monaco.editor.ICodeEditor, before: string, after: string) {
  const model = ed.getModel();
  const selections = ed.getSelections();
  if (!model || !selections) return;
  ed.pushUndoStop();
  ed.executeEdits(
    "texo.wrap",
    selections.map((sel) => ({
      range: sel,
      text: `${before}${model.getValueInRange(sel)}${after}`,
    })),
  );
  // With nothing selected, leave the cursor between the braces.
  if (selections.length === 1 && selections[0].isEmpty()) {
    const p = selections[0].getStartPosition();
    ed.setPosition({ lineNumber: p.lineNumber, column: p.column + before.length });
  }
  ed.pushUndoStop();
}
