// Imports a .zip or .tar.gz as a new project: pick the file, check what's
// in it, then extract it with a progress bar and open the project.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FileArchive, Loader2 } from "lucide-react";
import { api, errorText, IMPORT_PROGRESS_EVENT, type ArchivePreview, type ImportProgress } from "../lib/api";
import { uniqueName } from "../lib/projects";
import { useApp } from "../store";
import { Button, Modal } from "./Dialog";

/** True for the archive types Texo imports. */
export const isArchivePath = (path: string) => /\.(zip|tgz|tar\.gz)$/i.test(path);

/** Shows the system file picker for an archive; null when cancelled. */
export async function pickArchive(): Promise<string | null> {
  const picked = await openDialog({
    title: "Import a project archive",
    multiple: false,
    directory: false,
    filters: [{ name: "Project archive", extensions: ["zip", "tar.gz", "tgz"] }],
  });
  return typeof picked === "string" ? picked : null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

type Step =
  | { kind: "pick" }
  | { kind: "reading"; file: string }
  | { kind: "preview"; file: string; preview: ArchivePreview }
  | { kind: "importing"; file: string; preview: ArchivePreview; progress: ImportProgress | null };

export function ImportDialog({ file, onClose }: { file?: string | null; onClose: () => void }) {
  const app = useApp();
  const [step, setStep] = useState<Step>(file ? { kind: "reading", file } : { kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [main, setMain] = useState<string>("");

  const read = async (path: string) => {
    setError(null);
    setStep({ kind: "reading", file: path });
    try {
      const preview = await api.inspectArchive(path);
      setName(uniqueName(preview.suggestedName, useApp.getState().projects.map((p) => p.name)));
      setMain(preview.suggestedMain ?? preview.texFiles[0] ?? "");
      setStep({ kind: "preview", file: path, preview });
    } catch (err) {
      setError(errorText(err));
      setStep({ kind: "pick" });
    }
  };

  const choose = async () => {
    const path = await pickArchive();
    if (path) await read(path);
    return path;
  };

  // Step 1 opens the file picker straight away; cancelling it closes the dialog.
  const started = useRef(false);
  useEffect(() => {
    // Effects run twice in development; only ever open one picker.
    if (started.current) return;
    started.current = true;
    if (file) void read(file);
    else void choose().then((path) => !path && onClose());
  }, []);

  const start = async () => {
    if (step.kind !== "preview" || !name.trim()) return;
    const { file: path, preview } = step;
    setError(null);
    setStep({ kind: "importing", file: path, preview, progress: null });
    const unlisten = await listen<ImportProgress>(IMPORT_PROGRESS_EVENT, (e) =>
      setStep((s) => (s.kind === "importing" ? { ...s, progress: e.payload } : s)),
    );
    try {
      const ok = await app.importProject(path, name.trim(), main || null);
      if (ok) {
        onClose();
        return;
      }
      // The store reports failures on the dashboard; show them here instead.
      setError(useApp.getState().error ?? "The archive couldn't be imported.");
      useApp.getState().dismissError();
      setStep({ kind: "preview", file: path, preview });
    } finally {
      unlisten();
    }
  };

  const busy = step.kind === "importing";
  const progress = step.kind === "importing" ? step.progress : null;
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Modal title="Import a project" onClose={() => !busy && onClose()}>
      {(step.kind === "pick" || step.kind === "reading") && (
        <div className="flex flex-col items-center gap-3 py-4 text-center text-sm text-muted">
          <FileArchive size={28} className="text-accent" />
          {step.kind === "reading" ? (
            <p className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Reading {baseName(step.file)}…
            </p>
          ) : (
            <p className="max-w-xs">Choose a .zip or .tar.gz with your LaTeX files.</p>
          )}
          {error && <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-left text-text">{error}</p>}
          <div className="mt-2 flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={step.kind === "reading"} onClick={() => void choose()}>
              Choose archive…
            </Button>
          </div>
        </div>
      )}

      {(step.kind === "preview" || step.kind === "importing") && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <div className="flex items-start gap-3 rounded-lg border border-border bg-bg px-3 py-2.5 text-sm">
            <FileArchive size={18} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0">
              <div className="truncate font-medium" title={step.file}>{baseName(step.file)}</div>
              <div className="text-xs text-muted">
                {step.preview.fileCount} {step.preview.fileCount === 1 ? "file" : "files"},{" "}
                {formatBytes(step.preview.totalBytes)}
                {step.preview.stripPrefix && <> · contents of “{step.preview.stripPrefix}”</>}
              </div>
            </div>
          </div>

          {step.preview.warnings.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-muted">
              {step.preview.warnings.map((w) => (
                <li key={w} className="flex gap-2">
                  <AlertTriangle size={13} className="mt-px shrink-0 text-accent" />
                  {w}
                </li>
              ))}
            </ul>
          )}

          <label htmlFor="import-name" className="mt-4 mb-1.5 block text-xs text-muted">
            Project name
          </label>
          <input
            id="import-name"
            autoFocus
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-bg px-3 outline-none focus:border-accent"
          />

          <label htmlFor="import-main" className="mt-4 mb-1.5 block text-xs text-muted">
            Main document
          </label>
          {step.preview.texFiles.length > 0 ? (
            <select
              id="import-main"
              disabled={busy}
              value={main}
              onChange={(e) => setMain(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-bg px-2 outline-none focus:border-accent"
            >
              {step.preview.texFiles.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-muted">No .tex files found. You can pick a main document later.</p>
          )}

          {busy && (
            <div className="mt-4">
              <div
                role="progressbar"
                aria-label="Import progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-1.5 overflow-hidden rounded-full bg-surface-2"
              >
                <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-muted">
                {progress ? `Extracting ${progress.done} of ${progress.total} files…` : "Checking the archive…"}
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
              {error}
            </p>
          )}

          <p className="mt-4 text-xs text-muted">Saved in {app.settings?.projectsRoot}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              Import
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
