import { useEffect, useRef } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, FileQuestion, FolderOpen, Loader2 } from "lucide-react";
import { monaco } from "../editor/monaco";
import { Button } from "../components/Dialog";
import { useCompile } from "./compileStore";
import { syncToPdf } from "./PdfViewer";
import { nativePath } from "./paths";
import { getModel, savedCursor, useWorkspace } from "./store";

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
const DEFAULT_FONT_SIZE = 14;

interface EditorPrefs {
  wordWrap: boolean;
  fontSize: number;
}

function loadPrefs(): EditorPrefs {
  try {
    return { wordWrap: true, fontSize: DEFAULT_FONT_SIZE, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return { wordWrap: true, fontSize: DEFAULT_FONT_SIZE };
  }
}

function savePrefs(patch: Partial<EditorPrefs>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    // Not important enough to report.
  }
}

/** Ctrl+= / Ctrl+- / Ctrl+0: change the editor's font size, and remember it. */
export function zoomEditor(step: 1 | -1 | 0) {
  const ed = editorBridge.editor;
  if (!ed) return;
  const current = ed.getOption(monaco.editor.EditorOption.fontSize);
  const fontSize = step === 0 ? DEFAULT_FONT_SIZE : Math.min(32, Math.max(9, current + step));
  ed.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.6) });
  savePrefs({ fontSize });
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
      fontSize: loadPrefs().fontSize,
      lineHeight: Math.round(loadPrefs().fontSize * 1.6),
      wordWrap: loadPrefs().wordWrap ? "on" : "off",
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
        savePrefs({ wordWrap: on });
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
      const remembered = savedCursor(active);
      if (state) editor.restoreViewState(state);
      else if (remembered) {
        // First time this session: go back to where the cursor was last time.
        editor.setPosition({ lineNumber: remembered.line, column: remembered.column });
        editor.revealPositionInCenterIfOutsideViewport({ lineNumber: remembered.line, column: remembered.column });
      }
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
          {!active && <EmptyEditor />}
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

/** Shown when no file is open: the quickest ways to get going. */
function EmptyEditor() {
  const main = useWorkspace((s) => s.project?.mainDocument);
  const openFile = useWorkspace((s) => s.openFile);
  const row = (keys: string, what: string) => (
    <div className="flex items-center justify-between gap-6">
      <span>{what}</span>
      <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">{keys}</kbd>
    </div>
  );
  return (
    <div className="flex w-full max-w-xs flex-col gap-4">
      <p className="text-sm">No file is open.</p>
      {main && (
        <Button variant="primary" className="self-center" onClick={() => void openFile(main)}>
          Open {main}
        </Button>
      )}
      <div className="space-y-2 text-left text-xs">
        {row("Ctrl+P", "Go to a file")}
        {row("Ctrl+Enter", "Compile")}
        {row("Ctrl+Shift+/", "All shortcuts")}
      </div>
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
