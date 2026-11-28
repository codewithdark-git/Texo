// Starting, retrying and applying agent runs from the UI, with the editor
// kept in step: unsaved buffers go with a run (and are saved before an
// apply), and applied files reload in their editor models.

import { agentsApi, type ApplyResult, type Attachment, type Decision, type StartRequest } from "../../lib/agentsApi";
import { toast } from "../../ui";
import { useCompile } from "../../workspace/compileStore";
import { getModel, useWorkspace } from "../../workspace/store";
import { dirtyBuffers } from "../chat/composerActions";
import { useAiPanel } from "../panel/aiPanelStore";
import { useRunFocus } from "./focusStore";
import { useRuns } from "./runsStore";
import { useHistory } from "../../history/historyStore";

export const errorText = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : "Something went wrong. Try again.";

/** Starts a run with the editor's unsaved text and opens its tab. Returns the run id, or null when it couldn't start. */
export async function startRun(project: string, request: StartRequest): Promise<string | null> {
  try {
    const run = await agentsApi.start(project, { dirtyBuffers: dirtyBuffers(), ...request });
    useRuns.getState().noteRun(run);
    useAiPanel.getState().noteRun(run);
    useRunFocus.getState().focus(run.id);
    return run.id;
  } catch (e) {
    toast(errorText(e), "error");
    return null;
  }
}

/** "Let the fixer agent handle it": a fixer run on the open project. */
export function startFixerRun(): Promise<string | null> {
  const project = useWorkspace.getState().project?.path;
  if (!project) return Promise.resolve(null);
  return startRun(project, { kind: "fixer", profileId: "fixer", prompt: "", options: { title: "Fix compile errors" } });
}

/** Starts a finished run's request again (attachments read from the project come along; others must be added again). */
export async function retryRun(project: string, runId: string): Promise<string | null> {
  let run;
  try {
    run = await agentsApi.get(project, runId);
  } catch (e) {
    toast(errorText(e), "error");
    return null;
  }
  const attachments: Attachment[] = run.attachments.filter((a) => a.path).map((a) => ({ name: a.name, mime: a.mime, path: a.path }));
  const lost = run.attachments.length - attachments.length;
  const id = await startRun(project, {
    kind: run.kind,
    profileId: run.profileId,
    prompt: run.prompt,
    attachments,
    options: run.options,
  });
  if (id && lost > 0) toast(`Started again without ${lost} attached file(s). Use New task to attach them again.`, "info");
  return id;
}

/**
 * Applies decisions: saves unsaved edits of those files first (the merge
 * compares with the disk), then reloads what changed in the editor and
 * recompiles when auto-compile is on.
 */
export async function applyDecisions(project: string, runId: string, decisions: Decision[]): Promise<ApplyResult> {
  const ws = useWorkspace.getState();
  const accepted = decisions.filter((d) => d.accept).map((d) => d.file);
  await Promise.all(accepted.filter((f) => ws.status[f]?.dirty && getModel(f)).map((f) => ws.save(f)));
  const result = await agentsApi.apply(project, runId, decisions);
  useRuns.getState().noteRun(result.run);
  // The accepted changes are a new version in History.
  void useHistory.getState().refreshStatus();
  const changed = [...result.written, ...result.deleted];
  if (changed.length > 0) {
    await useWorkspace.getState().reloadFromDisk(changed);
    if (useCompile.getState().auto && changed.some((f) => /\.(tex|ltx|bib|sty|cls|bst|png|jpe?g|pdf|eps|svg|tikz|csv|dat)$/i.test(f))) void useCompile.getState().compile();
  }
  return result;
}
