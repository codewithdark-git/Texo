// Small scanning helpers for LaTeX source, shared by the outline and the
// word count.

/** Reads a balanced `{…}` group starting just after its opening brace. */
export function readGroup(text: string, start: number): string | null {
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

/** Blanks out `%` comments (not `\%`) but keeps offsets and line breaks. */
export function blankComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, (m, pre: string) => pre + " ".repeat(m.length - pre.length));
}
