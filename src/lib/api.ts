// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";

export type Engine = "pdflatex" | "xelatex" | "lualatex";
export type Template = "blank" | "example";

export interface Settings {
  projectsRoot: string;
  externalProjects: string[];
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
}

export interface FileEntry {
  path: string;
  isDir: boolean;
  size: number;
}

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
};

/** Rust errors arrive as plain strings; anything else gets a generic message. */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
