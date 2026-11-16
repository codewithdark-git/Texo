// Word counts. countWords is the quick count for the status bar: the words a
// reader sees in the body text, leaving out comments, the preamble, commands,
// environments, and maths. countDetailed splits that into body text, headings,
// captions and footnotes and counts maths, floats and citations; countProject
// follows \input, \include and \subfile across a whole document.
import { blankComments, readGroup } from "./texScan";

/** Commands whose argument isn't reader-facing text. */
const SKIP_ARGUMENT = /\\(?:label|ref|eqref|pageref|autoref|cref|Cref|cite[a-zA-Z]*|nocite|input|include|includegraphics|bibliography|bibliographystyle|usepackage|documentclass|begin|end|url|href|newcommand|renewcommand|setlength|vspace|hspace)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g;

/** Display maths environments (the starred forms too). */
const DISPLAY_ENV = /\\begin\{(equation|align|gather|multline|eqnarray|displaymath|math)\*?\}[\s\S]*?\\end\{\1\*?\}/g;
const INLINE_OR_DISPLAY = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$]*\$/g;

/** The body between \begin{document} and \end{document}, or all of it. */
function documentBody(text: string): string {
  const body = text.indexOf("\\begin{document}");
  if (body !== -1) text = text.slice(body + "\\begin{document}".length);
  const end = text.indexOf("\\end{document}");
  if (end !== -1) text = text.slice(0, end);
  return text;
}

/** Commands, braces and other markup removed; what's left is reader text. */
function stripMarkup(text: string): string {
  return text
    .replace(SKIP_ARGUMENT, " ")
    // Remaining commands disappear but keep their text arguments.
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, " ")
    .replace(/\\./g, " ")
    .replace(/[{}~&]/g, " ");
}

/** Tokens that contain at least one letter or digit. */
function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

export function countWords(tex: string): number {
  let text = documentBody(tex.replace(/(^|[^\\])%.*$/gm, "$1")); // comments
  // Display and inline maths.
  text = text.replace(DISPLAY_ENV, " ").replace(INLINE_OR_DISPLAY, " ");
  return wordsOf(stripMarkup(text)).length;
}

export interface DetailedCount {
  /** Words in the running text (not headings, captions or footnotes). */
  textWords: number;
  headingWords: number;
  captionWords: number;
  footnoteWords: number;
  headings: number;
  figures: number;
  tables: number;
  inlineMath: number;
  displayMath: number;
  /** Cited keys: `\cite{a,b}` counts two. */
  citations: number;
  /** Characters in all counted words, not counting spaces. */
  characters: number;
}

export const EMPTY_COUNT: DetailedCount = {
  textWords: 0,
  headingWords: 0,
  captionWords: 0,
  footnoteWords: 0,
  headings: 0,
  figures: 0,
  tables: 0,
  inlineMath: 0,
  displayMath: 0,
  citations: 0,
  characters: 0,
};

/** All words: text, headings, captions and footnotes. */
export function totalWords(c: DetailedCount): number {
  return c.textWords + c.headingWords + c.captionWords + c.footnoteWords;
}

/** Commands whose argument is counted separately, by kind. */
const SEPARATE =
  /\\(?:(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)|(caption)|(footnote))\*?\s*(?:\[[^\]]*\])?\s*\{/g;

/** Inclusion commands; their file names aren't words. */
const INCLUSION = /\\(?:subfile|includeonly|addbibresource)\s*\{[^{}]*\}/g;

export function countDetailed(tex: string): DetailedCount {
  const counts = { ...EMPTY_COUNT };
  let text = documentBody(blankComments(tex));

  // Maths first, so `$…$` inside a caption or heading disappears with it.
  text = text.replace(DISPLAY_ENV, (_m, env: string) => {
    if (env === "math") counts.inlineMath++;
    else counts.displayMath++;
    return " ";
  });
  text = text.replace(INLINE_OR_DISPLAY, (m) => {
    if (m.startsWith("$$") || m.startsWith("\\[")) counts.displayMath++;
    else counts.inlineMath++;
    return " ";
  });

  counts.figures = text.match(/\\begin\{(?:figure|wrapfigure)\*?\}/g)?.length ?? 0;
  counts.tables = text.match(/\\begin\{table\*?\}/g)?.length ?? 0;
  for (const m of text.matchAll(/\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^{}]*)\}/g)) {
    counts.citations += m[1].split(",").filter((k) => k.trim() && k.trim() !== "*").length;
  }
  text = text.replace(INCLUSION, " ");

  // Pull out headings, captions and footnotes, counting their words apart.
  const characters = (words: string[]) => words.reduce((n, w) => n + [...w].length, 0);
  let rest = "";
  let from = 0;
  for (const m of text.matchAll(SEPARATE)) {
    if (m.index! < from) continue; // inside a group already counted
    const open = m.index! + m[0].length;
    const group = readGroup(text, open);
    if (group === null) continue;
    const words = wordsOf(stripMarkup(group));
    if (m[1]) {
      counts.headings++;
      counts.headingWords += words.length;
    } else if (m[2]) {
      counts.captionWords += words.length;
    } else {
      counts.footnoteWords += words.length;
    }
    counts.characters += characters(words);
    rest += text.slice(from, m.index) + " ";
    from = open + group.length + 1;
  }
  rest += text.slice(from);

  const words = wordsOf(stripMarkup(rest));
  counts.textWords = words.length;
  counts.characters += characters(words);
  return counts;
}

export function addCounts(a: DetailedCount, b: DetailedCount): DetailedCount {
  const sum = { ...a };
  for (const key of Object.keys(sum) as (keyof DetailedCount)[]) sum[key] += b[key];
  return sum;
}

export interface FileCount {
  /** Project-relative path with `/`. */
  path: string;
  /** Null when the file couldn't be read. */
  stats: DetailedCount | null;
}

export interface ProjectCount {
  /** Every file in reading order, the main document first. */
  files: FileCount[];
  totals: DetailedCount;
  /** Included files that weren't found. */
  missing: string[];
}

const MAX_DEPTH = 32;
const INCLUDE = /\\(input|include|subfile)\s*\{([^{}]+)\}/g;

/** `a/b` + `../c.tex` → `a/c.tex`; the result never climbs out of the project. */
function resolvePath(dir: string, target: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const part of target.replace(/\\/g, "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function withTex(path: string): string {
  return /\.[a-zA-Z0-9]+$/.test(path) ? path : `${path}.tex`;
}

/** Counts the main document and every file it includes. `read` returns a
 * file's text by project-relative path, or null if it doesn't exist. */
export async function countProject(main: string, read: (path: string) => Promise<string | null>): Promise<ProjectCount> {
  const files: FileCount[] = [];
  const missing: string[] = [];
  const visited = new Set<string>();
  // Like LaTeX, paths resolve against the main document's folder.
  const root = main.includes("/") ? main.slice(0, main.lastIndexOf("/")) : "";
  let only: Set<string> | null = null;

  const visit = async (path: string, depth: number) => {
    if (visited.has(path) || depth > MAX_DEPTH) return;
    visited.add(path);
    const text = await read(path).catch(() => null);
    if (text === null) {
      files.push({ path, stats: null });
      missing.push(path);
      return;
    }
    files.push({ path, stats: countDetailed(text) });

    const clean = blankComments(text);
    if (depth === 0) {
      const includeOnly = /\\includeonly\s*\{([^{}]*)\}/.exec(clean);
      if (includeOnly) {
        only = new Set(
          includeOnly[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => withTex(resolvePath(root, s))),
        );
      }
    }
    // In a file with a preamble, only the body's includes are text.
    const begin = clean.indexOf("\\begin{document}");
    const body = begin === -1 ? clean : clean.slice(begin);
    for (const m of body.matchAll(INCLUDE)) {
      const target = withTex(resolvePath(root, m[2].trim()));
      if (m[1] === "include" && only && !only.has(target)) continue;
      await visit(target, depth + 1);
    }
  };

  await visit(main, 0);
  const totals = files.reduce((sum, f) => (f.stats ? addCounts(sum, f.stats) : sum), { ...EMPTY_COUNT });
  return { files, totals, missing };
}

/** Words in a Markdown file's prose: no code, maths, link targets or HTML. */
export function countMarkdownWords(md: string): number {
  const text = withoutFencedCode(md.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, " ")) // front matter
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(`+)[\s\S]*?\1/g, " ") // inline code
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]+\$/g, " ")
    .replace(/^ {0,3}\[[^\]]+\]:\s*\S+.*$/gm, " ") // link reference definitions
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // keep link text, drop the URL
    .replace(/<[^>]+>/g, " ") // HTML tags and autolinks
    .replace(/\|/g, " "); // table cells
  return wordsOf(text).length;
}

/** Drops ``` and ~~~ fenced blocks, fences included. An unclosed fence runs
 * to the end of the file, as in Markdown. */
function withoutFencedCode(md: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1];
    } else {
      kept.push(line);
    }
  }
  return kept.join("\n");
}
