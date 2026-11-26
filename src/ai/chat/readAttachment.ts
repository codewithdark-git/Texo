// Turns an attached file into what the chat sends: pictures downscaled and
// re-encoded as JPEG in a canvas, PDFs as text (first pages, via pdfjs-dist),
// text files as text. Anything else is refused with a plain message. The
// decisions are in ./attachments.ts (pure, unit-tested).

import { invoke } from "@tauri-apps/api/core";
import {
  capText,
  classifyAttachment,
  dataUrlBytes,
  firstJpegAttempt,
  formatBytes,
  looksLikeText,
  MAX_FILE_BYTES,
  MAX_PDF_PAGES,
  nextJpegAttempt,
  type JpegAttempt,
} from "./attachments";

export interface ReadyAttachment {
  name: string;
  mime: string;
  kind: "image" | "text";
  /** Pictures: a JPEG data URL. */
  dataUrl?: string;
  /** Text files and PDFs. */
  text?: string;
  /** Plain words for the preview, e.g. "Text of 40 of 120 pages". */
  note: string;
}

export class AttachmentError extends Error {}

/** Reads a file picked with the attach button, pasted or dropped inside the page. */
export async function readFileObject(file: File): Promise<ReadyAttachment> {
  if (file.size > MAX_FILE_BYTES) throw new AttachmentError(`“${file.name}” is too large to attach (over 40 MB).`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return readBytes(file.name || "pasted", file.type, bytes);
}

/** Reads a file dropped from the file manager (Tauri gives its path; Rust only serves paths really dropped). */
export async function readDroppedPath(path: string): Promise<ReadyAttachment> {
  const name = path.split(/[\\/]/).pop() || "file";
  let buf: ArrayBuffer;
  try {
    buf = await invoke<ArrayBuffer>("ai_chat_read_dropped", { path });
  } catch (err) {
    const message = typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : String(err);
    throw new AttachmentError(message || `Texo couldn't read “${name}”.`);
  }
  return readBytes(name, "", new Uint8Array(buf));
}

export async function readBytes(name: string, mime: string, bytes: Uint8Array): Promise<ReadyAttachment> {
  let kind = classifyAttachment(name, mime);
  if (kind === "unknown") kind = looksLikeText(bytes) ? "text" : "unknown";
  switch (kind) {
    case "image":
      return downscaleImage(name, mime, bytes);
    case "pdf":
      return pdfText(name, bytes);
    case "text": {
      const raw = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
      const { text, truncated } = capText(raw);
      return { name, mime: mime || "text/plain", kind: "text", text, note: truncated ? "Long file: only the start is sent" : formatBytes(bytes.length) };
    }
    default:
      throw new AttachmentError(`Texo can't read “${name}”. Attach text files (.tex, .bib, .txt, .md, .csv), PDFs or pictures.`);
  }
}

async function downscaleImage(name: string, mime: string, bytes: Uint8Array): Promise<ReadyAttachment> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime || "image/png" }));
  } catch {
    throw new AttachmentError(`“${name}” couldn't be opened as a picture.`);
  }
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new AttachmentError("Texo couldn't prepare the picture. Try again.");
    let attempt: JpegAttempt | null = firstJpegAttempt(bitmap.width, bitmap.height);
    let dataUrl = "";
    let size = 0;
    while (attempt) {
      const scale = attempt.side / Math.max(bitmap.width, bitmap.height);
      const s = Math.min(1, scale);
      canvas.width = Math.max(1, Math.round(bitmap.width * s));
      canvas.height = Math.max(1, Math.round(bitmap.height * s));
      // JPEG has no transparency: put see-through parts on white.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL("image/jpeg", attempt.quality);
      size = dataUrlBytes(dataUrl);
      const next = nextJpegAttempt(attempt, size);
      if (!next) {
        if (size > 180 * 1024) throw new AttachmentError(`“${name}” is too detailed to send. Try a smaller picture or crop it.`);
        break;
      }
      attempt = next;
    }
    const jpgName = name.replace(/\.(png|gif|webp|bmp|jpe?g)$/i, "") + ".jpg";
    return { name: jpgName, mime: "image/jpeg", kind: "image", dataUrl, note: `${canvas.width}×${canvas.height}, ${formatBytes(size)}` };
  } finally {
    bitmap.close();
  }
}

async function pdfText(name: string, bytes: Uint8Array): Promise<ReadyAttachment> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  let doc;
  try {
    // pdf.js takes ownership of the buffer; give it a copy.
    doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    const locked = err instanceof Error && /password/i.test(err.name + err.message);
    throw new AttachmentError(locked ? `“${name}” is password-protected.` : `“${name}” couldn't be read as a PDF.`);
  }
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const parts: string[] = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      parts.push(`--- Page ${i} ---\n${lines.join("\n").trim()}`);
      page.cleanup();
    }
    const body = parts.join("\n\n");
    if (!body.replace(/--- Page \d+ ---/g, "").trim()) {
      throw new AttachmentError(`“${name}” has no text Texo can read (it may be a scan). Attach a picture of the page instead.`);
    }
    const { text, truncated } = capText(body);
    const note =
      doc.numPages > pages
        ? `Text of the first ${pages} of ${doc.numPages} pages`
        : `Text of ${pages} page${pages === 1 ? "" : "s"}${truncated ? " (start only)" : ""}`;
    return { name, mime: "application/pdf", kind: "text", text, note };
  } finally {
    void doc.loadingTask.destroy();
  }
}
