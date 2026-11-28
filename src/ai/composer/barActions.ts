// What the AI Chat bar does outside itself: starting an agent through the
// same calls the Agents tab uses (startRun, its dialogs), bringing the run's
// tab into view, listing the custom agents, and attaching a project file.

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { profilesApi, type AgentProfile } from "../../lib/agentsApi";
import { toast } from "../../ui";
import { getModel } from "../../workspace/store";
import { startRun } from "../agents/actions";
import { openAgentDialog } from "../agents/dialogStore";
import { useRunFocus } from "../agents/focusStore";
import { attachLimitReason, classifyAttachment } from "../chat/attachments";
import { useChat, type DraftAttachment } from "../chat/chatStore";
import { AttachmentError, readBytes, type ReadyAttachment } from "../chat/readAttachment";
import { agentAction, runAttachmentsProblem, type AgentEntry } from "./agentMenu";
import { alreadyAttached } from "./composerLogic";

/** The project's profiles, read again whenever `refresh` changes (the user may add agents in Settings). */
export function useAgentProfiles(project: string, refresh: unknown): AgentProfile[] {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  useEffect(() => {
    let live = true;
    profilesApi.list(project).then(
      (v) => live && setProfiles(v.profiles),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [project, refresh]);
  return profiles;
}

/**
 * Starts an agent from the bar. "started": the run is going and its tab is
 * in view; "dialog": its setup dialog opened with the words and files (the
 * bar keeps them until the dialog starts the run, then `onDialogStarted`
 * runs); "failed": nothing started (a toast says why).
 */
export async function startAgentFromBar(
  project: string,
  agent: AgentEntry,
  text: string,
  attachments: DraftAttachment[],
  onDialogStarted?: () => void,
): Promise<"started" | "dialog" | "failed"> {
  const problem = runAttachmentsProblem(attachments);
  if (problem) {
    toast(problem, "info");
    return "failed";
  }
  const action = agentAction(agent, text, attachments);
  if (action.type === "dialog") {
    // The workspace keeps the dialogs mounted, so this shows over the file in
    // front; no Agents tab opens. Starting the run brings its own tab into
    // view; the bar only lets go of what the dialog took.
    const dialog = action.dialog.type === "new" || action.dialog.type === "review" ? { ...action.dialog, onStarted: () => onDialogStarted?.() } : action.dialog;
    openAgentDialog(dialog);
    return "dialog";
  }
  const id = await startRun(project, action.request);
  if (!id) return "failed";
  useRunFocus.getState().focus(id);
  return "started";
}

let nextId = 1;

/** The project path each project-file chip came from, by chip id (a picture's chip is renamed to its shrunk "<name>.jpg"). */
const projectSources = new Map<string, string>();

/** Reads a project file the way a dropped file is read (pictures shrunk, PDFs as text, text capped). */
async function readProjectFile(project: string, file: string): Promise<ReadyAttachment> {
  const name = file;
  const kind = classifyAttachment(file, "");
  // Open text: the editor's words, saved or not.
  const model = getModel(file);
  if (model && kind !== "image" && kind !== "pdf") return readBytes(name, "text/plain", new TextEncoder().encode(model.getValue()));
  if (kind === "image" || kind === "pdf") {
    const buf = await api.readAsset(project, file);
    return readBytes(name, "", new Uint8Array(buf));
  }
  const content = await api.readFile(project, file);
  if (content.kind === "text") return readBytes(name, "text/plain", new TextEncoder().encode(content.content));
  if (content.kind === "tooLarge") throw new AttachmentError(`“${file}” is too large to attach.`);
  throw new AttachmentError(`Texo can't read “${file}”. Attach text files, PDFs or pictures.`);
}

/** Attaches a file of the open project to the next message. */
export async function attachProjectFile(project: string, file: string): Promise<void> {
  const store = useChat.getState();
  // Forget chips that were removed or sent.
  for (const id of projectSources.keys()) if (!store.attachments.some((a) => a.id === id)) projectSources.delete(id);
  if (alreadyAttached(store.attachments, file, projectSources)) return;
  const guess = classifyAttachment(file, "") === "image" ? "image" : "text";
  const current = store.attachments.map((a) => ({ kind: a.kind ?? (classifyAttachment(a.name, "") === "image" ? ("image" as const) : ("text" as const)) }));
  const refused = attachLimitReason(current, guess);
  if (refused) {
    toast(refused, "info");
    return;
  }
  const id = `proj-${nextId++}`;
  projectSources.set(id, file);
  store.addAttachment({ id, name: file, status: "reading" });
  try {
    const ready = await readProjectFile(project, file);
    if (!useChat.getState().attachments.some((a) => a.id === id)) return; // removed while reading
    useChat.getState().updateAttachment(id, { status: "ready", ...ready, name: ready.kind === "image" ? ready.name : file });
  } catch (err) {
    useChat.getState().removeAttachment(id);
    toast(err instanceof AttachmentError ? err.message : `Texo couldn't read “${file}”.`, "error");
  }
}

/** Empties the bar's attachments once a run took them. */
export function clearAttachments() {
  useChat.setState({ attachments: [] });
}
