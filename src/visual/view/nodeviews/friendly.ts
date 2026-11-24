// Readable stand-ins for LaTeX that Visual mode keeps as written: what a
// command does, in words, or the text it would print. Pure helpers, so the
// page never has to show a backslash.

/** Words for commands that stand on a line of their own. */
export const COMMAND_LABELS: Record<string, string> = {
  input: "Included file",
  include: "Included file",
  maketitle: "Title",
  tableofcontents: "Table of contents",
  listoffigures: "List of figures",
  listoftables: "List of tables",
  bibliography: "Bibliography",
  printbibliography: "Bibliography",
  bibliographystyle: "Bibliography style",
  newpage: "Page break",
  clearpage: "Page break",
  cleardoublepage: "Page break",
  pagebreak: "Page break",
  appendix: "Appendix",
  frontmatter: "Front matter",
  mainmatter: "Main matter",
  backmatter: "Back matter",
  printindex: "Index",
  makeindex: "Index",
  centering: "Centred",
  noindent: "No indent",
  medskip: "Space",
  bigskip: "Space",
  smallskip: "Space",
  vfill: "Space",
  hfill: "Space",
};

/** The command a source starts with ("\\maketitle" → "maketitle"), or null. */
export function commandName(src: string): string | null {
  return /^\s*\\([A-Za-z@]+)\*?/.exec(src)?.[1] ?? null;
}

/** A friendly name for a command block, never with a backslash. */
export function commandLabel(src: string, kind = ""): string {
  const name = commandName(src);
  if (name && COMMAND_LABELS[name]) return COMMAND_LABELS[name];
  if (kind && COMMAND_LABELS[kind]) return COMMAND_LABELS[kind];
  return name ? humanize(name) : "Layout";
}

/** "printacronyms" → "Print acronyms"-ish: splits camel case and known word starts. */
export function humanize(name: string): string {
  const words = name
    .replace(/@/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^(print|make|list|set|new|renew|add|use)(?=[a-z])/i, "$1 ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The text an inline piece of LaTeX would print, roughly: command names
 * dropped, their brace arguments kept. Empty when nothing readable is left
 * (`\hspace{1cm}`, `\vspace*{2em}`, a lone `\foo`).
 */
export function readableInline(src: string): string {
  const noArgs = /\\(?:h|v)space\*?\s*\{[^{}]*\}|\\(?:label|ref|cite|index|hypertarget|phantom|hphantom|vphantom)\s*\{[^{}]*\}/g;
  // Commands whose first argument is a setting (a colour, a URL), not text.
  const settingArg = /\\(?:textcolor|colorbox|href|foreignlanguage)\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g;
  return src
    .replace(noArgs, "")
    .replace(settingArg, "")
    .replace(/\\(?:LaTeXe)\b/g, "LaTeX2e")
    .replace(/\\(?:LaTeX)\b/g, "LaTeX")
    .replace(/\\(?:TeX)\b/g, "TeX")
    .replace(/\\(?:ldots|dots)\b/g, "…")
    .replace(/\\\\/g, " ")
    .replace(/\\([%$&#_{}])/g, "$1")
    .replace(/\\[A-Za-z@]+\*?(\s*\[[^\]]*\])*/g, "")
    .replace(/\\./g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
