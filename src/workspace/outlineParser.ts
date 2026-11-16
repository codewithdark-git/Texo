// Builds the document outline from sectioning commands in a .tex file, or
// from the headings of a Markdown file.
import { blankComments, readGroup } from "../lib/texScan";

export interface OutlineItem {
  level: number;
  title: string;
  line: number;
  starred: boolean;
}

const LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const HEADING = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{/g;

/** Turns `The \emph{Big} Idea~1` into `The Big Idea 1` for display. */
export function plainTitle(tex: string): string {
  return tex
    .replace(/\\(?:emph|textbf|textit|texttt|textsc|mathrm|mathbf|text)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:label|footnote|cite\w*|ref)\s*\{[^{}]*\}/g, "")
    .replace(/~/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseOutline(text: string): OutlineItem[] {
  // Blank out comments but keep offsets, so line numbers stay right.
  const clean = blankComments(text);
  const items: OutlineItem[] = [];
  for (const match of clean.matchAll(HEADING)) {
    const title = readGroup(clean, match.index! + match[0].length);
    if (title === null) continue;
    items.push({
      level: LEVELS[match[1]],
      title: plainTitle(title) || "(untitled)",
      line: clean.slice(0, match.index).split("\n").length,
      starred: match[2] === "*",
    });
  }
  return items;
}

/** Opening or closing line of a fenced code block: ``` or ~~~, up to 3 spaces in. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** Lines that can't be the text of a setext heading: lists, quotes, code. */
const NOT_PARAGRAPH = /^(?: {4}|\s*(?:[-*+>]|\d+[.)])(?:\s|$))/;

/** Strips inline Markdown markup from a heading for display. */
function plainMarkdown(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** ATX (`# Title`) and setext (`Title` over `===`) headings, outside fenced code.
 * Markdown levels 1 to 6 map onto outline levels 1 to 6. */
export function parseMarkdownOutline(text: string): OutlineItem[] {
  const lines = text.split(/\r?\n/);
  const items: OutlineItem[] = [];
  let fence: string | null = null;
  let start = 0;
  // YAML front matter isn't part of the outline (its closing --- would
  // otherwise read as a setext underline).
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (close > 0) start = close + 1;
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      // A fence closes with at least as many of the same character.
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      items.push({ level: atx[1].length, title: plainMarkdown(atx[2] ?? "") || "(untitled)", line: i + 1, starred: false });
      continue;
    }
    const next = lines[i + 1];
    const underline = next === undefined ? null : SETEXT.exec(next);
    if (underline && line.trim() && !NOT_PARAGRAPH.test(line)) {
      items.push({
        level: underline[1][0] === "=" ? 1 : 2,
        title: plainMarkdown(line) || "(untitled)",
        line: i + 1,
        starred: false,
      });
      i++; // The underline isn't a line of its own.
    }
  }
  return items;
}
