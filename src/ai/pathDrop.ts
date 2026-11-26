// Files dropped from the file manager. Tauri takes OS file drops itself, so
// the page's own onDrop never sees them: the workspace asks here where a drop
// goes. An open dialog that takes attachments (the New task dialog) marks its
// area with PATH_DROP_ATTR and registers a handler; a drop on any other open
// dialog is refused instead of being copied into the project (FE-2).

/** Marks an element as a drop target for files from the file manager; the value is the handler's id. */
export const PATH_DROP_ATTR = "data-path-drop";

const handlers = new Map<string, (paths: string[]) => void>();

/** Sends drops on `[data-path-drop="<id>"]` to `fn` until the returned function is called. */
export function registerPathDrop(id: string, fn: (paths: string[]) => void): () => void {
  handlers.set(id, fn);
  return () => {
    if (handlers.get(id) === fn) handlers.delete(id);
  };
}

/** The bit of a DOM element routeDrop needs (so it can be tested without a DOM). */
interface DropElement {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/**
 * Where a drop on `el` goes: a registered handler, "blocked" (over a dialog
 * that doesn't take files: do nothing), or null (the workspace imports the files).
 */
export function routeDrop(el: DropElement | null): ((paths: string[]) => void) | "blocked" | null {
  if (!el) return null;
  const target = el.closest(`[${PATH_DROP_ATTR}]`);
  const fn = target ? handlers.get(target.getAttribute(PATH_DROP_ATTR) ?? "") : undefined;
  if (fn) return fn;
  if (el.closest('[aria-modal="true"]')) return "blocked";
  return null;
}
