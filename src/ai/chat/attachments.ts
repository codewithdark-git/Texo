// What the chat composer does with an attached file, as pure decisions:
// which kind it is, how far a picture is scaled, which JPEG quality to try
// next, and whether bytes look like text. The canvas and PDF parts that use
// these live in ./readAttachment.ts.

/** Pictures are scaled so their longer side is at most this many pixels. */
export const MAX_IMAGE_SIDE = 1600;
/** And re-encoded as JPEG until they are at most this many bytes. */
export const MAX_IMAGE_BYTES = 180 * 1024;
/** Pictures are never scaled below this longer side; a larger file is refused. */
export const MIN_IMAGE_SIDE = 320;
/** PDFs: text is read from this many pages at most. */
export const MAX_PDF_PAGES = 40;
/** Text kept from one file (the backend sends at most 20k characters of it). */
export const MAX_TEXT_CHARS = 60_000;
/** Files larger than this aren't read at all. */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
/** Same limits as the backend (src-tauri/src/chat/engine.rs). */
export const MAX_ATTACHMENTS = 10;
export const MAX_IMAGES = 6;

export type AttachmentKind = "image" | "pdf" | "text" | "unknown";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const TEXT_EXT =
  /\.(tex|ltx|bib|bst|sty|cls|dtx|ins|txt|md|markdown|csv|tsv|json|ya?ml|toml|xml|svg|html?|log|blg|py|r|m|jl|js|ts|c|h|cpp|hpp|java|rs|go|sh|bat|ps1|ini|cfg|conf|rtf|dat|out|tikz|pgf|gp|plt|org|rst|adoc)$/i;

/** Decides from the name and type the browser gave; "unknown" files are sniffed. */
export function classifyAttachment(name: string, mime: string): AttachmentKind {
  const m = mime.toLowerCase();
  if (m === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/^image\/(png|jpe?g|gif|webp|bmp)$/.test(m) || IMAGE_EXT.test(name)) return "image";
  if (m.startsWith("text/") || TEXT_EXT.test(name) || m === "application/json" || m === "application/x-tex") return "text";
  return "unknown";
}

/** True when the first bytes hold no NUL and decode as UTF-8 (the end may cut a character). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** The size a picture is drawn at: within `max` on its longer side, never enlarged. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export interface JpegAttempt {
  /** Longer side in pixels. */
  side: number;
  quality: number;
}

const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45];

/** The first encoding to try for a picture of this size. */
export function firstJpegAttempt(width: number, height: number): JpegAttempt {
  const fit = fitWithin(width, height);
  return { side: Math.max(fit.width, fit.height), quality: QUALITIES[0] };
}

/**
 * The next encoding after one that came out `bytes` long, or null when it
 * fits (or can't get smaller). Quality drops first; at the lowest quality the
 * picture shrinks by a fifth and quality starts again a step lower.
 */
export function nextJpegAttempt(prev: JpegAttempt, bytes: number, limit = MAX_IMAGE_BYTES): JpegAttempt | null {
  if (bytes <= limit) return null;
  const i = QUALITIES.indexOf(prev.quality);
  if (i >= 0 && i < QUALITIES.length - 1) {
    // Far too large: skip a quality step.
    const step = bytes > limit * 2.5 && i < QUALITIES.length - 2 ? 2 : 1;
    return { side: prev.side, quality: QUALITIES[i + step] };
  }
  const side = Math.floor(prev.side * 0.8);
  if (side < MIN_IMAGE_SIDE) return null;
  return { side, quality: QUALITIES[1] };
}

/** Bytes a base64 data URL decodes to. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** Cuts text to `max` characters; says whether it did. */
export function capText(text: string, max = MAX_TEXT_CHARS): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

/** "1.2 MB", "34 KB", "120 bytes". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why another file can't be added, or null when it can. */
export function attachLimitReason(current: { kind: "image" | "text" }[], adding: "image" | "text"): string | null {
  if (current.length >= MAX_ATTACHMENTS) return `You can attach up to ${MAX_ATTACHMENTS} files to one message.`;
  if (adding === "image" && current.filter((a) => a.kind === "image").length >= MAX_IMAGES) {
    return `You can attach up to ${MAX_IMAGES} pictures to one message.`;
  }
  return null;
}
