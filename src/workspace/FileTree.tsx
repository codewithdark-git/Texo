import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  Pencil,
  Star,
  Trash2,
  Upload,
  BookMarked,
} from "lucide-react";
import { ConfirmDialog, PromptDialog } from "../components/Dialog";
import { ContextMenu, type MenuItem } from "../components/Menu";
import { baseName, buildTree, joinPath, parentDir, type TreeNode } from "./paths";
import { useWorkspace } from "./store";

type Dialog =
  | { kind: "newFile" | "newFolder"; dir: string }
  | { kind: "rename"; node: TreeNode }
  | { kind: "delete"; node: TreeNode }
  | null;

function iconFor(node: TreeNode, open: boolean) {
  if (node.isDir) return open ? FolderOpen : Folder;
  if (/\.(tex|sty|cls)$/i.test(node.name)) return FileText;
  if (/\.bib$/i.test(node.name)) return BookMarked;
  if (/\.(png|jpe?g|gif|svg|webp|bmp|pdf|eps)$/i.test(node.name)) return Image;
  return File;
}

/** Highlighted while files are dragged over the window (see Workspace). */
export function FileTree({ dropTarget }: { dropTarget: string | null }) {
  const ws = useWorkspace();
  const tree = useMemo(() => buildTree(ws.files), [ws.files]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const upload = async (dir: string) => {
    const picked = await openDialog({ multiple: true, title: "Add files to the project" });
    if (picked) await ws.importFiles(dir, Array.isArray(picked) ? picked : [picked]);
  };

  const reveal = (path: string) =>
    void revealItemInDir(path ? `${ws.project!.path}\\${path.replaceAll("/", "\\")}` : ws.project!.path);

  const menuItems = (node: TreeNode | null): (MenuItem | "divider")[] => {
    const dir = node ? (node.isDir ? node.path : parentDir(node.path)) : "";
    const items: (MenuItem | "divider")[] = [
      { label: "New file", icon: <FilePlus size={15} />, onSelect: () => setDialog({ kind: "newFile", dir }) },
      { label: "New folder", icon: <FolderPlus size={15} />, onSelect: () => setDialog({ kind: "newFolder", dir }) },
      { label: "Add files…", icon: <Upload size={15} />, onSelect: () => void upload(dir) },
    ];
    if (!node) return [...items, "divider", { label: "Show in File Explorer", icon: <FolderOpen size={15} />, onSelect: () => reveal("") }];
    items.push("divider");
    if (!node.isDir && node.name.toLowerCase().endsWith(".tex") && node.path !== ws.project?.mainDocument) {
      items.push({ label: "Set as main document", icon: <Star size={15} />, onSelect: () => void ws.setMainDocument(node.path) });
    }
    items.push(
      { label: "Rename", icon: <Pencil size={15} />, hint: "F2", onSelect: () => setDialog({ kind: "rename", node }) },
      { label: "Show in File Explorer", icon: <FolderOpen size={15} />, onSelect: () => reveal(node.path) },
      "divider",
      { label: "Move to Recycle Bin", icon: <Trash2 size={15} />, danger: true, onSelect: () => setDialog({ kind: "delete", node }) },
    );
    return items;
  };

  const onContext = (e: MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const open = !!ws.expanded[node.path];
    const Icon = iconFor(node, open);
    const isActive = node.path === ws.active;
    const isMain = node.path === ws.project?.mainDocument;
    const dirty = ws.status[node.path]?.dirty;
    return (
      <div key={node.path} data-drop-dir={node.isDir ? node.path : undefined}>
        <button
          type="button"
          onClick={() => (node.isDir ? ws.toggleDir(node.path) : void ws.openFile(node.path))}
          onContextMenu={(e) => onContext(e, node)}
          onKeyDown={(e) => {
            if (e.key === "F2") setDialog({ kind: "rename", node });
            if (e.key === "Delete") setDialog({ kind: "delete", node });
          }}
          title={node.path}
          style={{ paddingLeft: 6 + depth * 14 }}
          className={`flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[13px] ${
            isActive ? "bg-accent/15 text-text" : "text-text/90 hover:bg-surface-2"
          } ${dropTarget === node.path && node.isDir ? "ring-1 ring-accent" : ""}`}
        >
          <span className="w-3.5 shrink-0 text-muted">
            {node.isDir && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          </span>
          <Icon size={15} className={`shrink-0 ${node.isDir ? "text-accent" : "text-muted"}`} />
          <span className="truncate">{node.name}</span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-text/70" aria-label="Unsaved" />}
          {isMain && (
            <span className="ml-auto shrink-0 rounded bg-accent/15 px-1.5 text-[10px] text-accent" title="Main document">
              main
            </span>
          )}
        </button>
        {node.isDir && open && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const toolbarButton = (label: string, icon: ReactNode, onClick: () => void) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
    >
      {icon}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-0.5 px-3 pt-2 pb-1">
        <span className="flex-1 text-xs font-medium tracking-wide text-muted uppercase">Files</span>
        {toolbarButton("New file", <FilePlus size={15} />, () => setDialog({ kind: "newFile", dir: "" }))}
        {toolbarButton("New folder", <FolderPlus size={15} />, () => setDialog({ kind: "newFolder", dir: "" }))}
        {toolbarButton("Add files", <Upload size={15} />, () => void upload(""))}
        {toolbarButton("Collapse all folders", <ChevronsDownUp size={15} />, ws.collapseAll)}
      </div>

      <div
        data-drop-dir=""
        onContextMenu={(e) => onContext(e, null)}
        className={`min-h-0 flex-1 overflow-auto px-1.5 pb-4 ${dropTarget === "" ? "bg-accent/5 ring-1 ring-accent ring-inset" : ""}`}
      >
        {tree.map((n) => renderNode(n, 0))}
        {tree.length === 0 && <p className="px-3 py-2 text-sm text-muted">No files yet. Drop files here to add them.</p>}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={closeMenu} />}

      {(dialog?.kind === "newFile" || dialog?.kind === "newFolder") && (
        <PromptDialog
          title={dialog.kind === "newFile" ? "New file" : "New folder"}
          label={dialog.dir ? `In ${dialog.dir}/` : "In the project root"}
          initial={dialog.kind === "newFile" ? "untitled.tex" : "figures"}
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            setDialog(null);
            void (dialog.kind === "newFile" ? ws.createFile(dialog.dir, name) : ws.createFolder(dialog.dir, name));
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <PromptDialog
          title={`Rename ${dialog.node.isDir ? "folder" : "file"}`}
          label="New name (use / to move it into a folder)"
          initial={dialog.node.name}
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            setDialog(null);
            const to = name.includes("/") ? name : joinPath(parentDir(dialog.node.path), name);
            void ws.renamePath(dialog.node.path, to);
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Move ${dialog.node.isDir ? "folder" : "file"} to the Recycle Bin?`}
          message={
            <>
              <strong className="text-text">{baseName(dialog.node.path)}</strong>
              {dialog.node.isDir ? " and everything in it" : ""} will be moved to the Recycle Bin.
            </>
          }
          confirmLabel="Move to Recycle Bin"
          danger
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void ws.deletePath(dialog.node.path);
          }}
        />
      )}
    </div>
  );
}
