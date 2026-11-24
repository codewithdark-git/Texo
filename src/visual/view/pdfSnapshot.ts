// Pictures of the compiled PDF for LaTeX Visual mode can't draw itself (a
// TikZ picture, a custom macro, an unusual environment). SyncTeX says where
// the block's lines landed in the PDF; pdf.js draws that part of the page.
// Snapshots are cached per compile and source text; a new compile makes
// them all stale (subscribers redraw).

import { invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCompile } from "../../workspace/compileStore";
import { getModel, useWorkspace } from "../../workspace/store";

/** A box on a PDF page, in PDF points from the page's top-left corner (as synctex_forward reports). */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ForwardHit {
  page: number;
  rects: PdfRect[];
}

export interface Snapshot {
  url: string;
  /** The region's size in PDF points, so the page can draw it at its own scale. */
  widthPt: number;
  heightPt: number;
}

/** The 1-based line of `offset` in `text`. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The lines a block of source covers: its first and last non-blank line. */
export function lineRange(text: string, start: number, end: number): [number, number] {
  const slice = text.slice(start, end);
  const lead = slice.length - slice.trimStart().length;
  const trail = slice.length - slice.trimEnd().length;
  const a = lineOf(text, start + lead);
  const b = lineOf(text, Math.max(start + lead, end - trail));
  return [a, b];
}

/**
 * The source lines to ask SyncTeX about for a block on lines a..b. A float's
 * `egin{table}` line maps to where the float was called, inside the text
 * before it, so a block of three or more lines uses its inner lines only
 * (at most 40, spread evenly).
 */
export function probeLines(a: number, b: number, max = 40): number[] {
  if (b - a < 2) return a === b ? [a] : [a, b];
  const inner: number[] = [];
  for (let l = a + 1; l < b; l++) inner.push(l);
  if (inner.length <= max) return inner;
  const step = (inner.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => inner[Math.round(i * step)]);
}

/** `hits` without those identical to `echo` (unless that would leave none). */
export function withoutEcho(hits: (ForwardHit | null)[], echo: ForwardHit | null): (ForwardHit | null)[] {
  if (!echo) return hits;
  const same = (h: ForwardHit | null) => !!h && h.page === echo.page && JSON.stringify(h.rects) === JSON.stringify(echo.rects);
  const kept = hits.filter((h) => !same(h));
  return kept.some((h) => h && h.rects.length) ? kept : hits;
}

/**
 * One region from SyncTeX hits for a block's lines: the union of the boxes
 * on the page most hits land on, with a little room around. Null with no boxes.
 */
export function regionFor(hits: (ForwardHit | null)[], pad = 3): { page: number; rect: PdfRect } | null {
  const found = hits.filter((h): h is ForwardHit => !!h && h.rects.length > 0);
  if (!found.length) return null;
  const votes = new Map<number, number>();
  for (const h of found) votes.set(h.page, (votes.get(h.page) ?? 0) + 1);
  const page = [...votes].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
  const first = { page };
  const rects = found.filter((h) => h.page === page).flatMap((h) => h.rects);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return { page: first.page, rect: { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad } };
}

/** The cache key: the compile, the file, the block's source and the compiled lines it maps to. */
export function snapshotKey(finishedAt: number, path: string, src: string, lines = ""): string {
  return `${finishedAt}\u0000${path}\u0000${src}\u0000${lines}`;
}

/**
 * Where `[start, end)` of the current text sits in the text that was
 * compiled, or null when the edits since then touch the block (its lines in
 * the PDF are unknown). The texts are compared by their common start and end:
 * a block wholly before the first change keeps its offsets, one wholly after
 * the last change moves by the change in length.
 */
export function compiledRange(compiled: string, current: string, start: number, end: number): [number, number] | null {
  if (compiled === current) return [start, end];
  const max = Math.min(compiled.length, current.length);
  let prefix = 0;
  while (prefix < max && compiled.charCodeAt(prefix) === current.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && compiled.charCodeAt(compiled.length - 1 - suffix) === current.charCodeAt(current.length - 1 - suffix)) suffix++;
  if (end <= prefix) return [start, end];
  const shift = compiled.length - current.length;
  if (start >= current.length - suffix) return [start + shift, end + shift];
  return null;
}

/** A small LRU map: the oldest entry goes when it is full. */
export class Lru<V> {
  private map = new Map<string, V>();
  constructor(
    private max: number,
    private onEvict?: (v: V) => void,
  ) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const [old, value] = this.map.entries().next().value as [string, V];
      this.map.delete(old);
      this.onEvict?.(value);
    }
  }
  has(k: string) {
    return this.map.has(k);
  }
  clear() {
    for (const v of this.map.values()) this.onEvict?.(v);
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

/* ---------- The PDF and its pages ---------- */

// How sharp snapshots are: device pixels per PDF point.
const RENDER_SCALE = 2.5;

let loaded: { finishedAt: number; doc: Promise<PDFDocumentProxy | null> } | null = null;
const pages = new Lru<HTMLCanvasElement>(4, (c) => {
  // Frees the canvas's memory at once instead of when it is collected.
  c.width = 0;
  c.height = 0;
});
const snaps = new Lru<Snapshot | null>(400);

/* ---------- The text each compile was made from ---------- */

// SyncTeX lines refer to the text as it was compiled; the editor may have
// moved on since. The open files' text is recorded when a compile starts
// (it saves them first, so that is what it compiles) and kept with the
// compile once it finishes.
let pendingTexts: Map<string, string> | null = null;
let compiledTexts: { finishedAt: number; texts: Map<string, string> } | null = null;

function openTexts(): Map<string, string> {
  const texts = new Map<string, string>();
  for (const path of useWorkspace.getState().tabs ?? []) {
    const model = getModel(path);
    if (model) texts.set(path, model.getValue());
  }
  return texts;
}

/** Frees the loaded PDF and every picture: the compile is gone or no longer current. */
function dropAll() {
  const previous = loaded;
  loaded = null;
  pages.clear();
  snaps.clear();
  void previous?.doc.then((d) => d?.loadingTask.destroy()).catch(() => {});
}

/** Wired once, when this module loads. */
function watchStores() {
  useCompile.subscribe((s, prev) => {
    if (s.compiling && !prev.compiling) pendingTexts = openTexts();
    if (s.finishedAt !== prev.finishedAt) {
      // Every cached picture belongs to the old compile now.
      snaps.clear();
      if (s.finishedAt === null) {
        // A reset (project closed or switched): nothing is current any more.
        compiledTexts = null;
        pendingTexts = null;
        dropAll();
      } else {
        compiledTexts = { finishedAt: s.finishedAt, texts: pendingTexts ?? new Map() };
        pendingTexts = null;
      }
    }
  });
  useWorkspace.subscribe((s, prev) => {
    if (s.project?.path !== prev.project?.path) {
      compiledTexts = null;
      pendingTexts = null;
      dropAll();
    }
  });
}
watchStores();

/**
 * The lines a block covered in the compiled text, as "first-last", or null
 * when edits since the compile have moved or changed it (then no picture
 * would be the right one).
 */
export function compiledLines(req: SnapshotRequest, finishedAt: number): [number, number] | null {
  const compiled = compiledTexts?.finishedAt === finishedAt ? compiledTexts.texts.get(req.path) : undefined;
  if (compiled === undefined) {
    // Not recorded: the file was opened after the compile started, so it was
    // compiled as it is on disk. Unsaved edits mean its lines may have moved.
    if (useWorkspace.getState().status?.[req.path]?.dirty) return null;
    return lineRange(req.text, req.start, req.end);
  }
  const range = compiledRange(compiled, req.text, req.start, req.end);
  return range && lineRange(compiled, range[0], range[1]);
}

/** The last successful compile's PDF, loaded once per compile; the previous one is destroyed. */
function currentDoc(): { finishedAt: number; doc: Promise<PDFDocumentProxy | null> } | null {
  const { result, finishedAt } = useCompile.getState();
  const project = useWorkspace.getState().project?.path;
  if (!result?.pdfPath || !finishedAt || !project) {
    // Nothing to show (a reset, or a compile without a PDF): free what was loaded.
    if (loaded) dropAll();
    return null;
  }
  if (loaded?.finishedAt === finishedAt) return loaded;
  const previous = loaded;
  const pdfPath = result.pdfPath;
  loaded = {
    finishedAt,
    doc: (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        // PdfViewer sets the worker when it loads; set it here too in case it hasn't yet.
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
          pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        }
        const bytes = await invoke<ArrayBuffer>("read_pdf", { path: project, pdf: pdfPath });
        return await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      } catch {
        return null;
      }
    })(),
  };
  pages.clear();
  void previous?.doc.then((d) => d?.loadingTask.destroy()).catch(() => {});
  return loaded;
}

async function pageCanvas(doc: PDFDocumentProxy, finishedAt: number, pageNumber: number): Promise<HTMLCanvasElement | null> {
  const key = `${finishedAt}:${pageNumber}`;
  const hit = pages.get(key);
  if (hit) return hit;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    pages.set(key, canvas);
    return canvas;
  } catch {
    return null;
  }
}

// One snapshot at a time: SyncTeX lookups and page renders are not free.
let queue: Promise<unknown> = Promise.resolve();

export interface SnapshotRequest {
  /** Project-relative path of the file the block is in. */
  path: string;
  /** The file's text and the block's [start, end) in it. */
  text: string;
  start: number;
  end: number;
}

/** The cached snapshot for a block, if one was made for the current compile. */
export function cachedSnapshot(req: SnapshotRequest): Snapshot | null | undefined {
  const finishedAt = useCompile.getState().finishedAt;
  if (!finishedAt) return null;
  const lines = compiledLines(req, finishedAt);
  // Edited since the compile in a way that moves this block: no picture fits until the next one.
  if (!lines) return null;
  return snaps.get(snapshotKey(finishedAt, req.path, req.text.slice(req.start, req.end), lines.join("-")));
}

/** A picture of where the block appears in the compiled PDF, or null (no compile, no SyncTeX hit). */
export function snapshot(req: SnapshotRequest): Promise<Snapshot | null> {
  const run = async (): Promise<Snapshot | null> => {
    const current = currentDoc();
    if (!current) return null;
    // SyncTeX knows the compiled text's lines, not the editor's.
    const range = compiledLines(req, current.finishedAt);
    if (!range) return null;
    const key = snapshotKey(current.finishedAt, req.path, req.text.slice(req.start, req.end), range.join("-"));
    const known = snaps.get(key);
    if (known !== undefined) return known;
    const project = useWorkspace.getState().project?.path;
    if (!project) return null;
    const [a, b] = range;
    const lines = probeLines(a, b);
    const forward = (line: number) =>
      invoke<ForwardHit | null>("synctex_forward", { path: project, file: req.path, line }).catch(() => null);
    const hits = await Promise.all(lines.map(forward));
    // Inner lines that print nothing (`\centering`) come back as whatever
    // came before the block, the same answer as its opening line: drop those.
    const opening = lines[0] !== a ? await forward(a) : null;
    const region = regionFor(withoutEcho(hits, opening));
    const doc = region ? await current.doc : null;
    // The compile may have moved on while this ran: don't cache against the old one.
    if (loaded !== current) return null;
    let result: Snapshot | null = null;
    if (region && doc) {
      const page = await pageCanvas(doc, current.finishedAt, region.page);
      if (page) result = crop(page, region.rect);
    }
    snaps.set(key, result);
    return result;
  };
  const job = queue.then(run, run);
  queue = job.catch(() => null);
  return job;
}

function crop(page: HTMLCanvasElement, r: PdfRect): Snapshot | null {
  const sx = Math.max(0, Math.floor(r.x * RENDER_SCALE));
  const sy = Math.max(0, Math.floor(r.y * RENDER_SCALE));
  const sw = Math.min(page.width - sx, Math.ceil(r.width * RENDER_SCALE));
  const sh = Math.min(page.height - sy, Math.ceil(r.height * RENDER_SCALE));
  if (sw <= 2 || sh <= 2) return null;
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(page, sx, sy, sw, sh, 0, 0, sw, sh);
  const url = out.toDataURL("image/png");
  out.width = out.height = 0;
  return { url, widthPt: sw / RENDER_SCALE, heightPt: sh / RENDER_SCALE };
}

/** Runs `fn` after each compile that finishes (snapshots are then out of date). */
export function onCompileFinished(fn: () => void): () => void {
  return useCompile.subscribe((s, prev) => {
    if (s.finishedAt !== prev.finishedAt) fn();
  });
}
