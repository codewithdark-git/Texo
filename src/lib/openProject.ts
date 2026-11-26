// Opening projects: the extra command and the small rules the dashboard uses
// to explain what happened (missing folders, read-only folders, a choice of
// main document). Kept apart from api.ts so it stays easy to test.
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSummary } from "./api";

/** Prefix the backend puts on "can't write here" errors (`project::READ_ONLY_MARK`). */
export const READ_ONLY_MARK = "[read-only] ";

/** Copies a folder Texo can't write to into the projects folder as a new project. */
export const copyFolderToProjects = (path: string) =>
  invoke<ProjectSummary>("copy_folder_to_projects", { path });

/** The plain message of a read-only error, or null for any other error. */
export function readOnlyMessage(error: string): string | null {
  return error.startsWith(READ_ONLY_MARK) ? error.slice(READ_ONLY_MARK.length) : null;
}

/** True when opening the project should ask which file is the main document. */
export function needsMainChoice(project: ProjectSummary): boolean {
  return (project.mainCandidates?.length ?? 0) > 1;
}

/** A candidate's file name and the folder it sits in, for the chooser. */
export function describeCandidate(path: string): { name: string; folder: string | null } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, folder: null } : { name: path.slice(at + 1), folder: path.slice(0, at) };
}

/** True for a dashboard row whose folder can't be found any more. */
export function isMissing(project: ProjectSummary): boolean {
  return project.missing === true;
}

/** Where a missing project was, shortened for a sentence. */
export function lastKnownPlace(project: ProjectSummary): string {
  return project.path.replace(/[\\/]+$/, "");
}
