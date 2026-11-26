// The "Explain & fix" session: asks the AI about the last compile, keeps the
// proposal while the user reviews it, re-checks and applies the accepted
// edits through the editor models (one undo step per file), saves,
// recompiles, and judges the round. The rules live in fixModel.ts; this store
// does the side effects.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  AI_PROGRESS_EVENT,
  aiApi,
  api,
  type AiContextPreview,
  type AiProgress,
  type AiProviderInfo,
  type CompileResult,
  type Issue,
} from "../lib/api";
import { toast, useUi } from "../ui";
import { useCompile } from "../workspace/compileStore";
import { getModel, useWorkspace } from "../workspace/store";
import { loadProviders, useAiSettings } from "./aiPrefs";
import { locateEdit, placeEdits, type ProposedEdit } from "./fixEdits";
import {
  acceptedEdits,
  compileInput,
  defaultAiMessage,
  fixReducer,
  initialFixState,
  normalizeProposal,
  previousAttempts,
  toAiError,
  type AiError,
  type FixEvent,
  type FixScope,
  type FixState,
} from "./fixModel";

interface FixStore extends FixState {
  provider: AiProviderInfo | null;
  /** The model that answered last. */
  model: string | null;
  /** The backend's progress line while a request runs. */
  progress: string | null;
  /** Current text of each file the proposal edits, for the previews. */
  texts: Record<string, string>;
  /** Exactly what a request would send, loaded on demand from the notice. */
  preview: AiContextPreview | null;
  /** Opens the panel for an issue or the whole compile (or Settings, when AI can't run yet). */
  start: (scope: FixScope) => Promise<void>;
  loadPreview: () => Promise<void>;
  acceptNotice: () => Promise<void>;
  ask: () => Promise<void>;
  cancel: () => Promise<void>;
  toggle: (index: number) => void;
  setAll: (decision: "accepted" | "rejected") => void;
  apply: () => Promise<void>;
  retry: () => Promise<void>;
  close: () => void;
}

/** The request in flight, so Cancel and late answers can tell it apart. */
let currentRequest: string | null = null;
let stopProgress: (() => void) | null = null;

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Waits for the compile that is running or queued now to finish. */
function nextCompile(startedAt: number): Promise<CompileResult | null> {
  return new Promise((resolve) => {
    const check = (s = useCompile.getState()) => {
      if (s.compiling || s.queued) return false;
      if ((s.finishedAt ?? 0) >= startedAt) resolve(s.result);
      // A compile that failed outright (no result) also ends the wait.
      else if (s.error) resolve(null);
      else return false;
      return true;
    };
    if (check()) return;
    const stop = useCompile.subscribe((s) => {
      if (check(s)) stop();
    });
  });
}

/** The current text of a project file: the open model, else the file on disk. */
async function currentText(file: string): Promise<string | null> {
  const model = getModel(file);
  if (model) return model.getValue();
  const path = useWorkspace.getState().project?.path;
  if (!path) return null;
  try {
    const content = await api.readFile(path, file);
    return content.kind === "text" ? content.content : null;
  } catch {
    return null;
  }
}

const plainError = (kind: AiError["kind"], message?: string): AiError => ({ kind, message: message ?? defaultAiMessage(kind) });

export const useFix = create<FixStore>((set, get) => {
  const dispatch = (event: FixEvent) => set((s) => fixReducer(s, event));

  /** Re-reads the files a proposal touches; returns why each edit can't apply (or null). */
  const checkLocally = async (edits: ProposedEdit[]) => {
    const texts: Record<string, string> = {};
    for (const file of new Set(edits.map((e) => e.file))) {
      const text = await currentText(file);
      if (text !== null) texts[file] = text;
    }
    const problems = edits.map((e) => {
      const text = texts[e.file];
      if (text === undefined) return `Texo can't open ${e.file}, or it isn't a text file.`;
      const at = locateEdit(text, e);
      return at.ok ? null : at.reason;
    });
    return { texts, problems };
  };

  const endRequest = () => {
    currentRequest = null;
    stopProgress?.();
    stopProgress = null;
  };

  return {
    ...initialFixState,
    provider: null,
    model: null,
    progress: null,
    texts: {},
    preview: null,

    start: async (scope) => {
      const settings = await useAiSettings.getState().load();
      const openSettings = () => useUi.getState().openSettings("ai");
      if (!settings.enabled) {
        openSettings();
        return;
      }
      const providers = await loadProviders();
      const provider = providers.find((p) => p.id === settings.provider) ?? providers[0];
      if (provider.keyRequired) {
        let hasKey = provider.key.hasKey;
        try {
          hasKey = (await aiApi.keyStatus(provider.id)).hasKey;
        } catch {
          // Use what the provider list said.
        }
        if (!hasKey) {
          toast(`Add a ${provider.label} API key to use the AI helper.`, "info");
          openSettings();
          return;
        }
      }
      const result = useCompile.getState().result;
      const noticeNeeded = !settings.noticeAccepted.includes(provider.id);
      set({ provider, model: null, progress: null, texts: {}, preview: null });
      dispatch({ type: "open", scope, result, noticeNeeded });
      if (!noticeNeeded) await get().ask();
    },

    loadPreview: async () => {
      const path = useWorkspace.getState().project?.path;
      const result = useCompile.getState().result;
      if (!path || !result) return;
      const { scope } = get();
      try {
        await useWorkspace.getState().saveAll();
        const focus = scope.kind === "issue" ? result.issues.indexOf(scope.issue) : -1;
        set({ preview: await aiApi.previewContext(path, compileInput(result), focus >= 0 ? focus : null) });
      } catch (err) {
        toast(toAiError(err).message, "error");
      }
    },

    acceptNotice: async () => {
      const provider = get().provider;
      if (!provider) return;
      try {
        await useAiSettings.getState().update({ acceptNotice: provider.id });
      } catch (err) {
        toast(toAiError(err).message, "error");
        return;
      }
      dispatch({ type: "noticeAccepted" });
      await get().ask();
    },

    ask: async () => {
      const { scope, attempts } = get();
      const path = useWorkspace.getState().project?.path;
      const result = useCompile.getState().result;
      dispatch({ type: "ask" });
      if (get().phase.kind !== "asking") return;
      const requestId = newRequestId();
      currentRequest = requestId;
      set({ progress: null });
      const fail = (error: AiError) => {
        if (currentRequest !== requestId) return;
        endRequest();
        dispatch({ type: "failed", error });
      };
      if (!path) return fail(plainError("other", "Open a project first."));
      if (!result) return fail(plainError("other", "Compile the project first, so there's something to explain."));
      try {
        stopProgress?.();
        const unlisten = await listen<AiProgress>(AI_PROGRESS_EVENT, (e) => {
          if (e.payload.requestId === currentRequest) set({ progress: e.payload.message });
        });
        stopProgress = unlisten;
        // The backend reads the files from disk, so it must see the latest edits.
        await useWorkspace.getState().saveAll();
        if (currentRequest !== requestId) return;
        const focus = scope.kind === "issue" ? result.issues.indexOf(scope.issue) : -1;
        const answer = await aiApi.explainAndFix(path, {
          requestId,
          compile: compileInput(result),
          focus: focus >= 0 ? focus : null,
          previous: previousAttempts(attempts),
        });
        if (currentRequest !== requestId) return;
        const proposal = normalizeProposal(answer);
        if (!proposal.summary && !proposal.steps.length && !proposal.edits.length && !proposal.envActions.length) {
          return fail(plainError("badAnswer"));
        }
        // The files may have changed while the AI was thinking.
        const { texts, problems } = await checkLocally(proposal.edits);
        if (currentRequest !== requestId) return;
        endRequest();
        set({ texts, model: proposal.model || null });
        dispatch({ type: "answer", proposal, problems });
      } catch (err) {
        fail(toAiError(err));
      }
    },

    cancel: async () => {
      const id = currentRequest;
      endRequest();
      dispatch({ type: "cancelled" });
      if (id) await aiApi.cancel(id).catch(() => {});
    },

    toggle: (index) => dispatch({ type: "toggle", index }),
    setAll: (decision) => dispatch({ type: "setAll", decision }),

    apply: async () => {
      const phase = get().phase;
      if (phase.kind !== "proposal") return;
      const edits = acceptedEdits(phase);
      if (!edits.length) return;
      const path = useWorkspace.getState().project?.path;
      if (!path) return;
      const indexOf = (e: ProposedEdit) => phase.proposal.edits.indexOf(e);
      const files = [...new Set(edits.map((e) => e.file))];
      const stale: (string | null)[] = phase.proposal.edits.map(() => null);

      // Load every file first, so a failure leaves nothing half applied.
      const ws = useWorkspace.getState();
      for (const file of files) if (!getModel(file)) await ws.openFile(file);
      const buffers: Record<string, string> = {};
      for (const file of files) {
        const model = getModel(file);
        if (model) buffers[file] = model.getValue();
        else for (const e of edits.filter((x) => x.file === file)) stale[indexOf(e)] = `Texo couldn't open ${file}.`;
      }

      // The backend checks again (inside the project, a text file, found exactly once).
      try {
        const checked = await aiApi.checkEdits(path, edits, buffers);
        checked.forEach((c, i) => {
          if (!c.ok) stale[indexOf(edits[i])] ??= c.reason ?? "Texo can't apply this change.";
        });
      } catch (err) {
        toast(toAiError(err).message, "error");
        return;
      }

      const plans: { file: string; placed: ReturnType<typeof placeEdits>["placed"] }[] = [];
      for (const file of files) {
        if (buffers[file] === undefined) continue;
        const forFile = edits.filter((e) => e.file === file);
        const { placed, failed } = placeEdits(buffers[file], forFile);
        for (const f of failed) stale[indexOf(forFile[f.index])] ??= f.reason;
        plans.push({ file, placed });
      }
      if (stale.some(Boolean)) {
        // The files changed since the AI looked: show which edits no longer fit and let the user decide.
        set({ texts: { ...get().texts, ...buffers } });
        dispatch({ type: "stale", problems: stale });
        toast("Some changes no longer fit the file. Review them and apply again.", "info");
        return;
      }

      dispatch({ type: "applying" });
      const startedAt = Date.now();
      try {
        for (const { file, placed } of plans) {
          const model = getModel(file)!;
          const ops = placed.map((p) => {
            const from = model.getPositionAt(p.start);
            const to = model.getPositionAt(p.end);
            return {
              range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column },
              text: p.text,
            };
          });
          // One undo step per file: Ctrl+Z in that file takes back the whole fix.
          model.pushStackElement();
          model.pushEditOperations([], ops, () => null);
          model.pushStackElement();
        }
        await Promise.all(files.map((f) => useWorkspace.getState().save(f)));
      } catch (err) {
        dispatch({ type: "failed", error: toAiError(err) });
        return;
      }
      dispatch({ type: "recompiling", applied: edits, summary: phase.proposal.summary });
      void useCompile.getState().compile();
      const result = await nextCompile(startedAt);
      if (get().phase.kind !== "recompiling") return;
      if (result) dispatch({ type: "compiled", result });
      else dispatch({ type: "failed", error: plainError("other", "The changes were applied, but Texo couldn't compile again. Press Compile to try.") });
    },

    retry: async () => {
      dispatch({ type: "retry" });
      if (get().phase.kind === "idle") await get().ask();
    },

    close: () => {
      const id = currentRequest;
      endRequest();
      if (id) void aiApi.cancel(id).catch(() => {});
      set({ ...initialFixState, provider: null, model: null, progress: null, texts: {}, preview: null });
    },
  };
});

/** Opens the fixer for one issue. */
export function explainIssue(issue: Issue) {
  void useFix.getState().start({ kind: "issue", issue });
}

/** Opens the fixer for every error of the last compile. */
export function fixAllErrors() {
  void useFix.getState().start({ kind: "all" });
}
