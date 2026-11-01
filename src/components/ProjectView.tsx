import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowLeft, File, FileText, Folder, FolderOpen } from "lucide-react";
import { api, errorText, type FileEntry, type ProjectSummary } from "../lib/api";
import { useApp } from "../store";
import { Button } from "./Dialog";

/**
 * Week-1 placeholder for the workspace: shows the project's files. The
 * editor, compiler, and PDF viewer replace the right-hand pane in weeks 2–4.
 */
export function ProjectView({ project }: { project: ProjectSummary }) {
  const close = () => useApp.getState().open(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjectFiles(project.path).then(setFiles, (e) => setError(errorText(e)));
  }, [project.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Button variant="ghost" onClick={close} aria-label="Back to projects">
          <ArrowLeft size={16} /> Projects
        </Button>
        <div className="h-5 w-px bg-border" />
        <h1 className="truncate font-semibold">{project.name}</h1>
        <Button className="ml-auto" onClick={() => void revealItemInDir(project.path)}>
          <FolderOpen size={15} /> Show in File Explorer
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-auto border-r border-border bg-surface/60 p-2">
          <div className="px-2 pt-1 pb-2 text-xs font-medium tracking-wide text-muted uppercase">Files</div>
          {error && <p className="px-2 text-sm text-danger">{error}</p>}
          {files?.map((f) => {
            const depth = f.path.split("/").length - 1;
            const name = f.path.split("/").pop();
            const isMain = f.path === project.mainDocument;
            const Icon = f.isDir ? Folder : f.path.endsWith(".tex") ? FileText : File;
            return (
              <div
                key={f.path}
                style={{ paddingLeft: 8 + depth * 14 }}
                className="flex items-center gap-2 rounded-md py-1 pr-2 text-sm hover:bg-surface-2"
              >
                <Icon size={15} className={f.isDir ? "text-accent" : "text-muted"} />
                <span className="truncate">{name}</span>
                {isMain && <span className="ml-auto rounded bg-accent/15 px-1.5 text-[10px] text-accent">main</span>}
              </div>
            );
          })}
          {files?.length === 0 && <p className="px-2 text-sm text-muted">This folder is empty.</p>}
        </aside>

        <section className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted">
          <FileText size={32} className="text-accent" />
          <p className="font-medium text-text">The editor arrives in the next build</p>
          <p className="max-w-sm text-sm">
            Code editing, compiling, and the PDF preview are next on the plan. For now you can open this folder in
            File Explorer.
          </p>
          <p className="mt-2 font-mono text-xs">{project.path}</p>
        </section>
      </div>
    </div>
  );
}
