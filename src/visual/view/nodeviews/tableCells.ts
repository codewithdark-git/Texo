// What a table cell's LaTeX looks like to a reader, for Visual mode's grid.

/**
 * A LaTeX cell's text as a reader sees it, or null when it still holds code
 * (a macro, maths, a group) that only the PDF can show faithfully.
 */
export function plainCell(text: string): string | null {
  const out = text
    .replace(/\{([,.;:!?])\}/g, "$1")
    .replace(/\\([%&#_$])/g, "$1")
    .replace(/\\[,;: ]|~/g, " ")
    .replace(/--/g, "–")
    .trim();
  return /[\\{}$^]/.test(out) ? null : out;
}

/** Every cell as plain text, or null when any cell needs the PDF to look right. */
export function plainRows(rows: string[][]): string[][] | null {
  const out: string[][] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (const cell of row) {
      const plain = plainCell(cell);
      if (plain === null) return null;
      cells.push(plain);
    }
    out.push(cells);
  }
  return out;
}
