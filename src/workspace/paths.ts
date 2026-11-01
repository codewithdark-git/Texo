import type { FileEntry } from "../lib/api";

// Helpers for project-relative paths, which always use `/`.

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The folder containing `path`, or "" for the project root. */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** True when `path` is `dir` itself or anything inside it. */
export function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** Replaces the `from` prefix of `path` with `to`, for renames and moves. */
export function rebase(path: string, from: string, to: string): string {
  return path === from ? to : `${to}${path.slice(from.length)}`;
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Builds a sorted tree (folders first) from the flat list the backend returns. */
export function buildTree(entries: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const node: TreeNode = { name: baseName(path), path, isDir: true, children: [] };
    dirs.set(path, node);
    ensureDir(parentDir(path)).children.push(node);
    return node;
  };

  for (const e of entries) {
    if (e.isDir) ensureDir(e.path);
    else ensureDir(parentDir(e.path)).children.push({ name: baseName(e.path), path: e.path, isDir: false, children: [] });
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || collator.compare(a.name, b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}
