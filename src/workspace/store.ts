import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  errorText,
  FS_CHANGED_EVENT,
  SHOW_PDF_EVENT,
  type FileEntry,
  type FsChanged,
  type ProjectSummary,
  type Symbols,
} from "../lib/api";
import { completionSource } from "../editor/completions";
import { languageFor, monaco } from "../editor/monaco";
import { baseName, isWithin, joinPath, parentDir, rebase } from "./paths";
import { toast } from "../ui";

const AUTOSAVE_MS = 800;

export type FileView =
  | { kind: "loading" }
  | { kind: "text" }
  | { kind: "image"; dataUrl: string; size: number }
  | { kind: "tooLarge"; size: number }
  | { kind: "binary"; size: number }
  | { kind: "error"; message: string };

export interface FileStatus {
  dirty: boolean;
  /** Changed on disk while there were unsaved edits here. */
  conflict: boolean;
}

interface WorkspaceStore {
  project: ProjectSummary | null;
  files: FileEntry[];
  tabs: string[];
  active: string | null;
  views: Record<string, FileView>;
  status: Record<string, FileStatus>;
  expanded: Record<string, boolean>;
  saving: number;
  error: string | null;
  cursor: { line: number; column: number } | null;

  init: (project: ProjectSummary) => Promise<void>;
  teardown: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => Promise<void>;
  save: (path: string) => Promise<void>;
  saveAll: () => Promise<void>;
  resolveConflict: (path: string, keep: "mine" | "disk") => Promise<void>;
  createFile: (dir: string, name: string) => Promise<void>;
  createFolder: (dir: string, name: string) => Promise<void>;
  renamePath: (from: string, to: string) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  setMainDocument: (path: string) => Promise<void>;
  importFiles: (dest: string, sources: string[]) => Promise<void>;
  toggleDir: (path: string) => void;
  expandTo: (path: string) => void;
  collapseAll: () => void;
  setCursor: (cursor: { line: number; column: number } | null) => void;
  setError: (error: string | null) => void;
}

// Monaco models and save bookkeeping live outside React state.
const models = new Map<string, monaco.editor.ITextModel>();
const savedVersion = new Map<string, number>();
const lastWritten = new Map<string, string>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let unlisten: UnlistenFn | null = null;
let symbolsTimer: ReturnType<typeof setTimeout> | undefined;
let filesTimer: ReturnType<typeof setTimeout> | undefined;

// Open tabs, the active file, and cursors are remembered per project, so
// reopening a project picks up where you left off.
interface SavedSession {
  tabs: string[];
  active: string | null;
  cursors: Record<string, { line: number; column: number }>;
}

const sessionKey = (projectId: string) => `texo.session.${projectId}`;
let savedCursors: SavedSession["cursors"] = {};
let sessionTimer: ReturnType<typeof setTimeout> | undefined;
/** True once the open project has restored its tabs; until then nothing is saved. */
let sessionReady = false;
let initToken = 0;

function loadSession(projectId: string): SavedSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(projectId));
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}

/** Where the cursor was in `path` last time, if the editor hasn't shown it yet this session. */
export function savedCursor(path: string) {
  return savedCursors[path];
}

/** Called after a file is saved or the project's files change (compile on save). */
let afterChange: ((path: string) => void) | null = null;

export function onProjectChanged(fn: ((path: string) => void) | null) {
  afterChange = fn;
}

export function getModel(path: string): monaco.editor.ITextModel | undefined {
  return models.get(path);
}

const uriFor = (path: string) => monaco.Uri.from({ scheme: "texo", path: `/${path}` });
const isSymbolSource = (path: string) => /\.(tex|bib|sty|cls)$/i.test(path);

function omit<T>(record: Record<string, T>, drop: (key: string) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !drop(k)));
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  const projectPath = () => get().project?.path ?? "";

  const fail = (err: unknown) => set({ error: errorText(err) });

  /** Saves and releases the open project (shared by init and teardown). */
  async function closeProject() {
    if (!get().project) return;
    clearTimeout(sessionTimer);
    // Only a fully opened project has a session worth saving.
    if (sessionReady) saveSession();
    sessionReady = false;
    await get().saveAll();
    unlisten?.();
    unlisten = null;
    await api.unwatchProject().catch(() => {});
    for (const path of [...models.keys()]) disposeModel(path);
    completionSource.symbols = { labels: [], citations: [], commands: [] };
    completionSource.files = [];
    set({ project: null, files: [], tabs: [], active: null, views: {}, status: {}, cursor: null });
  }

  function saveSession() {
    const { project, tabs, active } = get();
    if (!project) return;
    const cursors = Object.fromEntries(Object.entries(savedCursors).filter(([p]) => tabs.includes(p)));
    try {
      localStorage.setItem(sessionKey(project.id), JSON.stringify({ tabs, active, cursors } satisfies SavedSession));
    } catch {
      // Not worth bothering the user about.
    }
  }

  function scheduleSession() {
    if (!sessionReady) return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(saveSession, 500);
  }

  function setStatus(path: string, patch: Partial<FileStatus>) {
    set((s) => ({
      status: { ...s.status, [path]: { ...(s.status[path] ?? { dirty: false, conflict: false }), ...patch } },
    }));
  }

  function isDirty(path: string): boolean {
    const model = models.get(path);
    return !!model && model.getAlternativeVersionId() !== savedVersion.get(path);
  }

  function scheduleSave(path: string) {
    clearTimeout(saveTimers.get(path));
    saveTimers.set(
      path,
      setTimeout(() => void get().save(path), AUTOSAVE_MS),
    );
  }

  function createModel(path: string, text: string, dirty = false) {
    const model = monaco.editor.createModel(text, languageFor(path), uriFor(path));
    models.set(path, model);
    savedVersion.set(path, dirty ? -1 : model.getAlternativeVersionId());
    model.onDidChangeContent(() => {
      const dirtyNow = isDirty(path);
      setStatus(path, { dirty: dirtyNow });
      if (dirtyNow && !get().status[path]?.conflict) scheduleSave(path);
    });
    setStatus(path, { dirty, conflict: false });
    if (dirty) scheduleSave(path);
    return model;
  }

  function disposeModel(path: string) {
    clearTimeout(saveTimers.get(path));
    saveTimers.delete(path);
    models.get(path)?.dispose();
    models.delete(path);
    savedVersion.delete(path);
    lastWritten.delete(path);
  }

  /** Replaces the editor text with the disk version, keeping undo history. */
  function applyDiskVersion(path: string, text: string) {
    const model = models.get(path);
    if (!model) return;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    savedVersion.set(path, model.getAlternativeVersionId());
    setStatus(path, { dirty: false, conflict: false });
  }

  function scheduleSymbols() {
    clearTimeout(symbolsTimer);
    symbolsTimer = setTimeout(async () => {
      const path = projectPath();
      if (!path) return;
      try {
        const symbols: Symbols = await api.projectSymbols(path);
        completionSource.symbols = symbols;
      } catch {
        // Completions just stay as they were.
      }
    }, 400);
  }

  function dropTabs(remove: (path: string) => boolean) {
    for (const path of [...models.keys()]) if (remove(path)) disposeModel(path);
    set((s) => {
      const tabs = s.tabs.filter((t) => !remove(t));
      let active = s.active;
      if (active && remove(active)) {
        const i = s.tabs.indexOf(active);
        active = tabs[Math.min(i, tabs.length - 1)] ?? null;
      }
      return {
        tabs,
        active,
        views: omit(s.views, remove),
        status: omit(s.status, remove),
      };
    });
  }

  async function onDiskChange(paths: string[]) {
    clearTimeout(filesTimer);
    filesTimer = setTimeout(() => void get().refreshFiles().catch(fail), 150);
    if (paths.some(isSymbolSource)) scheduleSymbols();

    for (const path of paths) {
      const model = models.get(path);
      if (!model) continue;
      let disk: string;
      try {
        const content = await api.readFile(projectPath(), path);
        if (content.kind !== "text") continue;
        disk = content.content;
      } catch {
        continue; // Deleted; refreshFiles closes the tab if it's clean.
      }
      if (disk === model.getValue() || disk === lastWritten.get(path)) continue;
      if (isDirty(path)) {
        clearTimeout(saveTimers.get(path));
        setStatus(path, { conflict: true });
      } else {
        applyDiskVersion(path, disk);
      }
    }
  }

  return {
    project: null,
    files: [],
    tabs: [],
    active: null,
    views: {},
    status: {},
    expanded: {},
    saving: 0,
    error: null,
    cursor: null,

    init: async (project) => {
      // A newer init (or a teardown) makes this one stale: stop as soon as we notice.
      const token = ++initToken;
      const stale = () => token !== initToken;
      // Read the saved session before anything can overwrite it.
      const session = loadSession(project.id);
      await closeProject();
      if (stale()) return;
      set({ project, files: [], tabs: [], active: null, views: {}, status: {}, expanded: {}, error: null });
      try {
        await get().refreshFiles();
        if (stale()) return;
        unlisten = await listen<FsChanged>(FS_CHANGED_EVENT, (e) => {
          if (e.payload.project === get().project?.path) void onDiskChange(e.payload.paths);
        });
        await api.watchProject(project.path);
      } catch (err) {
        fail(err);
      }
      if (stale()) return;
      scheduleSymbols();
      const exists = (p: string) => get().files.some((f) => f.path === p && !f.isDir);
      savedCursors = session?.cursors ?? {};
      const reopen = (session?.tabs ?? []).filter((p) => exists(p) && p !== project.outputPdf);
      const main = project.mainDocument;
      if (reopen.length === 0 && main && exists(main)) reopen.push(main);
      for (const path of reopen) {
        get().expandTo(path);
        await get().openFile(path);
        if (stale()) return;
      }
      const active = session?.active;
      if (active && reopen.includes(active)) await get().openFile(active);
      if (!stale()) sessionReady = true;
    },

    teardown: async () => {
      initToken++; // cancels an init that's still opening files
      await closeProject();
    },

    refreshFiles: async () => {
      const path = projectPath();
      if (!path) return;
      const files = await api.listProjectFiles(path);
      const present = new Set(files.map((f) => f.path));
      completionSource.files = files.filter((f) => !f.isDir).map((f) => f.path);
      set({ files });
      // Close tabs for files deleted outside Texo, unless they have unsaved edits.
      dropTabs((p) => !present.has(p) && !isDirty(p));
    },

    openFile: async (path) => {
      // The saved PDF opens in the preview rather than as an editor tab.
      if (path === get().project?.outputPdf) {
        window.dispatchEvent(new Event(SHOW_PDF_EVENT));
        return;
      }
      set((s) => ({ tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path], active: path }));
      const existing = get().views[path];
      if (existing && existing.kind !== "error") return;
      set((s) => ({ views: { ...s.views, [path]: { kind: "loading" } } }));
      try {
        const content = await api.readFile(projectPath(), path);
        if (content.kind === "text") {
          if (!models.has(path)) createModel(path, content.content);
          set((s) => ({ views: { ...s.views, [path]: { kind: "text" } } }));
        } else {
          set((s) => ({ views: { ...s.views, [path]: content } }));
        }
      } catch (err) {
        set((s) => ({ views: { ...s.views, [path]: { kind: "error", message: errorText(err) } } }));
      }
    },

    closeTab: async (path) => {
      if (isDirty(path) && !get().status[path]?.conflict) await get().save(path);
      dropTabs((p) => p === path);
    },

    save: async (path) => {
      clearTimeout(saveTimers.get(path));
      const model = models.get(path);
      if (!model || !isDirty(path)) return;
      const version = model.getAlternativeVersionId();
      const text = model.getValue();
      set((s) => ({ saving: s.saving + 1 }));
      try {
        lastWritten.set(path, text);
        await api.writeFile(projectPath(), path, text);
        savedVersion.set(path, version);
        setStatus(path, { dirty: isDirty(path), conflict: false });
        if (isSymbolSource(path)) scheduleSymbols();
        afterChange?.(path);
      } catch (err) {
        fail(err);
      } finally {
        set((s) => ({ saving: s.saving - 1 }));
      }
    },

    saveAll: async () => {
      const dirty = [...models.keys()].filter((p) => isDirty(p) && !get().status[p]?.conflict);
      await Promise.all(dirty.map((p) => get().save(p)));
    },

    resolveConflict: async (path, keep) => {
      if (keep === "mine") {
        setStatus(path, { conflict: false });
        await get().save(path);
        return;
      }
      try {
        const content = await api.readFile(projectPath(), path);
        if (content.kind === "text") applyDiskVersion(path, content.content);
      } catch (err) {
        fail(err);
      }
    },

    createFile: async (dir, name) => {
      const path = joinPath(dir, name);
      try {
        await api.createFile(projectPath(), path);
        await get().refreshFiles();
        get().expandTo(path);
        await get().openFile(path);
      } catch (err) {
        fail(err);
      }
    },

    createFolder: async (dir, name) => {
      const path = joinPath(dir, name);
      try {
        await api.createFolder(projectPath(), path);
        await get().refreshFiles();
        get().expandTo(joinPath(path, "x"));
      } catch (err) {
        fail(err);
      }
    },

    renamePath: async (from, to) => {
      if (from === to) return;
      const affected = [...models.keys()].filter((p) => isWithin(p, from));
      try {
        await Promise.all(affected.map((p) => get().save(p)));
        await api.renamePath(projectPath(), from, to);
        // Monaco models can't change their URI, so recreate them at the new path.
        for (const old of affected) {
          const text = models.get(old)!.getValue();
          const dirty = isDirty(old);
          disposeModel(old);
          createModel(rebase(old, from, to), text, dirty);
        }
        const move = (p: string) => (isWithin(p, from) ? rebase(p, from, to) : p);
        const moveKeys = <T,>(r: Record<string, T>) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [move(k), v]));
        set((s) => ({
          tabs: s.tabs.map(move),
          active: s.active && move(s.active),
          views: moveKeys(s.views),
          status: moveKeys(s.status),
          expanded: moveKeys(s.expanded),
        }));
        const main = get().project?.mainDocument;
        if (main && isWithin(main, from)) {
          set({ project: await api.setMainDocument(projectPath(), rebase(main, from, to)) });
        }
        await get().refreshFiles();
        get().expandTo(to);
        afterChange?.(to);
      } catch (err) {
        fail(err);
        await get().refreshFiles().catch(() => {});
      }
    },

    deletePath: async (path) => {
      try {
        dropTabs((p) => isWithin(p, path));
        await api.deletePath(projectPath(), path);
        await get().refreshFiles();
        toast(`Moved “${baseName(path)}” to the Recycle Bin`);
        afterChange?.(path);
      } catch (err) {
        fail(err);
      }
    },

    setMainDocument: async (path) => {
      try {
        set({ project: await api.setMainDocument(projectPath(), path) });
        toast(`“${baseName(path)}” is now the main document`);
        afterChange?.(path);
      } catch (err) {
        fail(err);
      }
    },

    importFiles: async (dest, sources) => {
      if (sources.length === 0) return;
      try {
        const added = await api.importFiles(projectPath(), dest, sources);
        await get().refreshFiles();
        if (dest) get().expandTo(joinPath(dest, "x"));
        if (added.some(isSymbolSource)) scheduleSymbols();
        if (added.length) toast(added.length === 1 ? `Added “${baseName(added[0])}”` : `Added ${added.length} files`);
        added.forEach((p) => afterChange?.(p));
      } catch (err) {
        fail(err);
      }
    },

    toggleDir: (path) => set((s) => ({ expanded: { ...s.expanded, [path]: !s.expanded[path] } })),

    expandTo: (path) =>
      set((s) => {
        const expanded = { ...s.expanded };
        for (let dir = parentDir(path); dir; dir = parentDir(dir)) expanded[dir] = true;
        return { expanded };
      }),

    collapseAll: () => set({ expanded: {} }),
    setCursor: (cursor) => {
      set({ cursor });
      const active = get().active;
      if (cursor && active) savedCursors[active] = cursor;
      scheduleSession();
    },
    setError: (error) => set({ error }),
  };
});

// Remember tabs whenever they change.
useWorkspace.subscribe((state, prev) => {
  if (sessionReady && state.project && (state.tabs !== prev.tabs || state.active !== prev.active)) {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      const { project, tabs, active } = useWorkspace.getState();
      if (!project) return;
      const cursors = Object.fromEntries(Object.entries(savedCursors).filter(([p]) => tabs.includes(p)));
      try {
        localStorage.setItem(sessionKey(project.id), JSON.stringify({ tabs, active, cursors }));
      } catch {
        // Not worth bothering the user about.
      }
    }, 500);
  }
});
