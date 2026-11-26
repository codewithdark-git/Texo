// State for the History panel and the status bar item: the project's history
// status, the timeline (paged), the filter and each version's changed files.
// Restores and undo save open editors first, then reload the files they wrote.

import { create } from "zustand";
import { errorText } from "../lib/api";
import {
  historyApi,
  type HistoryAuthorFilter,
  type HistoryEntry,
  type HistoryFileChange,
  type HistoryRestoreResult,
  type HistoryStatus,
  type HistoryUndoResult,
} from "../lib/historyApi";
import { toast } from "../ui";
import { useWorkspace } from "../workspace/store";
import { restoreSummary, undoOutcome } from "./historyLogic";

export const PAGE_SIZE = 200;

interface HistoryStore {
  project: string | null;
  status: HistoryStatus | null;
  entries: HistoryEntry[];
  /** More versions exist past the last loaded page. */
  more: boolean;
  author: HistoryAuthorFilter;
  /** "History of this file": only versions that changed this path, or null for all. */
  path: string | null;
  loading: boolean;
  error: string | null;
  /** Changed files per commit, loaded when a version is opened. */
  changes: Record<string, HistoryFileChange[] | "loading" | { error: string }>;
  /** Set while a restore / undo / label is running. */
  busy: boolean;

  /** Switches to a project (or none) and loads its status. */
  setProject: (project: string | null) => void;
  refreshStatus: () => Promise<void>;
  /** Reloads the first page of the timeline. */
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  setAuthor: (author: HistoryAuthorFilter) => void;
  setPath: (path: string | null) => void;
  loadChanges: (commit: string) => Promise<void>;
  snapshot: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  answerGitExclude: (add: boolean) => Promise<void>;
  restoreFile: (commit: string, file: string) => Promise<void>;
  restoreAll: (commit: string) => Promise<void>;
  undoRun: (runId: string) => Promise<HistoryUndoResult | null>;
  label: (commit: string, name: string) => Promise<void>;
}

/** Saves editor buffers so a restore doesn't fight unsaved text. */
async function saveEditors() {
  await useWorkspace.getState().saveAll();
}

async function reloadEditors(r: Pick<HistoryRestoreResult, "written" | "deleted">) {
  const paths = [...r.written, ...r.deleted];
  if (paths.length) await useWorkspace.getState().reloadFromDisk(paths);
}

export const useHistory = create<HistoryStore>((set, get) => {
  /** Ignores answers for a project that is no longer open. */
  const current = (project: string) => get().project === project;

  const afterChange = async () => {
    await Promise.all([get().refreshStatus(), get().load()]);
  };

  return {
    project: null,
    status: null,
    entries: [],
    more: false,
    author: "all",
    path: null,
    loading: false,
    error: null,
    changes: {},
    busy: false,

    setProject: (project) => {
      if (get().project === project) return;
      set({ project, status: null, entries: [], more: false, path: null, error: null, changes: {}, busy: false });
      if (project) void get().refreshStatus();
    },

    refreshStatus: async () => {
      const project = get().project;
      if (!project) return;
      try {
        const status = await historyApi.status(project);
        if (!current(project)) return;
        set({ status });
        if (status.notice) toast(status.notice, "info");
      } catch (err) {
        if (current(project)) set({ status: null, error: errorText(err) });
      }
    },

    load: async () => {
      const { project, author, path } = get();
      if (!project) return;
      set({ loading: true, error: null });
      try {
        const entries = await historyApi.log(project, { author, path, limit: PAGE_SIZE });
        if (!current(project) || get().author !== author || get().path !== path) return;
        set({ entries, more: entries.length >= PAGE_SIZE, loading: false });
      } catch (err) {
        if (current(project)) set({ loading: false, error: errorText(err) });
      }
    },

    loadMore: async () => {
      const { project, author, path, entries, loading } = get();
      const last = entries[entries.length - 1];
      if (!project || !last || loading) return;
      set({ loading: true });
      try {
        const page = await historyApi.log(project, { author, path, before: last.id, limit: PAGE_SIZE });
        if (!current(project) || get().author !== author || get().path !== path) return;
        const seen = new Set(get().entries.map((e) => e.id));
        set({ entries: [...get().entries, ...page.filter((e) => !seen.has(e.id))], more: page.length >= PAGE_SIZE, loading: false });
      } catch (err) {
        if (current(project)) set({ loading: false, error: errorText(err) });
      }
    },

    setAuthor: (author) => {
      if (get().author === author) return;
      set({ author, entries: [], more: false });
      void get().load();
    },

    setPath: (path) => {
      if (get().path === path) return;
      set({ path, entries: [], more: false });
      void get().load();
    },

    loadChanges: async (commit) => {
      const project = get().project;
      const have = get().changes[commit];
      // Loaded or loading already; a failed load is tried again.
      if (!project || have === "loading" || Array.isArray(have)) return;
      set((s) => ({ changes: { ...s.changes, [commit]: "loading" } }));
      try {
        const files = await historyApi.changes(project, commit);
        if (current(project)) set((s) => ({ changes: { ...s.changes, [commit]: files } }));
      } catch (err) {
        if (current(project)) set((s) => ({ changes: { ...s.changes, [commit]: { error: errorText(err) } } }));
      }
    },

    snapshot: async () => {
      const project = get().project;
      if (!project) return;
      try {
        await saveEditors();
        const id = await historyApi.snapshot(project);
        toast(id ? "Saved a version of your project." : "Nothing changed since the last version.", id ? "success" : "info");
        await afterChange();
      } catch (err) {
        toast(errorText(err), "error");
      }
    },

    setEnabled: async (enabled) => {
      const project = get().project;
      if (!project) return;
      try {
        const status = await historyApi.setEnabled(project, enabled);
        if (!current(project)) return;
        set({ status });
        toast(enabled ? "History is on for this project." : "History is off for this project. Earlier versions are kept.", "info");
        if (enabled) await get().load();
      } catch (err) {
        toast(errorText(err), "error");
      }
    },

    answerGitExclude: async (add) => {
      const project = get().project;
      if (!project) return;
      try {
        const status = await historyApi.gitExclude(project, add);
        if (current(project)) set({ status });
        if (add) toast("Git will now ignore Texo's .texo folder in this project.", "success");
      } catch (err) {
        toast(errorText(err), "error");
      }
    },

    restoreFile: async (commit, file) => {
      const project = get().project;
      if (!project || get().busy) return;
      set({ busy: true });
      try {
        await saveEditors();
        const r = await historyApi.restoreFile(project, commit, file);
        await reloadEditors(r);
        toast(r.failed.length ? restoreSummary(r) : r.commit ? `Restored ${file}. The text it replaced is kept in history.` : restoreSummary(r), r.failed.length ? "error" : "success");
        await afterChange();
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        set({ busy: false });
      }
    },

    restoreAll: async (commit) => {
      const project = get().project;
      if (!project || get().busy) return;
      set({ busy: true });
      try {
        await saveEditors();
        const r = await historyApi.restoreAll(project, commit);
        await reloadEditors(r);
        toast(restoreSummary(r), r.failed.length ? "error" : "success");
        await afterChange();
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        set({ busy: false });
      }
    },

    undoRun: async (runId) => {
      const project = get().project;
      if (!project || get().busy) return null;
      set({ busy: true });
      try {
        await saveEditors();
        const r = await historyApi.undoRun(project, runId);
        await reloadEditors(r);
        // A partial undo is shown in a dialog by the panel, listing each file.
        const outcome = undoOutcome(r);
        if (outcome.tone === "success") toast(outcome.text, "success");
        await afterChange();
        return r;
      } catch (err) {
        toast(errorText(err), "error");
        return null;
      } finally {
        set({ busy: false });
      }
    },

    label: async (commit, name) => {
      const project = get().project;
      if (!project) return;
      try {
        await historyApi.label(project, commit, name);
        toast(`Labelled this version “${name}”.`, "success");
        await get().load();
      } catch (err) {
        toast(errorText(err), "error");
      }
    },
  };
});
