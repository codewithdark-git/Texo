// Pure text helpers for the AI fixer: checking that a proposed edit is safe and
// still applies, applying edits to text, and a small line diff for previews.
// The fix panel applies the edits through the editor models; nothing here
// touches the editor or the disk.

/** One change the AI proposes: replace `find` (exact existing text) with `replace` in `file`. */
export interface ProposedEdit {
  /** Project-relative path with `/`. */
  file: string;
  find: string;
  replace: string;
  why: string;
}

/**
 * Files the fixer may change: LaTeX and BibTeX sources, never PDFs, images or
 * build output. latexmkrc is left out on purpose: it is Perl code that runs on
 * compile. Matches the backend's list (src-tauri/src/ai/validate.rs).
 */
const TEXT_FILE = /\.(tex|ltx|sty|cls|bib|bbx|cbx|bst|cfg|def|clo|fd|dtx|ins|tikz|pgf|txt|md)$/i;

/** Why `file` isn't a path the fixer may edit, or null when it is fine. */
export function badEditPath(file: string): string | null {
  if (!file || !file.trim()) return "The suggestion doesn't say which file to change.";
  const path = file.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("~")) {
    return "The suggestion points outside your project, so Texo won't apply it.";
  }
  const parts = path.split("/");
  if (parts.some((p) => p === ".." || p === "")) {
    return "The suggestion points outside your project, so Texo won't apply it.";
  }
  if (path.includes("\0")) return "The file name isn't valid.";
  const name = parts[parts.length - 1];
  if (parts[0] === ".texo") return "Texo won't change its own files.";
  if (!TEXT_FILE.test(name)) {
    return `${name} isn't a text file Texo can change safely.`;
  }
  return null;
}

/** A project-relative path in Texo's form (forward slashes, no leading `./`). */
export function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** Where an edit lands in the current text, or why it no longer applies. */
export type EditLocation = { ok: true; start: number; end: number } | { ok: false; reason: string };

/**
 * Finds `edit.find` in `text`. It must occur exactly once: the AI saw the file
 * as it was when it was asked, and the text may have changed since.
 */
export function locateEdit(text: string, edit: Pick<ProposedEdit, "find" | "replace">): EditLocation {
  if (!edit.find) return { ok: false, reason: "The suggestion doesn't say which text to change." };
  if (edit.find === edit.replace) return { ok: false, reason: "The suggestion doesn't change anything." };
  const first = text.indexOf(edit.find);
  if (first < 0) {
    return { ok: false, reason: "The text this change was for isn't in the file any more (it may have been edited since)." };
  }
  if (text.indexOf(edit.find, first + 1) >= 0) {
    return { ok: false, reason: "The text to change appears more than once in the file, so Texo can't tell which one is meant." };
  }
  return { ok: true, start: first, end: first + edit.find.length };
}

export interface PlacedEdit {
  start: number;
  end: number;
  text: string;
  /** Index into the list the caller passed. */
  index: number;
}

/**
 * Places several edits to the same file. Each must match exactly once in the
 * current text, and no two may overlap; the ones that fail come back with a reason.
 */
export function placeEdits(
  text: string,
  edits: Pick<ProposedEdit, "find" | "replace">[],
): { placed: PlacedEdit[]; failed: { index: number; reason: string }[] } {
  const placed: PlacedEdit[] = [];
  const failed: { index: number; reason: string }[] = [];
  edits.forEach((edit, index) => {
    const at = locateEdit(text, edit);
    if (!at.ok) {
      failed.push({ index, reason: at.reason });
      return;
    }
    const clash = placed.find((p) => at.start < p.end && p.start < at.end);
    if (clash) {
      failed.push({ index, reason: "This change overlaps another accepted change to the same text." });
      return;
    }
    placed.push({ start: at.start, end: at.end, text: edit.replace, index });
  });
  placed.sort((a, b) => a.start - b.start);
  return { placed, failed };
}

/** `text` with non-overlapping `edits` applied (offsets refer to the original text). */
export function applyPlaced(text: string, edits: Pick<PlacedEdit, "start" | "end" | "text">[]): string {
  let out = "";
  let pos = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    out += text.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + text.slice(pos);
}

export type DiffLine = { kind: "same" | "add" | "del"; text: string; /** 1-based line in the old or new text. */ line: number };

/** Lines compared with a plain LCS table; past this size the preview just lists old and new. */
const DIFF_MAX_CELLS = 250_000;

/** A line-by-line diff of `before` and `after`. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim the common head and tail so the table stays small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: "same", text: a[i], line: i + 1 });

  if (midA.length * midB.length > DIFF_MAX_CELLS) {
    midA.forEach((t, i) => out.push({ kind: "del", text: t, line: head + i + 1 }));
    midB.forEach((t, i) => out.push({ kind: "add", text: t, line: head + i + 1 }));
  } else {
    const n = midA.length;
    const m = midB.length;
    // lcs[i][j]: longest common subsequence of midA[i..] and midB[j..].
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: "same", text: midA[i], line: head + i + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        // Removed lines first, then their replacements.
        out.push({ kind: "del", text: midA[i], line: head + i + 1 });
        i++;
      } else {
        out.push({ kind: "add", text: midB[j], line: head + j + 1 });
        j++;
      }
    }
  }

  for (let k = a.length - tail; k < a.length; k++) out.push({ kind: "same", text: a[k], line: k + 1 });
  return out;
}

/** A preview of one edit in its file: the changed lines with a little context around them. */
export interface EditPreview {
  /** 1-based line where the shown excerpt starts in the current file. */
  firstLine: number;
  lines: DiffLine[];
}

/**
 * The diff of applying `edit` to `text`, cut to the changed lines plus
 * `context` lines on each side. Null when the edit no longer applies.
 */
export function previewEdit(text: string, edit: Pick<ProposedEdit, "find" | "replace">, context = 2): EditPreview | null {
  const at = locateEdit(text, edit);
  if (!at.ok) return null;
  const lineStart = (offset: number) => text.lastIndexOf("\n", offset - 1) + 1;
  // Widen to whole lines, then by `context` lines each way.
  let from = lineStart(at.start);
  for (let k = 0; k < context && from > 0; k++) from = lineStart(from - 1);
  let to = text.indexOf("\n", at.end);
  if (to < 0) to = text.length;
  for (let k = 0; k < context && to < text.length; k++) {
    const next = text.indexOf("\n", to + 1);
    to = next < 0 ? text.length : next;
  }
  const before = text.slice(from, to);
  const after = text.slice(from, at.start) + edit.replace + text.slice(at.end, to);
  const firstLine = text.slice(0, from).split("\n").length;
  const lines = diffLines(before, after).map((l) => ({ ...l, line: l.line + firstLine - 1 }));
  return { firstLine, lines };
}

/** Package names the fixer may suggest installing (MiKTeX and TeX Live names). */
export const PACKAGE_NAME = /^[A-Za-z0-9._-]+$/;

/** Also refuses a leading `-`, which a package manager would read as an option. */
export function validPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && PACKAGE_NAME.test(name) && !name.startsWith("-");
}
