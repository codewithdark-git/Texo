// The "Use BibTeX backend" fix offered in the Issues panel: biblatex uses
// Biber by default, and when Biber isn't available the bibliography never
// gets built, so every \cite comes out undefined. BibTeX ships with every TeX
// install. Pure text helpers; CompilePanel applies the edit to the model.

/** A compile hint split into an optional fix id (`[fix:id] ...`) and the sentence to show. */
export function parseHint(hint: string): { fix: string | null; text: string } {
  const m = /^\[fix:([a-z0-9-]+)\]\s*/i.exec(hint);
  return m ? { fix: m[1], text: hint.slice(m[0].length) } : { fix: null, text: hint };
}

/** A replacement of `text.slice(start, end)`. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** True when `offset` sits after an unescaped % on its line (a comment). */
function inComment(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /(^|[^\\])%/.test(text.slice(lineStart, offset));
}

/** `text` with every % comment blanked out to spaces, so offsets still line up. */
function maskComments(text: string): string {
  return text.replace(/(^|[^\\])(%[^\n]*)/g, (_, before: string, comment: string) => before + " ".repeat(comment.length));
}

/**
 * The edit that makes `\usepackage[...]{biblatex}` use `backend=bibtex`:
 * replaces another backend, or adds the option (Biber is the default when none
 * is given). Null when biblatex isn't loaded or already uses BibTeX.
 */
export function bibtexBackendEdit(text: string): TextEdit | null {
  const re = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{\s*biblatex\s*\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (inComment(text, m.index)) continue;
    const opts = m[1];
    if (opts === undefined) {
      // \usepackage{biblatex}: add the options before the braces.
      const at = m.index + "\\usepackage".length;
      return { start: at, end: at, text: "[backend=bibtex]" };
    }
    const optsStart = m.index + m[0].indexOf("[") + 1;
    // A `backend=` inside a % comment does nothing, so look past comments.
    const live = maskComments(opts);
    const backend = /(^|,)(\s*)backend\s*=\s*([A-Za-z0-9]*)/.exec(live);
    if (backend) {
      if (backend[3] === "bibtex") return null;
      const start = optsStart + backend.index + backend[1].length + backend[2].length;
      return { start, end: start + backend[0].length - backend[1].length - backend[2].length, text: "backend=bibtex" };
    }
    if (!live.trim()) {
      // Nothing but space (or comments) in the brackets: keep any comment on its line.
      return opts.includes("%")
        ? { start: optsStart, end: optsStart, text: "backend=bibtex," }
        : { start: optsStart, end: optsStart + opts.length, text: "backend=bibtex" };
    }
    // First in the list: the end of the list may sit inside a % comment,
    // where an added option would be ignored.
    return { start: optsStart, end: optsStart, text: "backend=bibtex," };
  }
  return null;
}

/** `text` with `edit` applied. */
export function applyEdit(text: string, edit: TextEdit): string {
  return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
}
