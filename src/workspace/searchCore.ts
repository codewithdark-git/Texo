// The matcher behind project search (Ctrl+Shift+F): turns the query and its
// options into a regular expression and finds hits line by line. Pure, so
// the panel only has to gather file texts.

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchHit {
  /** 1-based, like the editor. */
  line: number;
  column: number;
  /** The line around the match, trimmed for display. */
  preview: string;
  /** Where the match sits in `preview`. */
  start: number;
  end: number;
}

export interface FileHits {
  path: string;
  hits: SearchHit[];
}

export interface SearchResult {
  files: FileHits[];
  total: number;
  /** The hit cap was reached; there may be more. */
  capped: boolean;
}

export const MAX_HITS = 2000;

/** How much of the line before a match the preview keeps. */
const LEAD = 40;
const PREVIEW_MAX = 160;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The query as a global RegExp, or an error message for an invalid regex.
 * Null for an empty query. */
export function compileQuery(query: string, options: SearchOptions): RegExp | { error: string } | null {
  if (!query) return null;
  const source = options.regex ? query : escapeRegex(query);
  const flags = options.caseSensitive ? "g" : "gi";
  try {
    if (!options.wholeWord) return new RegExp(source, flags);
    // Word characters include accented letters, so try Unicode mode first.
    try {
      return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, flags + "u");
    } catch {
      return new RegExp(`(?<!\\w)(?:${source})(?!\\w)`, flags);
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^Invalid regular expression: /, "") : "Invalid pattern" };
  }
}

/** A display slice of a line with the match's position inside it. */
function preview(line: string, start: number, end: number): Pick<SearchHit, "preview" | "start" | "end"> {
  let from = Math.max(0, start - LEAD);
  // Don't start mid-indent.
  while (from < start && /\s/.test(line[from])) from++;
  const to = Math.min(line.length, Math.max(end, from + PREVIEW_MAX));
  const prefix = from > 0 ? "…" : "";
  return {
    preview: prefix + line.slice(from, to) + (to < line.length ? "…" : ""),
    start: prefix.length + start - from,
    end: prefix.length + Math.min(end, to) - from,
  };
}

/** Hits in one text, at most `limit`. Zero-length matches are skipped. */
export function searchText(text: string, re: RegExp, limit = MAX_HITS): SearchHit[] {
  const hits: SearchHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) && hits.length < limit) {
      if (m[0].length === 0) {
        re.lastIndex++;
        if (re.lastIndex > line.length) break;
        continue;
      }
      hits.push({ line: i + 1, column: m.index + 1, ...preview(line, m.index, m.index + m[0].length) });
    }
  }
  return hits;
}

/** Searches several files in order, stopping at `maxHits` in total. */
export function searchFiles(
  files: { path: string; text: string }[],
  re: RegExp,
  maxHits = MAX_HITS,
): SearchResult {
  const result: SearchResult = { files: [], total: 0, capped: false };
  for (const file of files) {
    if (result.total >= maxHits) {
      result.capped = true;
      break;
    }
    const hits = searchText(file.text, re, maxHits - result.total);
    if (hits.length === 0) continue;
    result.files.push({ path: file.path, hits });
    result.total += hits.length;
  }
  if (result.total >= maxHits) result.capped = true;
  return result;
}
