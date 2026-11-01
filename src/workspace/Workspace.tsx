import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Columns2, FileCode2, FileText, ListTree, Files, X } from "lucide-react";
import { SHOW_PDF_EVENT, type ProjectSummary } from "../lib/api";
import { useApp } from "../store";
import { Button } from "../components/Dialog";
import { useCompile } from "./compileStore";
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

  // Ctrl+Enter compiles from anywhere (the editor handles it itself too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter" && !e.defaultPrevented) {
        e.preventDefault();
        void useCompile.getState().compile();
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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" onClick={() => void close()} aria-label="Back to projects">
          <ArrowLeft size={16} />
        </Button>
        <h1 className="truncate font-semibold">{name}</h1>
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

function StatusBar() {
  const { cursor, saving, status, active, project } = useWorkspace();
  const unsaved = Object.values(status).some((s) => s.dirty);
  const conflict = active ? status[active]?.conflict : false;
  const lang = active?.match(/\.(tex|bib|sty|cls)$/i)?.[1].toLowerCase();
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-surface/60 px-3 text-[11px] text-muted">
      <span>{conflict ? "Changed on disk" : saving > 0 ? "Saving…" : unsaved ? "Unsaved changes" : "All changes saved"}</span>
      {project?.mainDocument && <span>Main: {project.mainDocument}</span>}
      <span className="ml-auto">{lang === "bib" ? "BibTeX" : lang ? "LaTeX" : active ? "Plain text" : ""}</span>
      {cursor && (
        <span>
          Ln {cursor.line}, Col {cursor.column}
        </span>
      )}
    </div>
  );
}
