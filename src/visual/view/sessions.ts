// One Visual session per open file, kept while its tab is open so switching
// files or modes is instant and keeps the selection and scroll position.

import type { EditorState } from "prosemirror-state";
import { api } from "../../lib/api";
import { getModel, onModelDispose, useWorkspace } from "../../workspace/store";
import { createSession, dialectFor, readContext, type DocContext, type VisualSession } from "../core";
import type { SourceSel } from "./binding";

export interface SessionEntry {
  session: VisualSession;
  /** The view state last shown for this file (null until first shown). */
  state: EditorState | null;
  /** The model changed while no view was attached. */
  stale: boolean;
  scrollTop: number;
  /** Source selections keyed by model.getAlternativeVersionId(), for undo and redo. */
  selMap: Map<number, SourceSel>;
  /** True while a Visual view is attached (it then follows the model itself). */
  attached: boolean;
  dispose(): void;
}

const entries = new Map<string, SessionEntry>();
const pending = new Map<string, Promise<SessionEntry | null>>();

onModelDispose((path) => {
  entries.get(path)?.dispose();
  entries.delete(path);
  pending.delete(path);
});

export function peekSession(path: string): SessionEntry | undefined {
  return entries.get(path);
}

const hasDocument = (text: string) => /\\begin\s*\{document\}/.test(text);

/** For an \input file: the main document's class, packages, macros and theorems. */
async function mainContext(path: string, text: string): Promise<Partial<DocContext> | undefined> {
  if (hasDocument(text)) return undefined;
  const ws = useWorkspace.getState();
  const main = ws.project?.mainDocument;
  if (!main || main === path || !/\.(tex|ltx)$/i.test(main)) return undefined;
  let mainText = getModel(main)?.getValue();
  if (mainText === undefined && ws.project) {
    try {
      const content = await api.readFile(ws.project.path, main);
      if (content.kind === "text") mainText = content.content;
    } catch {
      // No main document to borrow from.
    }
  }
  if (!mainText) return undefined;
  const ctx = readContext("latex", mainText);
  return {
    docClass: ctx.docClass,
    hasChapters: ctx.hasChapters,
    packages: ctx.packages,
    macros: ctx.macros,
    macrosHash: ctx.macrosHash,
    theorems: ctx.theorems,
    graphicsPaths: ctx.graphicsPaths,
  };
}

/** The file's session, creating it on first use. Null when the file isn't open as text or isn't supported. */
export function openSession(path: string): Promise<SessionEntry | null> {
  const existing = entries.get(path);
  if (existing) return Promise.resolve(existing);
  const inFlight = pending.get(path);
  if (inFlight) return inFlight;
  const job = (async () => {
    const model = getModel(path);
    const dialect = dialectFor(path);
    if (!model || !dialect) return null;
    const context = dialect === "latex" ? await mainContext(path, model.getValue()) : undefined;
    if (getModel(path) !== model) return null;
    const session = createSession(dialect, model.getValue(), context ? { context } : undefined);
    const entry: SessionEntry = {
      session,
      state: null,
      stale: false,
      scrollTop: 0,
      selMap: new Map(),
      attached: false,
      dispose: () => sub.dispose(),
    };
    const sub = model.onDidChangeContent(() => {
      if (!entry.attached) entry.stale = true;
    });
    // A job started after this one (the file was closed and reopened) may have won.
    const other = entries.get(path);
    if (other) {
      entry.dispose();
      return other;
    }
    entries.set(path, entry);
    return entry;
  })().finally(() => {
    // Only this job's own slot: a newer job for a reopened file keeps its own.
    if (pending.get(path) === job) pending.delete(path);
  });
  pending.set(path, job);
  return job;
}
