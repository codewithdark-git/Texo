import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  ChevronUp,
  Crosshair,
  ExternalLink,
  FileText,
  Loader2,
  Minus,
  Moon,
  Plus,
  Search,
  Sun,
  X,
} from "lucide-react";
import { api, errorText } from "../lib/api";
import { useCompile } from "./compileStore";
import { revealSource } from "./EditorPane";
import { useWorkspace } from "./store";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const PREFS_KEY = "texo.pdf";
const ZOOMS: [string, string][] = [
  ["page-width", "Fit width"],
  ["page-fit", "Fit page"],
  ["0.5", "50%"],
  ["0.75", "75%"],
  ["1", "100%"],
  ["1.25", "125%"],
  ["1.5", "150%"],
  ["2", "200%"],
  ["3", "300%"],
];
const THUMB_WIDTH = 240;

interface Prefs {
  dark: boolean;
  scale: string;
}

function loadPrefs(): Prefs {
  try {
    return { dark: false, scale: "page-width", ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return { dark: false, scale: "page-width" };
  }
}

function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Remembered for this session only.
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Lets the editor ask the viewer to show a position (forward SyncTeX). */
export const pdfBridge: { show: ((page: number, rects: Rect[]) => void) | null } = { show: null };

/** Jumps from a source line to the matching place in the PDF. */
export async function syncToPdf(file: string, line: number): Promise<boolean> {
  const project = useWorkspace.getState().project?.path;
  if (!project || !pdfBridge.show) return false;
  const hit = await invoke<{ page: number; rects: Rect[] } | null>("synctex_forward", { path: project, file, line });
  if (!hit) return false;
  pdfBridge.show(hit.page, hit.rects);
  return true;
}

export function PdfViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfViewer = useRef<PDFViewer | null>(null);
  const eventBus = useRef<EventBus | null>(null);
  const doc = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const loadId = useRef(0);
  const findInput = useRef<HTMLInputElement>(null);

  const result = useCompile((s) => s.result);
  const project = useWorkspace((s) => s.project?.path);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState(prefs.scale);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const updatePrefs = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });

  // Create the pdf.js viewer once.
  useEffect(() => {
    const bus = new EventBus();
    const linkService = new PDFLinkService({ eventBus: bus });
    const findController = new PDFFindController({ eventBus: bus, linkService });
    const viewer = new PDFViewer({
      container: containerRef.current!,
      viewer: viewerRef.current!,
      eventBus: bus,
      linkService,
      findController,
      removePageBorders: false,
    });
    linkService.setViewer(viewer);
    pdfViewer.current = viewer;
    eventBus.current = bus;

    bus.on("pagechanging", (e: { pageNumber: number }) => setPage(e.pageNumber));
    bus.on("scalechanging", (e: { presetValue?: string; scale: number }) => setScale(e.presetValue ?? String(e.scale)));
    bus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount));
    bus.on("updatefindcontrolstate", (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount));

    pdfBridge.show = (pageNumber, rects) => showLocation(viewer, pageNumber, rects);
    return () => {
      pdfBridge.show = null;
      void doc.current?.loadingTask.destroy();
      doc.current = null;
    };
  }, []);

  // Load the PDF after every compile that produced one, keeping the view.
  useEffect(() => {
    const viewer = pdfViewer.current;
    const container = containerRef.current;
    const pdfPath = result?.pdfPath;
    if (!viewer || !container || !project || !pdfPath) return;
    const id = ++loadId.current;
    const keep = doc.current
      ? { scale: viewer.currentScaleValue, top: container.scrollTop, left: container.scrollLeft }
      : { scale: prefs.scale, top: 0, left: 0 };

    setLoading(true);
    (async () => {
      try {
        const bytes = await invoke<ArrayBuffer>("read_pdf", { path: project, pdf: pdfPath });
        const next = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
        if (id !== loadId.current) {
          void next.loadingTask.destroy();
          return;
        }
        const previous = doc.current;
        const restore = () => {
          viewer.currentScaleValue = keep.scale;
          container.scrollTop = keep.top;
          container.scrollLeft = keep.left;
        };
        eventBus.current!.on("pagesinit", restore, { once: true });
        viewer.setDocument(next);
        (viewer as unknown as { linkService: PDFLinkService }).linkService.setDocument(next);
        doc.current = next;
        setPages(next.numPages);
        setError(null);
        void previous?.loadingTask.destroy();
        if (result.status === "success") void saveThumbnail(project, next);
      } catch (err) {
        if (id === loadId.current) setError(errorText(err));
      } finally {
        if (id === loadId.current) setLoading(false);
      }
    })();
    // A new result object means a new compile, even if the path is the same.
  }, [result, project]);

  // Run the search as the query changes.
  useEffect(() => {
    if (!findOpen) return;
    eventBus.current?.dispatch("find", {
      source: null,
      type: "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: false,
    });
    if (!query) setMatches(null);
  }, [query, findOpen]);

  const findAgain = (previous: boolean) =>
    eventBus.current?.dispatch("find", {
      source: null,
      type: "again",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });

  const closeFind = () => {
    setFindOpen(false);
    setQuery("");
    eventBus.current?.dispatch("findbarclose", { source: null });
  };

  const setZoom = (value: string) => {
    if (!pdfViewer.current) return;
    pdfViewer.current.currentScaleValue = value;
    updatePrefs({ scale: value });
  };

  const zoomBy = (steps: number) => {
    const viewer = pdfViewer.current;
    if (!viewer) return;
    if (steps > 0) viewer.increaseScale({ steps });
    else viewer.decreaseScale({ steps: -steps });
  };

  // Double-click a spot in the PDF to jump to its source line (inverse SyncTeX).
  const onDoubleClick = async (e: React.MouseEvent) => {
    const viewer = pdfViewer.current;
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".page");
    if (!viewer || !pageEl || !project) return;
    const pageNumber = Number(pageEl.dataset.pageNumber);
    const view = viewer.getPageView(pageNumber - 1);
    const box = view.div.getBoundingClientRect();
    const [px, py] = view.viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
    const [left, , , top] = view.viewport.viewBox;
    try {
      const hit = await invoke<{ file: string; line: number } | null>("synctex_inverse", {
        path: project,
        page: pageNumber,
        x: px - left,
        y: top - py,
      });
      if (hit) await revealSource(hit.file, hit.line);
      else flash("No source position found here. Compile again if the PDF is out of date.");
    } catch (err) {
      flash(errorText(err));
    }
  };

  const syncCursor = async () => {
    const ws = useWorkspace.getState();
    if (!ws.active || !ws.cursor) return flash("Put the cursor in a .tex file first.");
    try {
      if (!(await syncToPdf(ws.active, ws.cursor.line))) flash("That line has no position in the PDF.");
    } catch (err) {
      flash(errorText(err));
    }
  };

  const flash = (text: string) => {
    setHint(text);
    setTimeout(() => setHint((h) => (h === text ? null : h)), 3500);
  };

  // External links open in the browser; the app window never navigates away.
  const onClickCapture = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    const href = link.getAttribute("href") ?? "";
    if (/^(https?|mailto):/i.test(href)) {
      e.preventDefault();
      e.stopPropagation();
      void openUrl(href);
    }
  };

  const hasPdf = !!result?.pdfPath;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setFindOpen(true);
          setTimeout(() => findInput.current?.select(), 0);
        }
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-[13px] text-muted">
        <input
          aria-label="Page number"
          value={page}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n >= 1 && n <= pages && pdfViewer.current) pdfViewer.current.currentPageNumber = n;
          }}
          className="h-6 w-10 rounded border border-border bg-bg text-center text-text outline-none focus:border-accent"
        />
        <span className="pr-1">/ {pages || "–"}</span>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton label="Zoom out" onClick={() => zoomBy(-1)} icon={<Minus size={14} />} />
        <select
          aria-label="Zoom"
          value={ZOOMS.some(([v]) => v === scale) ? scale : "custom"}
          onChange={(e) => setZoom(e.target.value)}
          className="h-6 rounded border border-border bg-bg px-1 text-text outline-none"
        >
          {!ZOOMS.some(([v]) => v === scale) && <option value="custom">{Math.round(Number(scale) * 100)}%</option>}
          {ZOOMS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <ToolButton label="Zoom in" onClick={() => zoomBy(1)} icon={<Plus size={14} />} />
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton
          label="Show the cursor's position in the PDF (Ctrl+Alt+J)"
          onClick={() => void syncCursor()}
          icon={<Crosshair size={14} />}
        />
        <ToolButton
          label="Find in PDF (Ctrl+F)"
          onClick={() => {
            setFindOpen((o) => !o);
            setTimeout(() => findInput.current?.focus(), 0);
          }}
          icon={<Search size={14} />}
        />
        <ToolButton
          label={prefs.dark ? "Show the PDF in light colours" : "Show the PDF in dark colours"}
          onClick={() => updatePrefs({ dark: !prefs.dark })}
          icon={prefs.dark ? <Sun size={14} /> : <Moon size={14} />}
        />
        {result?.pdfPath && (
          <ToolButton
            label="Open in your PDF app"
            onClick={() => void openPath(result.pdfPath!)}
            icon={<ExternalLink size={14} />}
          />
        )}
        {loading && <Loader2 size={13} className="ml-auto animate-spin" />}
      </div>

      {findOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          <input
            ref={findInput}
            autoFocus
            value={query}
            placeholder="Find in PDF"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") findAgain(e.shiftKey);
              if (e.key === "Escape") closeFind();
            }}
            className="h-6 flex-1 rounded border border-border bg-bg px-2 text-[13px] outline-none focus:border-accent"
          />
          <span className="w-16 text-center text-xs text-muted">
            {query ? (matches?.total ? `${matches.current} of ${matches.total}` : "No results") : ""}
          </span>
          <ToolButton label="Previous match" onClick={() => findAgain(true)} icon={<ChevronUp size={14} />} />
          <ToolButton label="Next match" onClick={() => findAgain(false)} icon={<ChevronDown size={14} />} />
          <ToolButton label="Close find" onClick={closeFind} icon={<X size={14} />} />
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-surface-2/60">
        <div
          ref={containerRef}
          onDoubleClick={(e) => void onDoubleClick(e)}
          onClickCapture={onClickCapture}
          onWheel={(e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? 1 : -1);
          }}
          tabIndex={0}
          className={`texo-pdf absolute inset-0 overflow-auto outline-none ${prefs.dark ? "texo-pdf-dark" : ""}`}
        >
          <div ref={viewerRef} className="pdfViewer" />
        </div>
        {!hasPdf && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-muted">
            <FileText size={30} className="text-accent" />
            <p className="max-w-xs text-sm">
              {useCompile.getState().compiling ? "Compiling…" : "The PDF appears here after a successful compile."}
            </p>
          </div>
        )}
        {error && (
          <p className="absolute inset-x-3 top-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            Couldn't show the PDF: {error}
          </p>
        )}
        {hint && (
          <p className="absolute inset-x-3 bottom-3 rounded-lg border border-border bg-surface px-3 py-2 text-center text-sm shadow-lg">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

function ToolButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
    >
      {icon}
    </button>
  );
}

/** Scrolls to a SyncTeX position and briefly highlights it. */
function showLocation(viewer: PDFViewer, pageNumber: number, rects: Rect[]) {
  const view = viewer.getPageView(pageNumber - 1);
  if (!view) return;
  const [left, , , top] = view.viewport.viewBox;
  const first = rects[0];
  viewer.scrollPageIntoView({
    pageNumber,
    // XYZ destinations use PDF coordinates (origin bottom-left); leave a margin above.
    destArray: [null, { name: "XYZ" }, left + Math.max(0, first.x - 20), top - first.y + 60, null],
    allowNegativeOffset: true,
  });
  for (const r of rects) {
    // Two corners in PDF space (origin bottom-left) to CSS pixels on the page.
    const [x1, y1] = view.viewport.convertToViewportPoint(left + r.x, top - r.y);
    const [x2, y2] = view.viewport.convertToViewportPoint(left + r.x + r.width, top - r.y - r.height);
    const mark = document.createElement("div");
    mark.className = "texo-sync-mark";
    Object.assign(mark.style, {
      left: `${Math.min(x1, x2)}px`,
      top: `${Math.min(y1, y2)}px`,
      width: `${Math.abs(x2 - x1)}px`,
      height: `${Math.abs(y2 - y1)}px`,
    });
    view.div.appendChild(mark);
    setTimeout(() => mark.remove(), 2200);
  }
}

/** Renders page 1 small and stores it as the project's dashboard thumbnail. */
async function saveThumbnail(project: string, doc: pdfjs.PDFDocumentProxy) {
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: THUMB_WIDTH / page.view[2] });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    await api.saveThumbnail(project, canvas.toDataURL("image/png"));
  } catch {
    // A missing thumbnail only affects the dashboard grid.
  }
}
