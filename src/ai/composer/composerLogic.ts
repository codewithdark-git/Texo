// The AI Chat bar's rules, kept apart from React so they can be tested:
// what "Include <file>" sends, which project files can be attached, what a
// key press does, and the shortcut that focuses the bar (one the code editor
// doesn't use).

import type { ChatCurrentFile } from "../../lib/chatApi";
import type { FileEntry } from "../../lib/api";
import { fuzzyFilter } from "../../lib/fuzzy";

export interface EditorSelection {
  startLine: number;
  endLine: number;
  text: string;
}

/** What the editor has to offer when the bar sends. */
export interface EditorContext {
  /** The text file in front, if any. */
  file: string | null;
  /** Its text (may be unsaved). */
  text?: string;
  selection: EditorSelection | null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The name a selection goes by ("Selection from main.tex, lines 3–7"). */
export function selectionName(file: string, sel: Pick<EditorSelection, "startLine" | "endLine">): string {
  const lines = sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine}–${sel.endLine}`;
  return `Selection from ${fileName(file)}, ${lines}`;
}

/** The "Include" chip's words: the open file, or its selection when there is one. */
export function includeLabel(ctx: Pick<EditorContext, "file" | "selection">): string {
  if (!ctx.file) return "Include current file";
  return ctx.selection ? "Include selection" : `Include ${fileName(ctx.file)}`;
}

/** What the chip explains on hover. */
export function includeHint(ctx: Pick<EditorContext, "file" | "selection">, on: boolean): string {
  if (!ctx.file) return "Open a file to include it";
  const what = ctx.selection ? selectionName(ctx.file, ctx.selection) : fileName(ctx.file);
  return on ? `${what} goes with your message. Click to leave it out.` : `Click to send ${what} with your message`;
}

/**
 * What "Include" adds to a message: the open file with its text (and the
 * selected lines, when there are some), or nothing when it is off or no
 * text file is open (the assistant reads project files with its tools).
 */
export function includedFile(on: boolean, ctx: EditorContext): ChatCurrentFile | undefined {
  if (!on || !ctx.file) return undefined;
  return {
    file: ctx.file,
    ...(ctx.text !== undefined ? { text: ctx.text } : {}),
    ...(ctx.selection ? { selection: ctx.selection } : {}),
  };
}

/** The bar's grey hint text: about the selection, the open file when it is included, or the project. */
export function placeholderFor(ctx: Pick<EditorContext, "file" | "selection">, include: boolean): string {
  if (include && ctx.file && ctx.selection) return "AI Chat: ask about the selection…";
  if (include && ctx.file) return `AI Chat: ask about ${fileName(ctx.file)}…`;
  return "AI Chat: ask about your project…";
}

const ATTACHABLE = /\.(tex|ltx|bib|sty|cls|bst|txt|md|markdown|csv|tsv|json|ya?ml|xml|svg|log|py|r|m|png|jpe?g|gif|webp|bmp|pdf)$/i;

/**
 * Whether project `file` is already attached. `sources` maps chip ids to the
 * project path they came from, since a picture's chip is renamed to its
 * shrunk "<name>.jpg".
 */
export function alreadyAttached(attachments: { id: string; name: string }[], file: string, sources: ReadonlyMap<string, string>): boolean {
  return attachments.some((a) => a.name === file || sources.get(a.id) === file);
}

/** Project files the "+" menu can attach: text, pictures and PDFs, not Texo's own or build output. */
export function attachableFiles(files: FileEntry[]): string[] {
  return files.filter((f) => !f.isDir && !f.path.startsWith(".texo/") && !f.path.startsWith(".git/") && ATTACHABLE.test(f.path)).map((f) => f.path);
}

/** Up to `limit` project files for a filter, best first (all of them, by path, when it is empty). */
export function suggestFiles(paths: string[], query: string, limit = 8): string[] {
  return fuzzyFilter(query, paths, limit).map((m) => m.path);
}

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** An IME is still composing the text; its Enter is not ours. */
  isComposing?: boolean;
}

/** What a key in the bar's text box does: Enter sends, Shift+Enter is a new line, Esc goes back to the editor. */
export function composerKey(e: KeyLike): "send" | "newline" | "blur" | null {
  if (e.isComposing) return null;
  if (e.key === "Enter") {
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return "newline";
    if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return "send";
    return null;
  }
  if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return "blur";
  return null;
}

/** A shortcut written as "ctrl+shift+k": modifiers in this order, then the key, lower case. */
export function shortcutOf(e: KeyLike): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  if (e.metaKey) parts.push("meta");
  parts.push(e.key.toLowerCase());
  return parts.join("+");
}

/**
 * The Ctrl shortcuts the code editor (Monaco) binds by default on Windows and
 * Linux, plus the ones Texo adds to it. The bar's shortcut must not be one of
 * them, or it would steal an editing key.
 */
export const MONACO_RESERVED: readonly string[] = [
  "ctrl+a", "ctrl+c", "ctrl+x", "ctrl+v", "ctrl+z", "ctrl+y", "ctrl+shift+z",
  "ctrl+f", "ctrl+h", "ctrl+g", "ctrl+d", "ctrl+k", "ctrl+l", "ctrl+u", "ctrl+i", "ctrl+m",
  "ctrl+/", "ctrl+]", "ctrl+[", "ctrl+ ", "ctrl+.", "ctrl+enter", "ctrl+backspace", "ctrl+delete",
  "ctrl+home", "ctrl+end", "ctrl+arrowup", "ctrl+arrowdown", "ctrl+arrowleft", "ctrl+arrowright",
  "ctrl+f2", "ctrl+f3", "ctrl+f12",
  "ctrl+shift+ ", "ctrl+shift+enter", "ctrl+shift+k", "ctrl+shift+l", "ctrl+shift+o", "ctrl+shift+\\",
  "ctrl+shift+[", "ctrl+shift+]", "ctrl+shift+arrowup", "ctrl+shift+arrowdown",
  // Texo's own: save, and the PDF jump (Ctrl+Alt+J).
  "ctrl+s", "ctrl+alt+j",
];

/** Focuses the AI Chat bar from anywhere in the workspace. */
export const COMPOSER_SHORTCUT = "ctrl+j";
export const COMPOSER_SHORTCUT_LABEL = "Ctrl+J";

/** Whether a key press is the bar's shortcut. */
export function isComposerShortcut(e: KeyLike): boolean {
  return shortcutOf(e) === COMPOSER_SHORTCUT;
}

/** Whether a modal dialog is open, so Ctrl+J leaves its focus trap alone. */
export function modalOpen(doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document): boolean {
  return !!doc?.querySelector('[aria-modal="true"]');
}

/** The parts of the chat store a send from the bar looks at. */
export interface BarChatState {
  current: { id: string } | null;
  drafts: Record<string, string>;
  failure: { chatId: string; request: { text: string } } | null;
}

export interface BarChatStore<S extends BarChatState> {
  getState: () => S;
  setState: (fn: (s: S) => Partial<S>) => void;
  subscribe: (listener: (s: S) => void) => () => void;
}

/**
 * Sends from the bar without touching the AI panel's composer. The store's
 * send clears the open chat's draft (it assumes the panel sent it), so the
 * panel's unsent words are put back once it does, following a new chat if the
 * send creates one. Resolves true when the send failed, so the bar can put
 * its own words back.
 */
export async function sendFromBar<S extends BarChatState>(store: BarChatStore<S>, send: () => Promise<void>): Promise<boolean> {
  const start = store.getState();
  const kept = start.drafts[start.current?.id ?? ""] ?? "";
  const failureBefore = start.failure;
  let unsubscribe = () => {};
  if (kept) {
    // Wait for the send to clear the draft of the chat it went to, then refill it.
    const watch = (s: S) => {
      const id = s.current?.id;
      if (!id || s.drafts[id] !== "") return;
      unsubscribe();
      store.setState((now) => ({ drafts: { ...now.drafts, [id]: kept } }) as Partial<S>);
    };
    unsubscribe = store.subscribe(watch);
  }
  try {
    await send();
  } finally {
    unsubscribe();
  }
  const end = store.getState();
  const failure = end.failure;
  if (!failure || failure === failureBefore) return false;
  // A failed send puts its words in the panel's draft; they are the bar's, so
  // the panel keeps what it had.
  const id = failure.chatId;
  if (id && end.drafts[id] === failure.request.text && kept !== failure.request.text) {
    store.setState((now) => ({ drafts: { ...now.drafts, [id]: kept } }) as Partial<S>);
  }
  return true;
}
