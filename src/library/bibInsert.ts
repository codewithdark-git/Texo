// "Add to bibliography": puts a BibTeX entry at the end of a .bib file. When
// the file is open the entry goes into its editor buffer (so Ctrl+Z undoes
// it and unsaved edits are kept); otherwise it is written to the file on
// disk. The backend already picked a key no .bib file uses; this checks
// again against the text being changed, which may hold unsaved entries.

/** The line ending a file uses: CRLF when its first line break is CRLF. */
export function detectEol(text: string): "\r\n" | "\n" {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

const ENTRY_KEY = /@\s*([A-Za-z]+)\s*[{(]\s*([^\s,{}()]+)\s*,/g;

/** The keys of the entries in `text` (not @string, @preamble or @comment). */
export function bibKeys(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(ENTRY_KEY)) {
    const type = m[1].toLowerCase();
    if (type !== "string" && type !== "preamble" && type !== "comment") keys.push(m[2]);
  }
  return keys;
}

/** The key of the first entry in `entry`, or null when it has none. */
export function entryKey(entry: string): string | null {
  return bibKeys(entry)[0] ?? null;
}

export type AppendResult = { ok: true; text: string; key: string } | { ok: false; reason: string };

/**
 * `text` with `entry` added at the end, after one blank line, in the file's
 * own line endings. Refuses an entry without a key or with a key the file
 * already has (BibTeX ignores case in keys, so this does too).
 */
export function appendBibEntry(text: string, entry: string): AppendResult {
  const key = entryKey(entry);
  if (!key) return { ok: false, reason: "That BibTeX entry has no key." };
  const taken = bibKeys(text).some((k) => k.toLowerCase() === key.toLowerCase());
  if (taken) return { ok: false, reason: `The file already has an entry called ${key}.` };
  const eol = detectEol(text);
  const body = entry.trim().replace(/\r?\n/g, eol);
  const head = text.replace(/\s+$/, "");
  return { ok: true, key, text: head ? `${head}${eol}${eol}${body}${eol}` : `${body}${eol}` };
}

/** The smallest edit that turns `before` into `after`: replace [start, end) of `before` with `text`. */
export function diffRange(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < max - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

/** How the insert reads and changes files; the app's version uses the editor and the project folder. */
export interface BibIo {
  /** The open editor buffer's text, or null when the file isn't open. */
  openText: (file: string) => Promise<string | null>;
  /** Changes the open buffer (one undo step) and saves it. */
  editOpen: (file: string, edit: { start: number; end: number; text: string }) => Promise<void>;
  /** The file's text on disk; "" when it doesn't exist yet. */
  readDisk: (file: string) => Promise<string>;
  writeDisk: (file: string, text: string) => Promise<void>;
}

export interface BibInsertResult {
  file: string;
  key: string;
  /** Where the entry went: the open buffer or the file on disk. */
  target: "buffer" | "disk";
  before: string;
  after: string;
}

/** Adds `entry` to `file`, in its open buffer if there is one. Throws a plain sentence when it can't. */
export async function insertBibEntry(io: BibIo, file: string, entry: string): Promise<BibInsertResult> {
  const open = await io.openText(file);
  const before = open ?? (await io.readDisk(file));
  const result = appendBibEntry(before, entry);
  if (!result.ok) throw new Error(result.reason);
  if (open !== null) await io.editOpen(file, diffRange(before, result.text));
  else await io.writeDisk(file, result.text);
  return { file, key: result.key, target: open !== null ? "buffer" : "disk", before, after: result.text };
}

/**
 * Takes an insert back, but only while the file still holds exactly what the
 * insert left (so later edits are never thrown away). Returns whether it did.
 */
export async function undoBibInsert(io: BibIo, done: BibInsertResult): Promise<boolean> {
  const open = await io.openText(done.file);
  const now = open ?? (await io.readDisk(done.file));
  if (now !== done.after) return false;
  if (open !== null) await io.editOpen(done.file, diffRange(now, done.before));
  else await io.writeDisk(done.file, done.before);
  return true;
}

/** The app's BibIo: Monaco models for open files, the project folder otherwise. Loaded lazily so tests don't pull in the editor. */
export function workspaceBibIo(project: string): BibIo {
  const workspace = () => import("../workspace/store");
  const fileApi = async () => (await import("../lib/api")).api;
  return {
    openText: async (file) => (await workspace()).getModel(file)?.getValue() ?? null,
    editOpen: async (file, edit) => {
      const { getModel, useWorkspace } = await workspace();
      const model = getModel(file);
      if (!model) throw new Error(`${file} was closed before the entry could be added.`);
      const from = model.getPositionAt(edit.start);
      const to = model.getPositionAt(edit.end);
      model.pushStackElement();
      model.pushEditOperations(
        [],
        [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: edit.text }],
        () => null,
      );
      model.pushStackElement();
      // Save now, so the library's .bib scan sees the new entry.
      await useWorkspace.getState().save(file);
    },
    readDisk: async (file) => {
      const api = await fileApi();
      try {
        const content = await api.readFile(project, file);
        if (content.kind !== "text") throw new Error(`${file} isn't a text file.`);
        return content.content;
      } catch (err) {
        // A file that isn't there yet starts empty; anything else is a real problem.
        const ws = (await workspace()).useWorkspace.getState();
        if (!ws.files.some((f) => f.path === file)) return "";
        throw err;
      }
    },
    writeDisk: async (file, text) => {
      const api = await fileApi();
      const ws = (await workspace()).useWorkspace.getState();
      const existed = ws.files.some((f) => f.path === file);
      await api.writeFile(project, file, text);
      if (!existed) await ws.refreshFiles();
    },
  };
}
