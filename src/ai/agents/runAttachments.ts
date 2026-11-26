// Attachment rules for agent runs (the New task dialog). Reading a file
// (picture downscaling, PDF text, text sniffing) is shared with the chat:
// src/ai/chat/attachments.ts and readAttachment.ts. This file only decides
// what a run accepts and how a read file becomes a `StartRequest` attachment.

import type { Attachment } from "../../lib/agentsApi";
import type { ReadyAttachment } from "../chat/readAttachment";

/** Same limit as src-tauri/src/agents/attach.rs (MAX_ATTACHMENTS). */
export const MAX_RUN_ATTACHMENTS = 12;

/** A file in the dialog's list. */
export interface RunAttachment extends ReadyAttachment {
  id: string;
  /** "Also save into project": checked. */
  save: boolean;
  /** Where it goes in the project. */
  saveAs: string;
}

/** Why one more file can't be attached, or null when it can. */
export function runAttachLimit(count: number): string | null {
  return count >= MAX_RUN_ATTACHMENTS ? `You can attach up to ${MAX_RUN_ATTACHMENTS} files to one task.` : null;
}

/**
 * Whether a run can save this attachment into the project. Only text goes
 * through a changeset today; pictures and PDFs are added with Import.
 */
export function canSaveIntoProject(a: Pick<ReadyAttachment, "kind" | "mime" | "name">): boolean {
  return a.kind === "text" && a.mime !== "application/pdf" && !/\.pdf$/i.test(a.name);
}

/** Why "Also save into project" is unavailable (for its tooltip). */
export function saveUnavailableReason(a: Pick<ReadyAttachment, "kind" | "mime" | "name">): string | null {
  if (canSaveIntoProject(a)) return null;
  return a.kind === "image"
    ? "Pictures can't be saved into the project from a task yet. Add them with Import in the file tree."
    : "PDFs can't be saved into the project from a task. Add them with Import in the file tree.";
}

/** A file name safe to use in the project ("My notes (1).txt" → "My-notes-1.txt"). */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "")
    .replace(/[\s()[\]{}]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-\./g, ".")
    .replace(/^[-.]+|-+$/g, "");
  return cleaned || "attachment.txt";
}

/** Where "Also save into project" puts a file: pictures in figures/, the rest at the top. */
export function defaultSaveAs(a: Pick<ReadyAttachment, "kind" | "name">): string {
  const name = safeFileName(a.name);
  return a.kind === "image" ? `figures/${name}` : name;
}

/** Why a "save as" path can't be used, or null when it can. */
export function saveAsProblem(path: string): string | null {
  const p = path.trim().replace(/\\/g, "/");
  if (!p) return "Type where to save the file.";
  if (p.startsWith("/") || /^[a-z]:/i.test(p)) return "Use a path inside the project, like figures/plot.png.";
  const parts = p.split("/");
  if (parts.some((x) => x === ".." || x === ".")) return "Use a path inside the project, without “..”.";
  if (parts[0].toLowerCase() === ".texo" || parts[0].toLowerCase() === ".git") return "That folder is Texo's own. Pick another place.";
  if (parts.some((x) => !x)) return "The path has an empty folder name.";
  if (/[<>:"|?*]/.test(p)) return "The name has characters files can't use (< > : \" | ? *).";
  return null;
}

/** The part of a data URL after "base64,". */
export function base64Of(dataUrl: string): string {
  const at = dataUrl.indexOf("base64,");
  return at >= 0 ? dataUrl.slice(at + 7) : dataUrl;
}

/** What `agent_start` gets for a read file. */
export function toStartAttachment(a: RunAttachment): Attachment {
  const out: Attachment = { name: a.name, mime: a.mime };
  if (a.kind === "image" && a.dataUrl) out.dataBase64 = base64Of(a.dataUrl);
  else out.text = a.text ?? "";
  if (a.save && canSaveIntoProject(a) && !saveAsProblem(a.saveAs)) out.saveAs = a.saveAs.trim().replace(/\\/g, "/");
  return out;
}

/** Problems that block starting: a checked "save" with a bad path. */
export function attachmentsProblem(list: RunAttachment[]): string | null {
  for (const a of list) {
    if (!a.save || !canSaveIntoProject(a)) continue;
    const why = saveAsProblem(a.saveAs);
    if (why) return `${a.name}: ${why}`;
  }
  const targets = list.filter((a) => a.save && canSaveIntoProject(a)).map((a) => a.saveAs.trim().toLowerCase());
  const dup = targets.find((t, i) => targets.indexOf(t) !== i);
  return dup ? `Two files would be saved as ${dup}. Change one of the names.` : null;
}
