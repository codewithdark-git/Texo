import { create } from "zustand";
import { api, errorText, type ProjectSummary, type Settings, type Template } from "./lib/api";
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

    load: async () => {
      try {
        const settings = await api.getSettings();
        set({ settings });
        await get().refresh();
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
