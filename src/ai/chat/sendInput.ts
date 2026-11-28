// What a composer hands to `useChat.send`: the words, the attachments that
// have been read, the open file when it is included, unsaved buffers, and a
// model picked for the chat. Used by the AI Chat bar under the editor (the
// chat composer) and kept apart so the shape is tested on its own.

import type { ChatAttachmentInput, ChatCurrentFile } from "../../lib/chatApi";
import type { DraftAttachment, SendInput } from "./chatStore";

export interface SendParts {
  text: string;
  /** The composer's attachments; those still being read are left out. */
  attachments: DraftAttachment[];
  /** Attachments made for this message only, sent before the composer's. */
  extra?: ChatAttachmentInput[];
  currentFile?: ChatCurrentFile;
  dirtyBuffers: { file: string; text: string }[];
  /** A model picked for this chat ("" or missing: the chat's own). */
  model?: string;
}

/** An attachment as the backend takes it. */
export function toAttachmentInput(a: DraftAttachment): ChatAttachmentInput {
  return a.kind === "image" ? { name: a.name, mime: a.mime ?? "image/jpeg", dataUrl: a.dataUrl } : { name: a.name, mime: a.mime ?? "text/plain", text: a.text ?? "" };
}

export function buildSendInput({ text, attachments, extra = [], currentFile, dirtyBuffers, model }: SendParts): SendInput {
  const ready = attachments.filter((a) => a.status === "ready");
  return {
    text,
    attachments: [...extra, ...ready.map(toAttachmentInput)],
    currentFile,
    dirtyBuffers,
    ...(model ? { model } : {}),
  };
}
