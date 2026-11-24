// \input and \include in Visual mode: the included file is drawn in place,
// read-only, as part of the page, so a document split across files reads as
// one. Here: which project file a target names (never outside the project),
// loading its text, and drawing it in a small read-only ProseMirror view
// with the same node views and styling as the page.

import { EditorState } from "prosemirror-state";
import { EditorView, type MarkViewConstructor, type NodeViewConstructor } from "prosemirror-view";
import { api } from "../../lib/api";
import { getModel, useWorkspace } from "../../workspace/store";
import { parentDir } from "../../workspace/paths";
import { createSession, dialectFor, helpersFor, type DocContext } from "../core";
import type { Binding } from "./binding";
import type { GetEnv, VisualEnv } from "./commands";

/** How deep includes inside includes are drawn before showing just their name. */
export const MAX_INCLUDE_DEPTH = 3;

/**
 * A target cleaned up as a project-relative path, or null when it would
 * leave the project (an absolute path, a drive letter, a ".." segment) or
 * isn't a plain file name.
 */
export function safeTarget(target: string): string | null {
  const t = target.trim().replace(/\\/g, "/").replace(/^"(.*)"$/, "$1");
  if (!t || t.startsWith("/") || /^[a-z]:/i.test(t) || /^~/.test(t)) return null;
  if (/[\\{}$#%]/.test(t)) return null;
  const parts = t.split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/**
 * The project file an \input or \include names, as LaTeX finds it: relative
 * to the main document's folder first, then to the including file's, with
 * or without ".tex". Null when there's no such file in the project.
 */
export function resolveInclude(target: string, fromFile: string, mainDocument: string | null | undefined, files: Iterable<string>): string | null {
  const name = safeTarget(target);
  if (!name) return null;
  const known = new Set(files);
  const dirs = [mainDocument ? parentDir(mainDocument) : "", parentDir(fromFile)];
  for (const dir of dirs) {
    for (const ext of ["", ".tex"]) {
      const p = (dir ? dir + "/" : "") + name + ext;
      if (known.has(p)) return p;
    }
  }
  return null;
}

/** The workspace's view of `resolveInclude`. */
export function includedFile(target: string, fromFile: string): string | null {
  const ws = useWorkspace.getState();
  return resolveInclude(
    target,
    fromFile,
    ws.project?.mainDocument,
    ws.files.filter((f) => !f.isDir).map((f) => f.path),
  );
}

/** The file name to show for a target ("sec_intro.tex"). */
export function displayName(target: string): string {
  const t = target.trim().replace(/\\/g, "/");
  const base = t.split("/").pop() || t;
  return /\.[a-z]+$/i.test(base) ? base : base + ".tex";
}

/** An included file's text: the open editor's when it is open (unsaved edits included), else from disk. */
export async function loadIncludeText(path: string): Promise<string | null> {
  const model = getModel(path);
  if (model) return model.getValue();
  const project = useWorkspace.getState().project?.path;
  if (!project) return null;
  try {
    const content = await api.readFile(project, path);
    return content.kind === "text" ? content.content : null;
  } catch {
    return null;
  }
}

/** Where an include view sits: how deep, and which files enclose it (to stop cycles). */
interface IncludeChain {
  depth: number;
  files: string[];
}

const chains = new WeakMap<object, IncludeChain>();

/** The include chain an env draws at: depth 0 and just its own file for the page itself. */
export function chainOf(env: VisualEnv): IncludeChain {
  return chains.get(env) ?? { depth: 0, files: [env.path] };
}

/** Whether a file at this point may be drawn inline (not too deep, not already an ancestor). */
export function mayInline(chain: IncludeChain, file: string): "ok" | "deep" | "cycle" {
  if (chain.files.includes(file)) return "cycle";
  if (chain.depth >= MAX_INCLUDE_DEPTH) return "deep";
  return "ok";
}

/** Set by the node-view registry, which can't be imported here without a cycle. */
export const includeHooks: {
  nodeViews: ((getEnv: GetEnv) => Record<string, NodeViewConstructor>) | null;
  markViews: (() => Record<string, MarkViewConstructor>) | null;
} = { nodeViews: null, markViews: null };

/**
 * Draws `text` (the file `path`) read-only into `host`. The returned view is
 * the caller's to destroy. Clicks never reach it (the include block opens
 * the file instead), so its node views never edit anything.
 */
export function renderInclude(host: HTMLElement, path: string, text: string, parent: { chain: IncludeChain; context?: Partial<DocContext> }, toast: VisualEnv["toast"]): EditorView | null {
  const dialect = dialectFor(path);
  if (!dialect) return null;
  const ctx = parent.context;
  const session = createSession(
    dialect,
    text,
    ctx
      ? {
          context: {
            docClass: ctx.docClass,
            hasChapters: ctx.hasChapters,
            packages: ctx.packages,
            macros: ctx.macros,
            macrosHash: ctx.macrosHash,
            theorems: ctx.theorems,
            graphicsPaths: ctx.graphicsPaths,
          },
        }
      : undefined,
  );
  // The env exists before the view, so node views see it on their first draw; the view joins it after.
  const env: VisualEnv = {
    path,
    dialect,
    session,
    // Nothing writes through it: the view is read-only and takes no clicks.
    binding: null as unknown as Binding,
    helpers: helpersFor(dialect),
    view: null as unknown as EditorView,
    toast,
    openInCode: () => {},
  };
  chains.set(env, { depth: parent.chain.depth + 1, files: [...parent.chain.files, path] });
  const getEnv: GetEnv = () => env;
  const view = new EditorView(host, {
    state: EditorState.create({ doc: session.doc }),
    editable: () => false,
    // Read-only: selection changes are fine, edits are dropped.
    dispatchTransaction: (tr) => {
      if (!tr.docChanged) view.updateState(view.state.apply(tr));
    },
    nodeViews: includeHooks.nodeViews?.(getEnv) ?? {},
    markViews: includeHooks.markViews?.() ?? {},
    attributes: { class: "v-include-doc", "aria-readonly": "true" },
  });
  env.view = view;
  return view;
}
