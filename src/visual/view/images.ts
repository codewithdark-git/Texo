// Finds and loads the images figures point at, the way LaTeX would look for
// them: next to the main document, next to this file, then \graphicspath,
// trying the usual extensions. PDFs show their first page.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "../../lib/api";
import { useWorkspace } from "../../workspace/store";
import { parentDir } from "../../workspace/paths";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const EXTS = ["", ".png", ".jpg", ".jpeg", ".pdf", ".eps"];
export const IMAGE_FILE = /\.(png|jpe?g|pdf|eps|svg)$/i;

/** Joins and normalises a project-relative path ("a/b/../c" → "a/c"). */
function join(dir: string, rel: string): string {
  const parts = (dir ? dir + "/" + rel : rel).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** The project file a figure path refers to, or null. */
export function resolveImage(path: string, fromFile: string, graphicsPaths: string[]): string | null {
  const ws = useWorkspace.getState();
  const files = new Set(ws.files.filter((f) => !f.isDir).map((f) => f.path));
  const main = ws.project?.mainDocument;
  const dirs = [main ? parentDir(main) : "", parentDir(fromFile)];
  const base = [...dirs];
  for (const g of graphicsPaths) for (const d of base) dirs.push(join(d, g));
  const clean = path.trim().replace(/^\.\//, "");
  for (const d of dirs) {
    for (const ext of EXTS) {
      const candidate = join(d, clean + ext);
      if (files.has(candidate)) return candidate;
    }
  }
  return null;
}

const MAX = 64;
const cache = new Map<string, Promise<string | null>>();

/** A data URL to show for a project image, or null for a placeholder. */
export function loadImage(file: string): Promise<string | null> {
  const hit = cache.get(file);
  if (hit) {
    cache.delete(file);
    cache.set(file, hit);
    return hit;
  }
  const job = load(file).catch(() => null);
  cache.set(file, job);
  if (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  return job;
}

/** Forget a file's image, after it changes on disk. */
export function forgetImage(file: string) {
  cache.delete(file);
}

async function load(file: string): Promise<string | null> {
  const project = useWorkspace.getState().project?.path;
  if (!project) return null;
  if (/\.eps$/i.test(file)) return null;
  if (/\.pdf$/i.test(file)) {
    const data = await api.readAsset(project, file);
    return renderPdfPage(new Uint8Array(data));
  }
  const content = await api.readFile(project, file);
  return content.kind === "image" ? content.dataUrl : null;
}

async function renderPdfPage(data: Uint8Array): Promise<string | null> {
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, 600 / Math.max(1, base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    void task.destroy();
  }
}
