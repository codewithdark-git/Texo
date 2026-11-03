import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Columns2, FileCode2, FileText, ListTree, Files, X } from "lucide-react";
import { SHOW_PDF_EVENT, type ProjectSummary } from "../lib/api";
import { useApp } from "../store";
import { Button } from "../components/Dialog";
import { AppMenu } from "../components/AppMenu";
import { countWords } from "../lib/wordcount";
import { formatRelative } from "../lib/projects";
import { useUi } from "../ui";
import { useCompile } from "./compileStore";
import { baseName } from "./paths";
import { QuickOpen } from "./QuickOpen";
import { zoomEditor } from "./EditorPane";
import { getModel } from "./store";
import { CompileControls } from "./CompileControls";
import { CompilePanel } from "./CompilePanel";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";
import { Outline } from "./Outline";
import { TabBar } from "./TabBar";
import { useWorkspace } from "./store";

type Layout = "split" | "code" | "pdf";
type Panel = "files" | "outline";

const LAYOUT_KEY = "texo.layout";

interface LayoutPrefs {
  layout: Layout;
  sidebar: number;
  split: number;
}

function loadLayout(): LayoutPrefs {
  const fallback: LayoutPrefs = { layout: "split", sidebar: 240, split: 0.55 };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
}

/** Starts a drag that reports the pointer's x position until release. */
function startDrag(e: ReactPointerEvent, onMove: (x: number) => void, onEnd: () => void) {
  e.preventDefault();
  const move = (ev: PointerEvent) => onMove(ev.clientX);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
    onEnd();
  };
  document.body.style.cursor = "col-resize";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function Workspace({ project }: { project: ProjectSummary }) {
  const ws = useWorkspace();
  const dialog = useUi((s) => s.dialog);
  const [prefs, setPrefs] = useState(loadLayout);
  const [panel, setPanel] = useState<Panel>("files");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  const updatePrefs = (patch: Partial<LayoutPrefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {
        // Layout is remembered per session only.
      }
      return next;
    });

  const close = async () => {
    useCompile.getState().reset();
    await useWorkspace.getState().teardown();
    void useApp.getState().refresh().catch(() => {});
    useApp.getState().open(null);
  };

  useEffect(() => {
    void useWorkspace
      .getState()
      .init(project)
      .then(() => useCompile.getState().init());
    return () => {
      useCompile.getState().reset();
      void useWorkspace.getState().teardown();
    };
  }, [project.path]);

  // Showing the PDF needs the preview pane visible.
  useEffect(() => {
    const show = () => setPrefs((p) => (p.layout === "code" ? { ...p, layout: "split" } : p));
    window.addEventListener(SHOW_PDF_EVENT, show);
    return () => window.removeEventListener(SHOW_PDF_EVENT, show);
  }, []);

  // Window title: the open file and project.
  const active = ws.active;
  const projectName = ws.project?.name ?? project.name;
  useEffect(() => {
    const title = active ? `${baseName(active)} — ${projectName} — Texo` : `${projectName} — Texo`;
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [active, projectName]);

  // Workspace shortcuts. Monaco keeps the keys it uses itself (Ctrl+F, …);
  // these reach the window from the editor and everywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const state = useWorkspace.getState();
      const key = e.key.toLowerCase();
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (key === "enter") {
        handled();
        void useCompile.getState().compile();
      } else if (key === "p" && !e.shiftKey) {
        handled();
        useUi.getState().openDialog("quickOpen");
      } else if (key === "w" && !e.shiftKey) {
        handled();
        if (state.active) void state.closeTab(state.active);
      } else if (key === "tab" && state.tabs.length > 1) {
        handled();
        const i = state.active ? state.tabs.indexOf(state.active) : -1;
        const next = (i + (e.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length;
        void state.openFile(state.tabs[next]);
      } else if ((key === "=" || key === "+") && !e.shiftKey) {
        handled();
        zoomEditor(1);
      } else if (key === "-" && !e.shiftKey) {
        handled();
        zoomEditor(-1);
      } else if (key === "0" && !e.shiftKey) {
        handled();
        zoomEditor(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Save everything before the window closes.
  useEffect(() => {
    const pending = getCurrentWindow().onCloseRequested(async () => {
      await useWorkspace.getState().saveAll();
    });
    return () => void pending.then((off) => off());
  }, []);

  // Dropping files from File Explorer copies them into the folder under the pointer.
  useEffect(() => {
    const folderAt = (x: number, y: number): string | null => {
      const ratio = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(x / ratio, y / ratio);
      const target = el?.closest<HTMLElement>("[data-drop-dir]");
      return target ? (target.dataset.dropDir ?? "") : null;
    };
    const pending = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "over") setDropTarget(folderAt(p.position.x, p.position.y));
      else if (p.type === "leave") setDropTarget(null);
      else if (p.type === "drop") {
        setDropTarget(null);
        const dest = folderAt(p.position.x, p.position.y) ?? "";
        void useWorkspace.getState().importFiles(dest, p.paths);
      }
    });
    return () => void pending.then((off) => off());
  }, []);

  const showCode = prefs.layout !== "pdf";
  const showPdf = prefs.layout !== "code";
  const name = ws.project?.name ?? project.name;

  return (
    <div className="flex h-full flex-col">
      {dialog === "quickOpen" && <QuickOpen onClose={() => useUi.getState().openDialog(null)} />}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" onClick={() => void close()} aria-label="Back to projects">
          <ArrowLeft size={16} />
        </Button>
        <h1 className="truncate font-semibold">{name}</h1>
        <button
          type="button"
          onClick={() => useUi.getState().openDialog("quickOpen")}
          title="Quick Open (Ctrl+P)"
          className="ml-4 hidden h-8 max-w-64 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-left text-[13px] text-muted hover:border-accent/50 md:flex"
        >
          <span className="flex-1 truncate">Go to file…</span>
          <kbd className="font-mono text-[11px]">Ctrl+P</kbd>
        </button>
        <div className="ml-auto">
          <CompileControls />
        </div>
        <div className="flex rounded-lg border border-border bg-surface p-0.5">
          {(
            [
              ["code", "Code only", FileCode2],
              ["split", "Code and PDF", Columns2],
              ["pdf", "PDF only", FileText],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={prefs.layout === value}
              onClick={() => updatePrefs({ layout: value })}
              className={`rounded-md p-1.5 ${prefs.layout === value ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}
            >
              <Icon size={15} />
            </button>
          ))}
        </div>
        <AppMenu />
      </header>

      {ws.error && (
        <div role="alert" className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm">
          <span className="flex-1">{ws.error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => ws.setError(null)} className="text-muted hover:text-text">
            <X size={15} />
          </button>
        </div>
      )}

      <div ref={body} className="flex min-h-0 flex-1">
        <aside style={{ width: prefs.sidebar }} className="flex shrink-0 flex-col border-r border-border bg-surface/60">
          <div className="flex gap-1 border-b border-border p-1.5">
            {(
              [
                ["files", "Files", Files],
                ["outline", "Outline", ListTree],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={panel === value}
                onClick={() => setPanel(value)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-xs ${
                  panel === value ? "bg-surface-2 text-text" : "text-muted hover:text-text"
                }`}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          {panel === "files" ? <FileTree dropTarget={dropTarget} /> : <Outline />}
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={(e) =>
            startDrag(
              e,
              (x) => {
                const left = body.current?.getBoundingClientRect().left ?? 0;
                setPrefs((p) => ({ ...p, sidebar: Math.min(480, Math.max(180, x - left)) }));
              },
              () => updatePrefs({}),
            )
          }
          className="w-1 shrink-0 cursor-col-resize hover:bg-accent/40"
        />

        <div className="flex min-w-0 flex-1">
          {showCode && (
            <section style={{ flex: showPdf ? prefs.split : 1 }} className="flex min-w-0 flex-col">
              <TabBar />
              <EditorPane />
              <StatusBar />
            </section>
          )}
          {showCode && showPdf && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize editor and preview"
              onPointerDown={(e) => {
                const host = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                startDrag(
                  e,
                  (x) => setPrefs((p) => ({ ...p, split: Math.min(0.8, Math.max(0.2, (x - host.left) / host.width)) })),
                  () => updatePrefs({}),
                );
              }}
              className="w-1 shrink-0 cursor-col-resize border-l border-border hover:bg-accent/40"
            />
          )}
          {showPdf && (
            <section style={{ flex: showCode ? 1 - prefs.split : 1 }} className="flex min-w-0 flex-col bg-surface-2/40">
              <CompilePanel />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Words in the open .tex file, recounted shortly after edits. */
function useWordCount(active: string | null): number | null {
  const [count, setCount] = useState<number | null>(null);
  const isText = useWorkspace((s) => (s.active ? s.views[s.active]?.kind === "text" : false));
  useEffect(() => {
    const model = active?.endsWith(".tex") && isText ? getModel(active) : undefined;
    if (!model) {
      setCount(null);
      return;
    }
    setCount(countWords(model.getValue()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setCount(countWords(model.getValue())), 400);
    });
    return () => {
      clearTimeout(timer);
      sub.dispose();
    };
  }, [active, isText]);
  return count;
}

/** "Compiled 2 min ago", refreshed every half minute. */
function useCompiledAgo(): string | null {
  const finishedAt = useCompile((s) => s.finishedAt);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  return finishedAt ? formatRelative(new Date(finishedAt).toISOString()) : null;
}

function StatusBar() {
  const { cursor, saving, status, active, project } = useWorkspace();
  const words = useWordCount(active);
  const compiledAgo = useCompiledAgo();
  const compiling = useCompile((s) => s.compiling);
  const unsaved = Object.values(status).some((s) => s.dirty);
  const conflict = active ? status[active]?.conflict : false;
  const lang = active?.match(/\.(tex|bib|sty|cls)$/i)?.[1].toLowerCase();
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-surface/60 px-3 text-[11px] text-muted">
      <span>{conflict ? "Changed on disk" : saving > 0 ? "Saving…" : unsaved ? "Unsaved changes" : "All changes saved"}</span>
      {project?.mainDocument && <span>Main: {project.mainDocument}</span>}
      {compiling ? <span>Compiling…</span> : compiledAgo && <span title="Last compile">Compiled {compiledAgo}</span>}
      <span className="ml-auto">{lang === "bib" ? "BibTeX" : lang ? "LaTeX" : active ? "Plain text" : ""}</span>
      {words !== null && <span title="Words in this file's text">{words.toLocaleString()} words</span>}
      {cursor && (
        <span>
          Ln {cursor.line}, Col {cursor.column}
        </span>
      )}
    </div>
  );
}
