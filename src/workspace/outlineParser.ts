// Builds the document outline from sectioning commands in a .tex file.

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

/** Reads a balanced `{…}` group starting just after its opening brace. */
function readGroup(text: string, start: number): string | null {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return text.slice(start, i);
    } else if (ch === "\n" && text[i + 1] === "\n") {
      return null; // A blank line ends the paragraph; the title is unclosed.
    }
  }
  return null;
}

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
  const clean = text.replace(/(^|[^\\])%.*$/gm, (m, pre: string) => pre + " ".repeat(m.length - pre.length));
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
