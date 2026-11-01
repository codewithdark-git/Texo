import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  COMPILE_OUTPUT_EVENT,
  errorText,
  type CompileResult,
  type Compiler,
  type Engine,
  type Issue,
  type OutputChunk,
  type Toolchains,
} from "../lib/api";
import { monaco } from "../editor/monaco";
import { onProjectChanged, useWorkspace } from "./store";

const PREFS_KEY = "texo.compile";
const MAX_OUTPUT_LINES = 4000;
const AUTO_DELAY_MS = 300;
const MARKER_OWNER = "texo-compile";

/** Files whose changes are worth recompiling for. */
const COMPILE_INPUT = /\.(tex|bib|sty|cls|bst|bbx|cbx|png|jpe?g|pdf|eps|svg|csv|dat|tikz|latexmkrc)$/i;

function loadAuto(): boolean {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}").auto ?? true;
  } catch {
    return true;
  }
}

interface CompileStore {
  compiling: boolean;
  queued: boolean;
  result: CompileResult | null;
  /** Console output of the current or last compile. */
  output: string[];
  toolchains: Toolchains | null;
  compiler: Compiler;
  auto: boolean;
  error: string | null;

  init: () => Promise<void>;
  reset: () => void;
  compile: () => Promise<void>;
  abort: () => Promise<void>;
  setAuto: (auto: boolean) => void;
  setCompiler: (compiler: Compiler) => Promise<void>;
  setEngine: (engine: Engine) => Promise<void>;
  refreshToolchains: () => Promise<void>;
  /** Lets this project run its own latexmkrc, then recompiles. */
  trust: () => Promise<void>;
}

let unlisten: UnlistenFn | null = null;
/** Bumped for every compile and on reset, so a superseded run's late result is ignored. */
let currentRun = 0;
let autoTimer: ReturnType<typeof setTimeout> | undefined;
let modelListener: monaco.IDisposable | null = null;

const pathOfModel = (model: monaco.editor.ITextModel) =>
  model.uri.scheme === "texo" ? model.uri.path.replace(/^\//, "") : null;

function markersFor(issues: Issue[], path: string): monaco.editor.IMarkerData[] {
  return issues
    .filter((i) => i.file === path && i.line)
    .map((i) => ({
      severity:
        i.severity === "error"
          ? monaco.MarkerSeverity.Error
          : i.severity === "warning"
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
      message: i.message,
      startLineNumber: i.line!,
      endLineNumber: i.line!,
      startColumn: 1,
      endColumn: 1000,
      source: "LaTeX",
    }));
}

/** Shows compile issues as squiggles in every open editor model. */
function applyMarkers(issues: Issue[]) {
  for (const model of monaco.editor.getModels()) {
    const path = pathOfModel(model);
    if (path) monaco.editor.setModelMarkers(model, MARKER_OWNER, markersFor(issues, path));
  }
}

export const useCompile = create<CompileStore>((set, get) => {
  const projectPath = () => useWorkspace.getState().project?.path ?? null;

  return {
    compiling: false,
    queued: false,
    result: null,
    output: [],
    toolchains: null,
    compiler: "auto",
    auto: loadAuto(),
    error: null,

    init: async () => {
      get().reset();
      unlisten = await listen<OutputChunk>(COMPILE_OUTPUT_EVENT, (e) => {
        if (e.payload.project !== projectPath()) return;
        set((s) => {
          const output = s.output.concat(e.payload.lines);
          return { output: output.length > MAX_OUTPUT_LINES ? output.slice(-MAX_OUTPUT_LINES) : output };
        });
      });
      // Files opened after a compile get their markers too.
      modelListener = monaco.editor.onDidCreateModel((model) => {
        const path = pathOfModel(model);
        const issues = get().result?.issues;
        if (path && issues) monaco.editor.setModelMarkers(model, MARKER_OWNER, markersFor(issues, path));
      });
      onProjectChanged((path) => {
        if (!get().auto || (path && !COMPILE_INPUT.test(path))) return;
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => void get().compile(), AUTO_DELAY_MS);
      });
      try {
        const settings = await api.getSettings();
        set({ compiler: settings.compiler });
      } catch {
        // Keep the default.
      }
      await get().refreshToolchains();
      if (get().auto) void get().compile();
    },

    reset: () => {
      currentRun++;
      clearTimeout(autoTimer);
      unlisten?.();
      unlisten = null;
      modelListener?.dispose();
      modelListener = null;
      onProjectChanged(null);
      applyMarkers([]);
      set({ compiling: false, queued: false, result: null, output: [], error: null });
    },

    compile: async () => {
      const path = projectPath();
      if (!path) return;
      if (get().compiling) {
        // Compile again once the current run ends, with the newest files.
        set({ queued: true });
        return;
      }
      clearTimeout(autoTimer);
      const run = ++currentRun;
      set({ compiling: true, queued: false, output: [], error: null });
      await useWorkspace.getState().saveAll();
      let result: CompileResult | null = null;
      let error: string | null = null;
      try {
        result = await api.compileProject(path);
      } catch (err) {
        error = errorText(err);
      }
      // The workspace was reset or closed while this ran; its result is stale.
      if (run !== currentRun) return;
      set({ compiling: false, error, ...(result ? { result } : {}) });
      // The saved PDF shows up in the file tree with its badge.
      const project = useWorkspace.getState().project;
      if (result?.savedPdf && project && project.outputPdf !== result.savedPdf) {
        useWorkspace.setState({ project: { ...project, outputPdf: result.savedPdf } });
      }
      if (result) applyMarkers(result.issues);
      if (get().queued) void get().compile();
    },

    abort: async () => {
      const path = projectPath();
      set({ queued: false });
      if (path) await api.abortCompile(path).catch(() => {});
    },

    setAuto: (auto) => {
      set({ auto });
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ auto }));
      } catch {
        // Remembered for this session only.
      }
    },

    setCompiler: async (compiler) => {
      try {
        const settings = await api.setCompiler(compiler);
        set({ compiler: settings.compiler });
        void get().compile();
      } catch (err) {
        set({ error: errorText(err) });
      }
    },

    setEngine: async (engine) => {
      const path = projectPath();
      if (!path) return;
      try {
        const project = await api.setEngine(path, engine);
        useWorkspace.setState({ project });
        void get().compile();
      } catch (err) {
        set({ error: errorText(err) });
      }
    },

    trust: async () => {
      const path = projectPath();
      if (!path) return;
      try {
        await api.trustProject(path);
        void get().compile();
      } catch (err) {
        set({ error: errorText(err) });
      }
    },

    refreshToolchains: async () => {
      try {
        set({ toolchains: await api.detectToolchains() });
      } catch (err) {
        set({ error: errorText(err) });
      }
    },
  };
});
