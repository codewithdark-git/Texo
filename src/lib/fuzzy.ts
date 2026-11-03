// Fuzzy file matching for Quick Open: the query's characters must appear in
// order; matches at the start of the file name, after a separator, or in a
// run score higher.

export interface FuzzyMatch {
  path: string;
  score: number;
  /** Indexes into `path` of the matched characters, for highlighting. */
  positions: number[];
}

const SEPARATORS = new Set(["/", "-", "_", ".", " "]);

export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { path, score: 0, positions: [] };
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;

  const positions: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    const i = lower.indexOf(ch, from);
    if (i === -1) return null;
    const prev = positions[positions.length - 1];
    if (prev !== undefined && i === prev + 1) score += 5; // consecutive run
    if (i === nameStart) score += 8; // start of the file name
    else if (i === 0 || SEPARATORS.has(path[i - 1])) score += 4; // word start
    if (i >= nameStart) score += 2; // in the name rather than the folder
    positions.push(i);
    from = i + 1;
  }
  // Prefer shorter paths and earlier first matches.
  score -= path.length * 0.05 + positions[0] * 0.1;
  return { path, score, positions };
}

export function fuzzyFilter(query: string, paths: string[], limit = 50): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  for (const p of paths) {
    const m = fuzzyMatch(query, p);
    if (m) matches.push(m);
  }
  if (query.trim()) matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return matches.slice(0, limit);
}
