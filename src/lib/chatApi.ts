// Bindings for the chat (src-tauri/src/chat): conversations saved per project
// in .texo/ai/chats/<id>.json, and answers streamed as "ai-chat-message"
// events. Keys stay in Rust. Commands reject with the `AiError` shape
// (`isAiError` in ./api); once a message is saved, `send` resolves with the
// assistant message even when the answer failed or was stopped (see its
// `error` and `stopped`).
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AiError } from "./api";

export const CHAT_EVENT = "ai-chat-message";

export type ChatRole = "user" | "assistant";

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StoredAttachment {
  name: string;
  mime: string;
  kind: "text" | "image";
  /** Characters for text, bytes of the data URL for images. */
  size: number;
  /** Images only, for showing them again. */
  dataUrl?: string;
  truncated?: boolean;
}

export interface ContextItem {
  kind: "currentFile" | "selection" | "mention";
  file: string;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
}

export interface ToolUse {
  name: string;
  /** Plain words, e.g. "Read main.tex (lines 1-40)". */
  summary: string;
  ok: boolean;
  ms: number;
}

/** A task the model suggests; the UI shows it as a "Run as task" button. */
export interface ProposedTask {
  prompt: string;
  files: string[];
}

export interface ChatMessageError {
  kind: AiError["kind"];
  message: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Unix milliseconds. */
  created: number;
  attachments?: StoredAttachment[];
  context?: ContextItem[];
  /** The context text the model saw with a user message. */
  contextText?: string;
  tools?: ToolUse[];
  proposedTask?: ProposedTask;
  model?: string;
  usage?: ChatUsage;
  notices?: string[];
  error?: ChatMessageError;
  stopped?: boolean;
}

export interface Chat {
  version: number;
  id: string;
  title: string;
  autoTitle: boolean;
  created: number;
  updated: number;
  /** null: the default chat model. */
  model: string | null;
  messages: ChatMessage[];
}

export interface ChatSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  model: string | null;
  messageCount: number;
  preview: string;
}

/** `text` for text files and PDFs (text extracted in the webview), `dataUrl` for pictures (already downscaled). */
export interface ChatAttachmentInput {
  name: string;
  mime: string;
  text?: string;
  dataUrl?: string;
}

export interface ChatCurrentFile {
  file: string;
  /** The editor text (may be unsaved); read from disk when missing. */
  text?: string;
  selection?: { startLine: number; endLine: number; text: string };
}

export interface ChatSendRequest {
  chatId: string;
  /** Chosen by the UI (to match events and to cancel); generated when empty. */
  requestId: string;
  text: string;
  attachments?: ChatAttachmentInput[];
  /** `@file` mentions (project paths). */
  mentions?: string[];
  /** Only when "Include current file / selection" is on. */
  currentFile?: ChatCurrentFile;
  /** Unsaved editor buffers, read instead of the files on disk. */
  dirtyBuffers?: { file: string; text: string }[];
  /** A model for this message; remembered for the chat. */
  model?: string;
}

export type ChatEventBody =
  | { type: "userMessage"; message: ChatMessage }
  | { type: "delta"; text: string }
  | { type: "replace"; text: string }
  | { type: "notice"; message: string }
  | { type: "toolStarted"; name: string; summary: string }
  | { type: "toolFinished"; tool: ToolUse }
  | { type: "proposedTask"; task: ProposedTask }
  | { type: "done"; message: ChatMessage };

export type ChatEvent = ChatEventBody & { chatId: string; requestId: string };

/** The live state of an answer being written, built from events. */
export interface StreamingAnswer {
  text: string;
  notices: string[];
  /** Tools in order; `running` while the tool works. */
  tools: (ToolUse & { running: boolean })[];
  proposedTask: ProposedTask | null;
  done: ChatMessage | null;
}

export function emptyAnswer(): StreamingAnswer {
  return { text: "", notices: [], tools: [], proposedTask: null, done: null };
}

/** Applies one event to the live answer (pure; for the chat store). */
export function applyChatEvent(a: StreamingAnswer, e: ChatEventBody): StreamingAnswer {
  switch (e.type) {
    case "delta":
      return { ...a, text: a.text + e.text };
    case "replace":
      return { ...a, text: e.text };
    case "notice":
      return a.notices.includes(e.message) ? a : { ...a, notices: [...a.notices, e.message] };
    case "toolStarted":
      return { ...a, tools: [...a.tools, { name: e.name, summary: e.summary, ok: true, ms: 0, running: true }] };
    case "toolFinished": {
      const tools = [...a.tools];
      const i = tools.findIndex((t) => t.running && t.name === e.tool.name);
      if (i >= 0) tools[i] = { ...e.tool, running: false };
      else tools.push({ ...e.tool, running: false });
      return { ...a, tools };
    }
    case "proposedTask":
      return { ...a, proposedTask: e.task };
    case "done":
      return {
        text: e.message.text,
        notices: e.message.notices ?? a.notices,
        tools: (e.message.tools ?? []).map((t) => ({ ...t, running: false })),
        proposedTask: e.message.proposedTask ?? null,
        done: e.message,
      };
    case "userMessage":
      return a;
  }
}

export function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** `@path` mentions in the composer text (paths without spaces). */
export function findMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([\w./\\-]+[\w])/g)) {
    const p = m[1].replace(/\\/g, "/");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export const chatApi = {
  list: (project: string) => invoke<ChatSummary[]>("ai_chat_list", { project }),
  get: (project: string, chatId: string) => invoke<Chat>("ai_chat_get", { project, chatId }),
  create: (project: string, model?: string | null) => invoke<Chat>("ai_chat_new", { project, model: model ?? null }),
  rename: (project: string, chatId: string, title: string) =>
    invoke<ChatSummary>("ai_chat_rename", { project, chatId, title }),
  /** Ask the user first. A running answer is stopped. */
  remove: (project: string, chatId: string) => invoke<void>("ai_chat_delete", { project, chatId }),
  send: (project: string, request: ChatSendRequest) => invoke<ChatMessage>("ai_chat_send", { project, request }),
  /** False when the answer already ended. */
  cancel: (requestId: string) => invoke<boolean>("ai_chat_cancel", { requestId }),
  /** Events of every chat; filter by `chatId` / `requestId`. */
  onEvent: (handler: (e: ChatEvent) => void): Promise<UnlistenFn> =>
    listen<ChatEvent>(CHAT_EVENT, (ev) => handler(ev.payload)),
};
