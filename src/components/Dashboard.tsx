import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Copy,
  FileText,
  FolderOpen,
  FolderInput,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api, type ProjectSummary, type Template } from "../lib/api";
import { filterProjects, formatDate, formatRelative, sortProjects, uniqueName, type SortKey } from "../lib/projects";
import { useApp } from "../store";
import { Button, ConfirmDialog, PromptDialog } from "./Dialog";
import { ContextMenu, Menu } from "./Menu";
import { fileManagerName, toast } from "../ui";
import { Sidebar } from "./Sidebar";

type DialogState =
  | { kind: "new"; template: Template }
  | { kind: "rename"; project: ProjectSummary }
  | { kind: "delete"; project: ProjectSummary }
  | null;

async function pickFolder(title: string): Promise<string | null> {
  const picked = await openDialog({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

export function Dashboard() {
  const app = useApp();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectSummary } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const onContext = (e: React.MouseEvent, project: ProjectSummary) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, project });
  };

  const visible = useMemo(
    () => sortProjects(filterProjects(app.projects, app.query), app.sortKey, app.sortDir),
    [app.projects, app.query, app.sortKey, app.sortDir],
  );

  // Pick up changes made outside the app (Explorer, other editors).
  useEffect(() => {
    const onFocus = () => void app.refresh().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [app.refresh]);

  const openFolder = async () => {
    const path = await pickFolder("Open a LaTeX project folder");
    if (path) await app.openFolder(path);
  };

  // Drop a project folder (or a .tex file inside one) on the window to open it.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const pending = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "over") setDragging(true);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        const dropped = p.paths[0];
        if (!dropped) return;
        void (async () => {
          const tryOpen = (path: string) => api.openFolder(path).catch(() => null);
          // A dropped file opens the folder it's in.
          const project = (await tryOpen(dropped)) ?? (await tryOpen(dropped.replace(/[\\/][^\\/]+$/, "")));
          if (!project) {
            toast("Drop a folder with your LaTeX files to open it as a project.", "error");
            return;
          }
          await useApp.getState().refresh();
          useApp.getState().open(project);
        })();
      }
    });
    return () => void pending.then((off) => off());
  }, []);

  // Keyboard: Ctrl+N new project, Ctrl+O open a folder, Ctrl+F or / to search.
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (document.querySelector('[role="dialog"]')) return;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && key === "n") {
        e.preventDefault();
        setDialog({ kind: "new", template: "example" });
      } else if (e.ctrlKey && key === "o") {
        e.preventDefault();
        void openFolder();
      } else if ((e.ctrlKey && key === "f") || (key === "/" && !typing)) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if (key === "escape" && e.target === search.current) {
        app.setQuery("");
        search.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const actionsFor = (p: ProjectSummary) => [
    { label: "Open", icon: <BookOpen size={15} />, onSelect: () => app.open(p) },
    { label: "Rename", icon: <Pencil size={15} />, onSelect: () => setDialog({ kind: "rename", project: p }) },
    { label: "Duplicate", icon: <Copy size={15} />, onSelect: () => void app.duplicate(p) },
    {
      label: `Show in ${fileManagerName}`,
      icon: <FolderOpen size={15} />,
      onSelect: () => void revealItemInDir(p.path),
    },
    "divider" as const,
    ...(p.external
      ? [
          {
            label: "Remove from list",
            hint: "Keeps the folder on disk",
            icon: <X size={15} />,
            onSelect: () => void app.forget(p),
          },
        ]
      : []),
    {
      label: "Move to Recycle Bin",
      icon: <Trash2 size={15} />,
      danger: true,
      onSelect: () => setDialog({ kind: "delete", project: p }),
    },
  ];

  const newMenu = (
    <Menu
      trigger={({ toggle }) => (
        <Button variant="primary" onClick={toggle}>
          <Plus size={16} /> New
        </Button>
      )}
      items={[
        {
          label: "Blank project",
          hint: "An empty article with main.tex",
          icon: <FileText size={15} />,
          onSelect: () => setDialog({ kind: "new", template: "blank" }),
        },
        {
          label: "Example project",
          hint: "Sections, maths, a table and citations",
          icon: <BookOpen size={15} />,
          onSelect: () => setDialog({ kind: "new", template: "example" }),
        },
      ]}
    />
  );

  return (
    <div className="flex h-full">
      <Sidebar onChangeRoot={async () => {
        const path = await pickFolder("Choose where new projects are saved");
        if (path) await app.setProjectsRoot(path);
      }} />

      <main className="relative flex min-w-0 flex-1 flex-col">
        {dragging && (
          <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-text">
            Drop a project folder to open it
          </div>
        )}
        <header className="flex items-center gap-3 border-b border-border px-6 py-4">
          <h1 className="text-lg font-semibold">Projects</h1>
          <div className="relative ml-4 max-w-sm flex-1">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
            <input
              ref={search}
              value={app.query}
              onChange={(e) => app.setQuery(e.target.value)}
              placeholder="Search projects  (Ctrl+F)"
              aria-label="Search projects"
              className="h-8 w-full rounded-lg border border-border bg-surface pr-3 pl-9 outline-none focus:border-accent"
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-lg border border-border bg-surface p-0.5">
              {(["list", "grid"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-label={mode === "list" ? "List view" : "Grid view"}
                  aria-pressed={app.viewMode === mode}
                  onClick={() => app.setViewMode(mode)}
                  className={`rounded-md p-1.5 ${app.viewMode === mode ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}
                >
                  {mode === "list" ? <List size={15} /> : <LayoutGrid size={15} />}
                </button>
              ))}
            </div>
            <Button onClick={openFolder}>
              <FolderInput size={16} /> Open folder
            </Button>
            {newMenu}
          </div>
        </header>

        {app.error && (
          <div role="alert" className="mx-6 mt-4 flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm">
            <span className="flex-1">{app.error}</span>
            <button type="button" aria-label="Dismiss" onClick={app.dismissError} className="text-muted hover:text-text">
              <X size={15} />
            </button>
          </div>
        )}

        <section className="min-h-0 flex-1 overflow-auto px-6 py-4">
          {app.loading ? (
            <p className="text-muted">Loading projects…</p>
          ) : app.projects.length === 0 ? (
            <EmptyState onNew={() => setDialog({ kind: "new", template: "example" })} onOpen={openFolder} />
          ) : visible.length === 0 ? (
            <p className="py-16 text-center text-muted">No projects match “{app.query}”.</p>
          ) : app.viewMode === "list" ? (
            <ProjectTable projects={visible} actionsFor={actionsFor} onContext={onContext} />
          ) : (
            <ProjectGrid projects={visible} actionsFor={actionsFor} onContext={onContext} />
          )}
        </section>
      </main>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={actionsFor(menu.project)} onClose={closeMenu} />}
      {dialog?.kind === "new" && (
        <PromptDialog
          title={dialog.template === "blank" ? "New blank project" : "New example project"}
          label="Project name"
          initial={uniqueName(dialog.template === "blank" ? "Untitled" : "Example paper", app.projects.map((p) => p.name))}
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            setDialog(null);
            void app.createProject(name, dialog.template);
          }}
        >
          <p className="mt-2 text-xs text-muted">Saved in {app.settings?.projectsRoot}</p>
        </PromptDialog>
      )}
      {dialog?.kind === "rename" && (
        <PromptDialog
          title="Rename project"
          label="Project name"
          initial={dialog.project.name}
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            setDialog(null);
            void app.rename(dialog.project, name);
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Move project to the Recycle Bin?"
          message={
            <>
              <strong className="text-text">{dialog.project.name}</strong> and all its files will be moved to the
              Recycle Bin. You can restore them from there.
            </>
          }
          confirmLabel="Move to Recycle Bin"
          danger
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void app.remove(dialog.project);
          }}
        />
      )}
    </div>
  );
}

type Actions = (p: ProjectSummary) => Parameters<typeof Menu>[0]["items"];

function RowMenu({ project, actionsFor }: { project: ProjectSummary; actionsFor: Actions }) {
  return (
    <Menu
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-label={`Actions for ${project.name}`}
          onClick={toggle}
          className={`rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text ${open ? "bg-surface-2 text-text" : ""}`}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
      items={actionsFor(project)}
    />
  );
}

function SortHeader({ label, sortKey, className = "" }: { label: string; sortKey: SortKey; className?: string }) {
  const { sortKey: active, sortDir, setSort } = useApp();
  const Arrow = sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={`py-2 font-normal ${className}`}>
      <button
        type="button"
        onClick={() => setSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-text ${active === sortKey ? "text-text" : ""}`}
      >
        {label}
        {active === sortKey && <Arrow size={12} />}
      </button>
    </th>
  );
}

type OnContext = (e: React.MouseEvent, project: ProjectSummary) => void;

function ProjectTable({
  projects,
  actionsFor,
  onContext,
}: {
  projects: ProjectSummary[];
  actionsFor: Actions;
  onContext: OnContext;
}) {
  const open = useApp((s) => s.open);
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="text-left text-xs text-muted">
        <tr className="border-b border-border">
          <SortHeader label="Name" sortKey="name" className="pl-2" />
          <SortHeader label="Last edited" sortKey="lastEdited" className="w-36" />
          <SortHeader label="Created" sortKey="createdAt" className="w-36" />
          <th className="w-12" />
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr
            key={p.id + p.path}
            onDoubleClick={() => open(p)}
            onContextMenu={(e) => onContext(e, p)}
            className="group border-b border-border/60 hover:bg-surface"
          >
            <td className="py-2 pl-2">
              <button type="button" onClick={() => open(p)} className="flex items-center gap-3 text-left">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-accent">
                  <FileText size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium" title={p.name}>{p.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {p.external ? p.path : `${p.fileCount} ${p.fileCount === 1 ? "file" : "files"}`}
                  </span>
                </span>
              </button>
            </td>
            <td className="text-muted" title={new Date(p.lastEdited).toLocaleString()}>
              {formatRelative(p.lastEdited)}
            </td>
            <td className="text-muted">{formatDate(p.createdAt)}</td>
            <td className="pr-2 text-right">
              <RowMenu project={p} actionsFor={actionsFor} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProjectGrid({
  projects,
  actionsFor,
  onContext,
}: {
  projects: ProjectSummary[];
  actionsFor: Actions;
  onContext: OnContext;
}) {
  const open = useApp((s) => s.open);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      {projects.map((p) => (
        <div
          key={p.id + p.path}
          onContextMenu={(e) => onContext(e, p)}
          className="group rounded-xl border border-border bg-surface transition-colors hover:border-accent/60"
        >
          <button
            type="button"
            onClick={() => open(p)}
            aria-label={`Open ${p.name}`}
            className="flex aspect-[4/3] w-full items-center justify-center rounded-t-xl bg-surface-2"
          >
            {p.thumbnail ? (
              <img src={p.thumbnail} alt="" className="h-[85%] rounded-sm bg-white object-contain shadow" />
            ) : (
              // Until the project's first successful compile.
              <span className="flex h-3/4 aspect-[1/1.3] flex-col gap-1.5 rounded-sm bg-white/90 p-3 shadow">
                <span className="h-1.5 w-3/4 self-center rounded bg-black/30" />
                <span className="h-1 w-full rounded bg-black/15" />
                <span className="h-1 w-full rounded bg-black/15" />
                <span className="h-1 w-5/6 rounded bg-black/15" />
                <span className="h-1 w-full rounded bg-black/15" />
              </span>
            )}
          </button>
          <div className="flex items-center gap-2 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium" title={p.name}>{p.name}</div>
              <div className="text-xs text-muted">Edited {formatRelative(p.lastEdited)}</div>
            </div>
            <RowMenu project={p} actionsFor={actionsFor} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onNew, onOpen }: { onNew: () => void; onOpen: () => void }) {
  return (
    <div className="flex flex-col items-center py-24 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-accent">
        <FileText size={26} />
      </div>
      <h2 className="text-base font-semibold">No projects yet</h2>
      <p className="mt-1 max-w-sm text-muted">
        Start from an example paper, or open a folder that already has your LaTeX files.
      </p>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" onClick={onNew}>
          <Plus size={16} /> New example project
        </Button>
        <Button onClick={onOpen}>
          <FolderInput size={16} /> Open folder
        </Button>
      </div>
    </div>
  );
}
