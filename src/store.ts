import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  ENGINE_SETUP_EVENT,
  errorText,
  type EngineStatus,
  type ProjectSummary,
  type Settings,
  type Template,
} from "./lib/api";
import type { SortDir, SortKey } from "./lib/projects";

export type ViewMode = "list" | "grid";

interface Prefs {
  viewMode: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
}

const PREFS_KEY = "texo.dashboard";
const defaultPrefs: Prefs = { viewMode: "list", sortKey: "lastEdited", sortDir: "desc" };

function loadPrefs(): Prefs {
  try {
    return { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return defaultPrefs;
  }
}

function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are a convenience; ignore storage failures.
  }
}

interface AppStore extends Prefs {
  settings: Settings | null;
  projects: ProjectSummary[];
  loading: boolean;
  error: string | null;
  query: string;
  openProject: ProjectSummary | null;
  engine: EngineStatus | null;
  /** First-run engine setup: running, with its latest progress line. */
  engineSetup: { running: boolean; line: string; error: string | null };

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setQuery: (query: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setSort: (key: SortKey) => void;
  dismissError: () => void;
  open: (project: ProjectSummary | null) => void;

  createProject: (name: string, template: Template) => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  rename: (project: ProjectSummary, name: string) => Promise<void>;
  duplicate: (project: ProjectSummary) => Promise<void>;
  remove: (project: ProjectSummary) => Promise<void>;
  forget: (project: ProjectSummary) => Promise<void>;
  setProjectsRoot: (path: string) => Promise<void>;
  checkEngine: () => Promise<void>;
}

export const useApp = create<AppStore>((set, get) => {
  /** Runs a command, reports its error, and reloads the project list. */
  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await fn();
      await get().refresh();
      return result;
    } catch (err) {
      set({ error: errorText(err) });
      return undefined;
    }
  }

  function updatePrefs(patch: Partial<Prefs>) {
    set(patch);
    const { viewMode, sortKey, sortDir } = get();
    savePrefs({ viewMode, sortKey, sortDir });
  }

  return {
    ...loadPrefs(),
    settings: null,
    projects: [],
    loading: true,
    error: null,
    query: "",
    openProject: null,
    engine: null,
    engineSetup: { running: false, line: "", error: null },

    checkEngine: async () => {
      try {
        const engine = await api.engineStatus();
        set({ engine });
        if (engine.ready || get().engineSetup.running) return;
        // First run with the built-in engine: download the common LaTeX
        // packages now, so the first real compile is quick.
        set({ engineSetup: { running: true, line: "Starting…", error: null } });
        const unlisten = await listen<string[]>(ENGINE_SETUP_EVENT, (e) => {
          // Tectonic prints a harmless fontconfig complaint on Windows; skip it.
          const line = e.payload
            .map((l) => l.trim().replace(/^note:\s*/, ""))
            .filter((l) => l && !l.startsWith("Fontconfig") && !l.startsWith("$ "))
            .pop();
          if (line) set((s) => ({ engineSetup: { ...s.engineSetup, line } }));
        });
        try {
          await api.prepareEngine();
          set({ engine: { ...engine, ready: true }, engineSetup: { running: false, line: "", error: null } });
        } catch (err) {
          set({ engineSetup: { running: false, line: "", error: errorText(err) } });
        } finally {
          unlisten();
        }
      } catch {
        // Status is informational; compiling reports its own problems.
      }
    },

    load: async () => {
      try {
        const settings = await api.getSettings();
        set({ settings });
        await get().refresh();
        void get().checkEngine();
      } catch (err) {
        set({ error: errorText(err) });
      } finally {
        set({ loading: false });
      }
    },

    refresh: async () => {
      const projects = await api.listProjects();
      set({ projects });
    },

    setQuery: (query) => set({ query }),
    setViewMode: (viewMode) => updatePrefs({ viewMode }),
    setSort: (key) => {
      const { sortKey, sortDir } = get();
      if (key === sortKey) {
        updatePrefs({ sortDir: sortDir === "asc" ? "desc" : "asc" });
      } else {
        updatePrefs({ sortKey: key, sortDir: key === "name" ? "asc" : "desc" });
      }
    },
    dismissError: () => set({ error: null }),
    open: (openProject) => set({ openProject }),

    createProject: async (name, template) => {
      const created = await act(() => api.createProject(name, template));
      if (created) set({ openProject: created });
    },
    openFolder: async (path) => {
      const opened = await act(() => api.openFolder(path));
      if (opened) set({ openProject: opened });
    },
    rename: async (project, name) => {
      await act(() => api.renameProject(project.path, name));
    },
    duplicate: async (project) => {
      await act(() => api.duplicateProject(project.path));
    },
    remove: async (project) => {
      await act(() => api.deleteProject(project.path));
    },
    forget: async (project) => {
      await act(() => api.forgetProject(project.path));
    },
    setProjectsRoot: async (path) => {
      const settings = await act(() => api.setProjectsRoot(path));
      if (settings) set({ settings });
    },
  };
});
