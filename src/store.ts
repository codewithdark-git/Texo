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
import { copyFolderToProjects, isMissing, needsMainChoice, readOnlyMessage } from "./lib/openProject";
import type { SortDir, SortKey } from "./lib/projects";
import { toast, trashName } from "./ui";

/**
 * Makes sure a just-imported project gets its first compile. The workspace
 * compiles on open when auto-compile is on; with it off, this compiles once,
 * as soon as the workspace has finished opening that project.
 */
async function compileOnceOpened(path: string) {
  const [{ useCompile }, { useWorkspace }] = await Promise.all([
    import("./workspace/compileStore"),
    import("./workspace/store"),
  ]);
  const stop = useCompile.subscribe((s, prev) => {
    // Opening ends with the toolchain check, which replaces `toolchains`.
    if (s.toolchains === prev.toolchains || useWorkspace.getState().project?.path !== path) return;
    stop();
    clearTimeout(timer);
    if (!s.auto && !s.compiling && !s.result) void s.compile();
  });
  const timer = setTimeout(stop, 30_000);
}

export type ViewMode = "list" | "grid";

/** A question the open flow needs answered (rendered by OpenFlowDialogs). */
export type OpenPrompt =
  /** Texo can't write its files there; offer an editable copy. */
  | { kind: "readOnly"; path: string; message: string }
  /** Several files could be the main document; let the user pick in one click. */
  | { kind: "chooseMain"; project: ProjectSummary }
  /** A listed folder can't be found; offer to find it or remove it from the list. */
  | { kind: "missing"; project: ProjectSummary };

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
  /** Something calm to tell the user (not an error), e.g. settings restored. */
  notice: string | null;
  openPrompt: OpenPrompt | null;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setQuery: (query: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setSort: (key: SortKey) => void;
  dismissError: () => void;
  dismissNotice: () => void;
  closeOpenPrompt: () => void;
  /** Opens a project; a missing folder asks what to do instead. */
  open: (project: ProjectSummary | null) => void;

  /** Creates a project from a template and opens it; false if it failed. */
  createProject: (name: string, template: Template) => Promise<boolean>;
  /** Opens a folder or a .tex file; true if a project opened. */
  openFolder: (path: string) => Promise<boolean>;
  /** Copies a read-only folder into the projects folder and opens the copy. */
  copyToProjects: (path: string) => Promise<void>;
  /** Re-points a missing project at the folder the user found. */
  relocate: (missing: ProjectSummary, path: string) => Promise<void>;
  /** Imports a .zip or .tar.gz as a new project and opens it. */
  importProject: (archivePath: string, name: string, main: string | null) => Promise<boolean>;
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
    notice: null,
    openPrompt: null,

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
        set({ settings, notice: settings.notice ?? null });
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
    dismissNotice: () => set({ notice: null }),
    closeOpenPrompt: () => set({ openPrompt: null }),
    open: (openProject) => {
      if (openProject && isMissing(openProject)) set({ openPrompt: { kind: "missing", project: openProject } });
      // No readable project info: open the folder again, which sets it up.
      else if (openProject?.needsSetup) void get().openFolder(openProject.path);
      else set({ openProject });
    },

    createProject: async (name, template) => {
      const created = await act(() => api.createProject(name, template));
      if (!created) return false;
      set({ openProject: created });
      return true;
    },
    openFolder: async (path) => {
      let opened: ProjectSummary;
      try {
        opened = await api.openFolder(path);
      } catch (err) {
        const text = errorText(err);
        const readOnly = readOnlyMessage(text);
        if (readOnly) set({ openPrompt: { kind: "readOnly", path, message: readOnly } });
        else set({ error: text });
        return false;
      }
      await get().refresh().catch(() => {});
      set({ openProject: opened, error: null });
      for (const notice of opened.notices ?? []) toast(notice, "info");
      if (needsMainChoice(opened)) set({ openPrompt: { kind: "chooseMain", project: opened } });
      return true;
    },
    copyToProjects: async (path) => {
      const copy = await act(() => copyFolderToProjects(path));
      if (!copy) return;
      set({ openProject: copy });
      toast(`Made an editable copy, “${copy.name}”, in your projects folder`);
      if (needsMainChoice(copy)) set({ openPrompt: { kind: "chooseMain", project: copy } });
    },
    relocate: async (missing, path) => {
      if (!(await get().openFolder(path))) return;
      const found = get().openProject;
      // The old entry points nowhere now; drop it unless it's the same place.
      if (found && found.path !== missing.path) {
        await api.forgetProject(missing.path).catch(() => {});
        await get().refresh().catch(() => {});
      }
    },
    importProject: async (archivePath, name, main) => {
      const imported = await act(() => api.importArchive(archivePath, name, main));
      if (!imported) return false;
      void compileOnceOpened(imported.path);
      set({ openProject: imported });
      toast(`Imported “${imported.name}”`);
      return true;
    },
    rename: async (project, name) => {
      const renamed = await act(() => api.renameProject(project.path, name));
      if (renamed) toast(`Renamed to “${renamed.name}”`);
    },
    duplicate: async (project) => {
      const copy = await act(() => api.duplicateProject(project.path));
      if (copy) toast(`Duplicated as “${copy.name}”`);
    },
    remove: async (project) => {
      const done = await act(async () => {
        await api.deleteProject(project.path);
        return true;
      });
      if (done) toast(`“${project.name}” moved to the ${trashName}`);
    },
    forget: async (project) => {
      const done = await act(async () => {
        await api.forgetProject(project.path);
        return true;
      });
      if (done) toast(`Removed “${project.name}” from the list. Its files are untouched.`, "info");
    },
    setProjectsRoot: async (path) => {
      const settings = await act(() => api.setProjectsRoot(path));
      if (settings) {
        set({ settings });
        toast("New projects will be saved in the folder you chose", "info");
      }
    },
  };
});
