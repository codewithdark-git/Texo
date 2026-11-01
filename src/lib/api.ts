// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type Template = "blank" | "example";

export type Compiler = "auto" | "latexmk" | "direct" | "tectonic";

export interface Settings {
  projectsRoot: string;
  externalProjects: string[];
  compiler: Compiler;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  mainDocument: string | null;
  engine: Engine;
  createdAt: string;
  lastEdited: string;
  fileCount: number;
  external: boolean;
  /** First page of the last PDF, as a PNG data URL. */
  thumbnail: string | null;
  /** The PDF Texo keeps in the project folder (e.g. `main.pdf`). */
  outputPdf: string | null;
}

export interface FileEntry {
  path: string;
  isDir: boolean;
  size: number;
}

export interface Label {
  name: string;
  file: string;
  line: number;
}

export interface Citation {
  key: string;
  entryType: string;
  title: string | null;
  author: string | null;
  year: string | null;
  file: string;
}

export interface Symbols {
  labels: Label[];
  citations: Citation[];
  commands: string[];
}

export type FileContent =
  | { kind: "text"; content: string }
  | { kind: "image"; dataUrl: string; size: number }
  | { kind: "tooLarge"; size: number }
  | { kind: "binary"; size: number };

/** Payload of the `project-fs-changed` event from the folder watcher. */
export interface FsChanged {
  project: string;
  paths: string[];
}

export const FS_CHANGED_EVENT = "project-fs-changed";

export interface Toolchains {
  latexmk: string | null;
  perl: string | null;
  pdflatex: string | null;
  xelatex: string | null;
  lualatex: string | null;
  bibtex: string | null;
  biber: string | null;
  makeindex: string | null;
  kpsewhich: string | null;
  tectonic: string | null;
  distribution: string | null;
}

export type Severity = "error" | "warning" | "badbox";

export interface Issue {
  severity: Severity;
  message: string;
  /** Project-relative path, or null for files outside the project. */
  file: string | null;
  line: number | null;
  context: string | null;
}

export type CompileStatus = "success" | "failed" | "aborted" | "timeout" | "noEngine" | "noMainDocument";

export interface CompileResult {
  status: CompileStatus;
  compiler: Compiler | null;
  engine: Engine;
  pdfPath: string | null;
  durationMs: number;
  issues: Issue[];
  hints: string[];
  log: string;
  output: string;
  /** The project's latexmkrc was skipped because the project isn't trusted. */
  rcIgnored: boolean;
  /** Where the PDF was saved in the project folder (successful compiles only). */
  savedPdf: string | null;
}

/** Window event asking the workspace to show the PDF preview. */
export const SHOW_PDF_EVENT = "texo:show-pdf";

/** Payload of the `compile-output` event: console lines as the tools run. */
export interface OutputChunk {
  project: string;
  lines: string[];
}

export const COMPILE_OUTPUT_EVENT = "compile-output";

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  setProjectsRoot: (path: string) => invoke<Settings>("set_projects_root", { path }),
  listProjects: () => invoke<ProjectSummary[]>("list_projects"),
  createProject: (name: string, template: Template) =>
    invoke<ProjectSummary>("create_project", { name, template }),
  openFolder: (path: string) => invoke<ProjectSummary>("open_folder", { path }),
  renameProject: (path: string, name: string) =>
    invoke<ProjectSummary>("rename_project", { path, name }),
  duplicateProject: (path: string) => invoke<ProjectSummary>("duplicate_project", { path }),
  deleteProject: (path: string) => invoke<void>("delete_project", { path }),
  forgetProject: (path: string) => invoke<void>("forget_project", { path }),
  listProjectFiles: (path: string) => invoke<FileEntry[]>("list_project_files", { path }),
  setMainDocument: (path: string, file: string) =>
    invoke<ProjectSummary>("set_main_document", { path, file }),

  // File operations. `file` paths are relative to the project, with `/`.
  readFile: (path: string, file: string) => invoke<FileContent>("read_file", { path, file }),
  writeFile: (path: string, file: string, content: string) =>
    invoke<void>("write_file", { path, file, content }),
  createFile: (path: string, file: string) => invoke<void>("create_file", { path, file }),
  createFolder: (path: string, folder: string) => invoke<void>("create_folder", { path, folder }),
  renamePath: (path: string, from: string, to: string) =>
    invoke<void>("rename_path", { path, from, to }),
  deletePath: (path: string, file: string) => invoke<void>("delete_path", { path, file }),
  importFiles: (path: string, dest: string, sources: string[]) =>
    invoke<string[]>("import_files", { path, dest, sources }),
  projectSymbols: (path: string) => invoke<Symbols>("project_symbols", { path }),
  watchProject: (path: string) => invoke<void>("watch_project", { path }),
  unwatchProject: () => invoke<void>("unwatch_project"),

  // Compiling.
  detectToolchains: () => invoke<Toolchains>("detect_toolchains"),
  setCompiler: (compiler: Compiler) => invoke<Settings>("set_compiler", { compiler }),
  setEngine: (path: string, engine: Engine) => invoke<ProjectSummary>("set_engine", { path, engine }),
  compileProject: (path: string) => invoke<CompileResult>("compile_project", { path }),
  abortCompile: (path: string) => invoke<void>("abort_compile", { path }),
  trustProject: (path: string) => invoke<void>("trust_project", { path }),
  saveThumbnail: (path: string, pngBase64: string) => invoke<void>("save_thumbnail", { path, pngBase64 }),
};

/** Rust errors arrive as plain strings; anything else gets a generic message. */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
