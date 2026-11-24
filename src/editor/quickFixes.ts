// The pure parts of Texo's quick fixes (codeActions.ts offers them in the
// editor): close matches for a mistyped key, and the package that defines a
// well-known command, plus where its \usepackage line goes.

/** Edit distance between two strings (case-insensitive). */
export function editDistance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Up to `limit` candidates closest to `key`, nearest first, leaving out `key`
 * itself and anything too different to be a plausible typo.
 */
export function closestKeys(key: string, candidates: readonly string[], limit = 3): string[] {
  const allowed = Math.max(2, Math.ceil(key.length * 0.5));
  return [...new Set(candidates)]
    .filter((c) => c !== key)
    .map((c) => ({ c, d: editDistance(key, c) }))
    .filter((x) => x.d <= allowed)
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, limit)
    .map((x) => x.c);
}

/** Packages that define common commands people use without loading them. */
export const PACKAGE_FOR_COMMAND: Readonly<Record<string, string>> = {
  includegraphics: "graphicx",
  graphicspath: "graphicx",
  url: "url",
  href: "hyperref",
  hypersetup: "hyperref",
  autoref: "hyperref",
  textcolor: "xcolor",
  color: "xcolor",
  colorbox: "xcolor",
  definecolor: "xcolor",
  SI: "siunitx",
  si: "siunitx",
  qty: "siunitx",
  unit: "siunitx",
  num: "siunitx",
  toprule: "booktabs",
  midrule: "booktabs",
  bottomrule: "booktabs",
  cmidrule: "booktabs",
  mathbb: "amssymb",
  mathfrak: "amssymb",
  text: "amsmath",
  eqref: "amsmath",
  DeclareMathOperator: "amsmath",
  citep: "natbib",
  citet: "natbib",
  multirow: "multirow",
  cref: "cleveref",
  Cref: "cleveref",
  lipsum: "lipsum",
  blindtext: "blindtext",
  todo: "todonotes",
  sout: "ulem",
  uline: "ulem",
  bm: "bm",
  tikz: "tikz",
  subcaption: "subcaption",
  captionof: "caption",
  checkmark: "amssymb",
  euro: "eurosym",
};

/** The package for an undefined `\name` (with or without the backslash), if it's a known one. */
export function packageFor(command: string): string | null {
  const name = command.replace(/^\\/, "");
  return Object.prototype.hasOwnProperty.call(PACKAGE_FOR_COMMAND, name) ? PACKAGE_FOR_COMMAND[name] : null;
}

/** True when `text`'s preamble already loads `pkg` (alone or in a list). */
export function loadsPackage(text: string, pkg: string): boolean {
  const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1].split(",").some((p) => p.trim() === pkg)) return true;
  }
  return false;
}

/**
 * The 1-based line to insert a `\usepackage` line before: just after the last
 * one-line `\usepackage` of the preamble, else at `\begin{document}`. Null when
 * the text has no preamble (an included chapter, say).
 */
export function usepackageInsertLine(lines: readonly string[]): number | null {
  let begin = -1;
  let hasClass = false;
  let lastPackage = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/(^|[^\\])%.*$/, "$1");
    if (/\\documentclass\b/.test(line)) hasClass = true;
    if (/\\begin\s*\{document\}/.test(line)) {
      begin = i;
      break;
    }
    // Only a \usepackage whose arguments close on the same line; after a
    // multi-line one the new line would land inside its options.
    if (/^\s*\\usepackage\b.*\}\s*$/.test(line)) lastPackage = i;
  }
  if (!hasClass || begin < 0) return null;
  return (lastPackage >= 0 ? lastPackage + 1 : begin) + 1;
}
