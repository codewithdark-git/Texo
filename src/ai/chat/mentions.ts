// "@file" mentions in the chat composer: finding the word being typed,
// suggesting project files for it, and putting the chosen path in. Pure, so
// the composer's behaviour is unit-tested without a DOM.

import { fuzzyFilter } from "../../lib/fuzzy";
import type { FileEntry } from "../../lib/api";

/** Characters a mention may hold (the backend reads the same set; no spaces). */
const MENTION_CHAR = /[\w./\\-]/;

export interface MentionQuery {
  /** Index of the "@". */
  start: number;
  /** What follows the "@" up to the caret. */
  query: string;
}

/** The mention being typed at `caret`, if any: an "@" at the start or after whitespace, then path characters up to the caret. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  let i = Math.min(caret, text.length);
  while (i > 0 && MENTION_CHAR.test(text[i - 1])) i--;
  if (i === 0 || text[i - 1] !== "@") return null;
  const at = i - 1;
  if (at > 0 && !/\s/.test(text[at - 1])) return null;
  return { start: at, query: text.slice(i, caret) };
}

/** Files that can be mentioned: text-like project files whose paths have no spaces. */
export function mentionableFiles(files: FileEntry[]): string[] {
  return files
    .filter((f) => !f.isDir && !/\s/.test(f.path) && !f.path.startsWith(".texo/") && !BINARY_EXT.test(f.path))
    .map((f) => f.path);
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|eps|ps|zip|gz|tgz|7z|rar|exe|dll|so|dylib|ttf|otf|woff2?|mp[34]|mov|avi|wav|ogg|synctex|aux|xdv|dvi)$/i;

/** Up to `limit` suggestions for a query, best first. */
export function suggestMentions(paths: string[], query: string, limit = 8): string[] {
  return fuzzyFilter(query, paths, limit).map((m) => m.path);
}

/** Replaces the mention being typed with "@path " and returns the new text and caret. */
export function applyMention(text: string, q: MentionQuery, caret: number, path: string): { text: string; caret: number } {
  let end = caret;
  while (end < text.length && MENTION_CHAR.test(text[end])) end++;
  const insert = `@${path}`;
  const after = text.slice(end);
  const spacer = after.startsWith(" ") ? "" : " ";
  return { text: text.slice(0, q.start) + insert + spacer + after, caret: q.start + insert.length + 1 };
}
