// Adding files to the chat composer (attach button, paste, drops inside the
// page, and drops from the file manager routed here by the workspace), and
// building what a message sends about the editor.

import { toast } from "../../ui";
import { getModel, useWorkspace } from "../../workspace/store";
import { editorSelection } from "../../workspace/editorBridge";
import type { ChatCurrentFile } from "../../lib/chatApi";
import { attachLimitReason, classifyAttachment } from "./attachments";
import { AttachmentError, readDroppedPath, readFileObject, type ReadyAttachment } from "./readAttachment";
import { useChat, type DraftAttachment } from "./chatStore";

/** The attribute marking the composer as a drop target for files from the file manager. */
export const CHAT_DROP_ATTR = "data-chat-drop";

let nextId = 1;

async function attachOne(name: string, read: () => Promise<ReadyAttachment>) {
  const store = useChat.getState();
  const guess = classifyAttachment(name, "") === "image" ? "image" : "text";
  const current = store.attachments.map((a) => ({ kind: a.kind ?? (classifyAttachment(a.name, "") === "image" ? ("image" as const) : ("text" as const)) }));
  const refused = attachLimitReason(current, guess);
  if (refused) {
    toast(refused, "info");
    return;
  }
  const id = `att-${nextId++}`;
  const draft: DraftAttachment = { id, name, status: "reading" };
  store.addAttachment(draft);
  try {
    const ready = await read();
    if (!useChat.getState().attachments.some((a) => a.id === id)) return; // removed while reading
    useChat.getState().updateAttachment(id, { status: "ready", ...ready });
  } catch (err) {
    useChat.getState().removeAttachment(id);
    const message = err instanceof AttachmentError ? err.message : `Texo couldn't read “${name}”.`;
    toast(message, "error");
  }
}

/** Files from the attach button, a paste, or a drop inside the page. */
export function attachFiles(files: Iterable<File>) {
  for (const f of files) void attachOne(f.name || "pasted picture", () => readFileObject(f));
}

/** Paths dropped from the file manager onto the composer. */
export function attachPaths(paths: string[]) {
  for (const p of paths) void attachOne(p.split(/[\\/]/).pop() || "file", () => readDroppedPath(p));
}

/** The file in front of the editor, as a text file the chat can include (null when none). */
export function activeTextFile(): string | null {
  const ws = useWorkspace.getState();
  const path = ws.active;
  if (!path || ws.views[path]?.kind !== "text" || !getModel(path)) return null;
  return path;
}

/** "Include current file / selection": the editor text and the code editor's selection, if any. */
export function currentFileContext(): ChatCurrentFile | undefined {
  const path = activeTextFile();
  const model = path ? getModel(path) : undefined;
  if (!path || !model) return undefined;
  const selection = editorSelection(path);
  return { file: path, text: model.getValue(), ...(selection ? { selection } : {}) };
}

/** Unsaved editor text, which the chat's tools read instead of the files on disk. */
export function dirtyBuffers(): { file: string; text: string }[] {
  const ws = useWorkspace.getState();
  const out: { file: string; text: string }[] = [];
  for (const [file, status] of Object.entries(ws.status)) {
    if (!status.dirty) continue;
    const model = getModel(file);
    if (model) out.push({ file, text: model.getValue() });
    if (out.length >= 64) break;
  }
  return out;
}
