// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type Template = "blank" | "example" | "conference" | "report" | "thesis" | "lecture" | "homework" | "presentation" | "letter" | "cv";

export type Compiler = "auto" | "latexmk" | "direct" | "tectonic";

export interface Settings {
  projectsRoot: string;
  externalProjects: string[];
  compiler: Compiler;
  /** Projects allowed to run their own latexmk config. */
  trustedProjects?: string[];
  /** Something to tell the user once about the settings file (it was damaged and restored). */
  notice?: string;
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
  /** The listed folder can't be found (moved, renamed, deleted, drive not connected). */
  missing?: boolean;
  /** The folder is there but its Texo project info can't be read; opening it sets it up again. */
  needsSetup?: boolean;
  /** Plain sentences to show after opening (main document re-detected, cloud-only files…). */
  notices?: string[];
  /** When Texo had to pick the main document among several: every likely one, best first. */
  mainCandidates?: string[];
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
  /** Argument-free macros defined as short text (`\newcommand{\runs}{5}`). */
  textMacros?: { name: string; body: string }[];
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
  /** The Tectonic that ships with Texo is the one in use. */
  tectonicBundled: boolean;
}

export interface EngineStatus {
  /** The toolchain "Automatic" compiles with, or null if there is none. */
  compiler: Compiler | null;
  distribution: string | null;
  bundled: boolean;
  /** Ready to compile without a long first-time download. */
  ready: boolean;
}

/** Payload of `engine-setup` events: console lines from the first-run setup. */
export const ENGINE_SETUP_EVENT = "engine-setup";

export type Severity = "error" | "warning" | "badbox";

export interface Issue {
  severity: Severity;
  message: string;
  /** Project-relative path, or null for files outside the project. */
  file: string | null;
  line: number | null;
  context: string | null;
  /** For an undefined-citation warning: the key that wasn't found. */
  citation?: string;
  /** What the error means and how to fix it, in plain words (recognised errors only). */
  explanation?: string;
  /** The error that made TeX give up: this run produced no new PDF. */
  fatal?: boolean;
  /** Undefined only because the compile stopped early (citations, references, rerun notes). */
  consequence?: boolean;
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

/** What an archive holds, read before anything is extracted. */
export interface ArchivePreview {
  kind: "zip" | "tarGz";
  fileCount: number;
  totalBytes: number;
  /** The single top folder that is removed on import, if any. */
  stripPrefix: string | null;
  /** Every `.tex` file, named as it will be in the project. */
  texFiles: string[];
  suggestedMain: string | null;
  suggestedName: string;
  warnings: string[];
}

/** Payload of `import-progress` events while an import or export runs. */
export interface ImportProgress {
  done: number;
  total: number;
}

export const IMPORT_PROGRESS_EVENT = "import-progress";

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
  engineStatus: () => invoke<EngineStatus>("engine_status"),
  prepareEngine: () => invoke<void>("prepare_engine"),

  // Archives and copies out of the project.
  inspectArchive: (path: string) => invoke<ArchivePreview>("inspect_archive", { path }),
  importArchive: (path: string, name: string, main: string | null) =>
    invoke<ProjectSummary>("import_archive", { path, name, main }),
  exportProject: (path: string, dest: string, includePdf: boolean) =>
    invoke<void>("export_project", { path, dest, includePdf }),
  savePdfAs: (path: string, dest: string) => invoke<void>("save_pdf_as", { path, dest }),
  /** Raw bytes of a figure (pdf, png, jpg, jpeg, svg or eps, up to 15 MiB). */
  readAsset: (path: string, file: string) => invoke<ArrayBuffer>("read_asset", { path, file }),
};

/** Rust errors arrive as plain strings (AI commands: an `AiError` object);
 * anything else gets a generic message. */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (isAiError(err)) return err.message;
  return "Something went wrong.";
}

// ===========================================================================
// AI error explainer and fixer (src-tauri/src/ai/commands.rs)
//
// API keys never cross this boundary: the backend keeps them in the OS
// credential store and only reports whether one is set. Nothing is sent to a
// provider except by `aiApi.explainAndFix` (and `listModels` /
// `testConnection`, which send only the key). `explainAndFix` refuses with
// kind "noticeRequired" until the privacy notice for the current provider was
// accepted (`updateSettings({ acceptNotice })`), and with "disabled" when AI
// help is off.
// ===========================================================================

export type AiProviderId = "nvidia" | "openrouter" | "groq" | "gemini" | "anthropic" | "custom";

/** Every AI command rejects with this object (not a string). */
export interface AiError {
  kind:
    | "disabled" // AI help is off in Settings
    | "noticeRequired" // show the privacy notice, then acceptNotice
    | "noKey" // open Settings > AI
    | "badKey" // 401: key rejected
    | "forbidden" // 403
    | "notFound" // 404: unknown model or wrong address
    | "rateLimited" // 429, see retryAfterSecs
    | "payment" // 402: out of credits
    | "tooLarge" // 413
    | "badRequest" // 400/422
    | "server" // 5xx / 529
    | "offline" // can't connect
    | "tls" // secure connection failed (proxy/antivirus)
    | "timeout"
    | "network"
    | "cancelled" // aiApi.cancel was called
    | "refused" // the model declined
    | "truncated" // the answer was cut off
    | "badResponse" // the answer wasn't readable JSON
    | "invalidInput"
    | "keyStore" // couldn't save/remove the key
    | "other";
  /** Plain words, safe to show; never contains a key. */
  message: string;
  /** Seconds to wait (rate limits and overload), when the provider said. */
  retryAfterSecs: number | null;
}

export function isAiError(err: unknown): err is AiError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as AiError).kind === "string" &&
    typeof (err as AiError).message === "string"
  );
}

/** `storage` is where the key is kept; "file" means no OS credential store
 * was available and `warning` explains it is less secure. */
export interface AiKeyStatus {
  provider: AiProviderId;
  hasKey: boolean;
  storage: "keychain" | "file" | null;
  warning: string | null;
}

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  keyRequired: boolean;
  /** Page where the user creates a key (null for custom). */
  keyUrl: string | null;
  /** One or two plain sentences on getting a key. */
  howTo: string;
  /** Fixed API address; for "custom" the one from settings (or null). */
  baseUrl: string | null;
  /** How the provider is held to JSON answers. */
  structured: "jsonSchema" | "jsonObject" | "none";
  /** The model picked for this provider (Claude: "claude-opus-5-5" by default). */
  model: string | null;
  key: AiKeyStatus;
}

export interface AiModel {
  id: string;
  label: string;
  /** Known to cost nothing (OpenRouter); null when unknown. */
  free: boolean | null;
  contextLength: number | null;
  /** Texo's suggestion for this provider (at most one per list). */
  recommended: boolean;
}

/** Stored by the backend in `ai.json` (never in settings.json, never keys). */
export interface AiSettings {
  enabled: boolean;
  /** Default "nvidia". */
  provider: AiProviderId;
  /** Picked model per provider. Without one, the first request uses Texo's
   * suggestion from the live model list and remembers it here. */
  models: Partial<Record<AiProviderId, string>>;
  /** https://… or, for this computer only, http://localhost… */
  customBaseUrl: string | null;
  /** Providers whose privacy notice was accepted. */
  noticeAccepted: AiProviderId[];
}

/** Missing fields are left unchanged. Rejects with "invalidInput" for a bad
 * model id or base URL (http:// only for localhost/127.0.0.1/::1). */
export interface AiSettingsPatch {
  enabled?: boolean;
  provider?: AiProviderId;
  /** `model: null` forgets the choice (back to Texo's suggestion). */
  model?: { provider: AiProviderId; model: string | null };
  /** An empty string clears it. */
  customBaseUrl?: string;
  acceptNotice?: AiProviderId;
  resetNotices?: boolean;
}

export interface AiConnectionTest {
  /** False when the picked model is missing or the list is empty. */
  ok: boolean;
  message: string;
  modelCount: number;
  /** The model that will be used (picked, or the suggestion). */
  model: string | null;
  /** null when no model was picked. */
  modelAvailable: boolean | null;
  latencyMs: number;
}

/** A `CompileResult` (or the parts of it) can be passed as is. */
export interface AiCompileInput {
  status: string;
  engine?: string | null;
  issues: {
    severity: string;
    message: string;
    file: string | null;
    line: number | null;
    context?: string | null;
    citation?: string | null;
  }[];
  hints: string[];
  log: string;
}

export interface AiEditInput {
  /** Project-relative, with `/`. */
  file: string;
  /** Exact existing text; must occur exactly once. */
  find: string;
  replace: string;
  why: string;
}

/** One earlier round of the fix loop (the backend uses the last 3). */
export interface AiPreviousAttempt {
  summary: string;
  edits: AiEditInput[];
  applied: boolean;
  /** First error messages of the compile that followed. */
  remainingErrors: string[];
}

export interface AiFixRequest {
  /** Chosen by the UI (e.g. crypto.randomUUID()); used by `cancel` and progress events. */
  requestId: string;
  compile: AiCompileInput;
  /** Index into `compile.issues` of the issue the user clicked, or null for "Fix compile errors". */
  focus: number | null;
  previous: AiPreviousAttempt[];
}

export interface AiSentExcerpt {
  file: string;
  fromLine: number;
  toLine: number;
  reason: string;
}

/** What was (or would be) sent to the provider. */
export interface AiContextSummary {
  excerpts: AiSentExcerpt[];
  issueCount: number;
  logLines: number;
  chars: number;
  truncated: boolean;
}

/** An edit after checking. Apply only when `ok`: replace `lengthUtf16`
 * UTF-16 code units at `offsetUtf16` (Monaco offsets, in the text that was
 * checked) with `replace`. `find`/`replace` use the file's own line endings. */
export interface AiCheckedEdit {
  file: string;
  find: string;
  replace: string;
  why: string;
  ok: boolean;
  /** Plain-words reason when not ok (outside project, not found, found N times, ...). */
  reason: string | null;
  /** 1-based line where the change starts. */
  line: number | null;
  offsetUtf16: number | null;
  lengthUtf16: number | null;
}

export interface AiEnvAction {
  kind: "install_package";
  /** The installed distribution's manager when one was found. */
  manager: "miktex" | "texlive";
  package: string;
  why: string;
  /** Texo found the package manager and can run it. */
  available: boolean;
  /** Shown before the user confirms, e.g. "miktex packages install cm-super". */
  command: string;
}

export interface AiFixResult {
  requestId: string;
  provider: AiProviderId;
  /** The model that answered (may differ after a server-side fallback). */
  model: string;
  summary: string;
  cause: string;
  steps: string[];
  /** Checked against the files on disk; re-check with `checkEdits` right before applying. */
  edits: AiCheckedEdit[];
  envActions: AiEnvAction[];
  confidence: "low" | "medium" | "high";
  sent: AiContextSummary;
  notes: string[];
}

export interface AiContextPreview {
  provider: AiProviderId;
  providerLabel: string;
  summary: AiContextSummary;
  /** Exactly what would be sent after the instructions. */
  text: string;
}

export interface AiInstallResult {
  ok: boolean;
  /** Plain-words outcome. */
  message: string;
  /** End of the package manager's output. */
  output: string;
}

/** Payload of `ai-progress` events while `explainAndFix` runs. */
export interface AiProgress {
  requestId: string;
  stage: "gathering" | "asking" | "checking";
  message: string;
}

export const AI_PROGRESS_EVENT = "ai-progress";

export const aiApi = {
  getSettings: () => invoke<AiSettings>("ai_get_settings"),
  updateSettings: (patch: AiSettingsPatch) => invoke<AiSettings>("ai_update_settings", { patch }),
  listProviders: () => invoke<AiProviderInfo[]>("ai_list_providers"),
  keyStatus: (provider: AiProviderId) => invoke<AiKeyStatus>("ai_key_status", { provider }),
  /** Stores a key in the OS credential store; it is never sent back. */
  setKey: (provider: AiProviderId, key: string) => invoke<AiKeyStatus>("ai_set_key", { provider, key }),
  clearKey: (provider: AiProviderId) => invoke<AiKeyStatus>("ai_clear_key", { provider }),
  /** Live list from the provider (needs the key, except for custom servers). */
  listModels: (provider: AiProviderId) => invoke<AiModel[]>("ai_list_models", { provider }),
  /** Lists models to check the key and address; sends nothing from the paper. */
  testConnection: (provider: AiProviderId) => invoke<AiConnectionTest>("ai_test_connection", { provider }),
  /** What `explainAndFix` would send for this compile, without sending anything. */
  previewContext: (path: string, compile: AiCompileInput, focus: number | null) =>
    invoke<AiContextPreview>("ai_preview_context", { path, compile, focus }),
  /** Sends the capped context to the current provider; emits `ai-progress`. */
  explainAndFix: (path: string, request: AiFixRequest) =>
    invoke<AiFixResult>("ai_explain_and_fix", { path, request }),
  /** True when a request with this id was running. */
  cancel: (requestId: string) => invoke<boolean>("ai_cancel", { requestId }),
  /** Re-checks edits against the editor's current text (`buffers`: project-relative path → content) or the file on disk. */
  checkEdits: (path: string, edits: AiEditInput[], buffers?: Record<string, string>) =>
    invoke<AiCheckedEdit[]>("ai_check_edits", { path, edits, buffers: buffers ?? null }),
  /** Runs the TeX package manager for one package. Only after the user confirms. */
  installPackage: (manager: "miktex" | "texlive", pkg: string) =>
    invoke<AiInstallResult>("ai_install_package", { manager, package: pkg }),
};
