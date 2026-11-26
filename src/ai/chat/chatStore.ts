// The Chat tab's state: the project's conversations, the open one, answers
// being written (streamed from "ai-chat-message" events), the composer's
// drafts and attachments, and why a message couldn't be sent. Talks to Rust
// only through src/lib/chatApi.ts; keys never reach this side.

import { create } from "zustand";
import {
  applyChatEvent,
  chatApi,
  emptyAnswer,
  findMentions,
  newRequestId,
  type Chat,
  type ChatAttachmentInput,
  type ChatCurrentFile,
  type ChatEvent,
  type ChatMessage,
  type ChatSendRequest,
  type ChatSummary,
  type StreamingAnswer,
} from "../../lib/chatApi";
import { isAiError, type AiError } from "../../lib/api";

/** An attachment in the composer, while it is read and once it is ready. */
export interface DraftAttachment {
  id: string;
  name: string;
  status: "reading" | "ready";
  kind?: "image" | "text";
  mime?: string;
  dataUrl?: string;
  text?: string;
  note?: string;
}

/** An answer being written for one chat. */
export interface PendingAnswer {
  requestId: string;
  /** The message as sent, shown until the saved one arrives. */
  user: ChatMessage;
  answer: StreamingAnswer;
  stopping: boolean;
}

/** Why a message wasn't sent (nothing was saved); "Try again" resends `request`. */
export interface SendFailure {
  chatId: string;
  kind: AiError["kind"] | "busy";
  message: string;
  retryAfter: number | null;
  /** Unix ms when it happened (for the rate-limit countdown). */
  at: number;
  request: ChatSendRequest;
}

/** What the composer hands to `send`. */
export interface SendInput {
  text: string;
  attachments: ChatAttachmentInput[];
  currentFile?: ChatCurrentFile;
  dirtyBuffers?: { file: string; text: string }[];
  /** A model picked for this message (remembered for the chat by the backend). */
  model?: string;
}

const LAST_CHAT_KEY = "texo.chat.last";
const CONTEXT_KEY = "texo.chat.includeContext";

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Remembered for this session only.
  }
}

/** The last chat opened in a project, remembered per project folder. */
export function lastChatKey(project: string): string {
  return `${LAST_CHAT_KEY}:${projectKey(project)}`;
}

/** A project folder as a storage key (same folder, same key, however it was spelled). */
function projectKey(project: string): string {
  return project.replace(/\\/g, "/").toLowerCase();
}

/** The chat to open when the panel starts: the remembered one if it still exists, else the most recent. */
export function pickStartChat(chats: ChatSummary[], remembered: string | null): string | null {
  if (remembered && chats.some((c) => c.id === remembered)) return remembered;
  if (!chats.length) return null;
  return [...chats].sort((a, b) => b.updated - a.updated)[0].id;
}

/** A failure from any rejected chat command, in the AI error shape. */
export function toFailureKind(err: unknown): { kind: SendFailure["kind"]; message: string; retryAfter: number | null } {
  if (isAiError(err)) {
    const busy = err.kind === "invalidInput" && /still answering/i.test(err.message);
    return { kind: busy ? "busy" : err.kind, message: err.message, retryAfter: err.retryAfterSecs ?? null };
  }
  const message = typeof err === "string" ? err : err instanceof Error ? err.message : "Something went wrong.";
  return { kind: "other", message, retryAfter: null };
}

/** The local copy of a message while it is being sent. */
export function optimisticUser(request: ChatSendRequest, now = Date.now()): ChatMessage {
  return {
    id: `local-${request.requestId}`,
    role: "user",
    text: request.text,
    created: now,
    attachments: (request.attachments ?? []).map((a) => ({
      name: a.name,
      mime: a.mime,
      kind: a.dataUrl ? "image" : "text",
      size: a.dataUrl ? a.dataUrl.length : (a.text ?? "").length,
      ...(a.dataUrl ? { dataUrl: a.dataUrl } : {}),
    })),
    context: [
      ...(request.currentFile
        ? [
            request.currentFile.selection
              ? {
                  kind: "selection" as const,
                  file: request.currentFile.file,
                  startLine: request.currentFile.selection.startLine,
                  endLine: request.currentFile.selection.endLine,
                }
              : { kind: "currentFile" as const, file: request.currentFile.file },
          ]
        : []),
      ...(request.mentions ?? []).map((file) => ({ kind: "mention" as const, file })),
    ],
  };
}

/** Puts a summary first in the list (after a send or rename) without reloading it. */
export function upsertSummary(list: ChatSummary[], s: ChatSummary): ChatSummary[] {
  return [s, ...list.filter((c) => c.id !== s.id)].sort((a, b) => b.updated - a.updated);
}

export function summaryOf(chat: Chat): ChatSummary {
  const last = chat.messages[chat.messages.length - 1];
  return {
    id: chat.id,
    title: chat.title,
    created: chat.created,
    updated: chat.updated,
    model: chat.model,
    messageCount: chat.messages.length,
    preview: (last?.text ?? "").slice(0, 120),
  };
}

interface ChatStore {
  project: string | null;
  chats: ChatSummary[];
  listLoaded: boolean;
  listError: string | null;
  current: Chat | null;
  loadingChat: boolean;
  /** Answers being written, by chat id. */
  pending: Record<string, PendingAnswer>;
  failure: SendFailure | null;
  /** Composer text per chat ("" key: a chat not created yet). */
  drafts: Record<string, string>;
  attachments: DraftAttachment[];
  includeContext: boolean;
  /** A model picked in the composer for the next message of a chat. */
  modelChoice: Record<string, string>;
  /** Suggested tasks already handed to the task agent, by `taskKey` (survives the answer being saved and the chat being reopened). */
  startedTasks: Partial<Record<string, "starting" | "started">>;

  init: (project: string) => Promise<void>;
  reset: () => void;
  refreshList: () => Promise<void>;
  open: (chatId: string) => Promise<void>;
  /** Shows an empty chat; it is created on the first message. */
  startNew: () => void;
  rename: (chatId: string, title: string) => Promise<void>;
  /** The UI asks first. */
  remove: (chatId: string) => Promise<void>;
  send: (input: SendInput) => Promise<void>;
  retry: () => Promise<void>;
  /** Re-sends the user message before a failed or stopped answer. */
  resendLast: () => Promise<void>;
  stop: () => Promise<void>;
  handleEvent: (e: ChatEvent) => void;
  setDraft: (text: string) => void;
  setIncludeContext: (on: boolean) => void;
  setModelChoice: (model: string) => void;
  addAttachment: (a: DraftAttachment) => void;
  updateAttachment: (id: string, patch: Partial<DraftAttachment>) => void;
  removeAttachment: (id: string) => void;
  dismissFailure: () => void;
  /** Marks a suggested task as starting/started, or clears it (`null`) when starting failed. */
  setTaskState: (key: string, state: "starting" | "started" | null) => void;
}

/** Keeps the last request per chat so "Try again" after a failed answer resends the same thing. */
const lastRequest = new Map<string, ChatSendRequest>();

/** The project the composer drafts and model picks belong to (they don't follow you to another project). */
let draftsProject: string | null = null;

/** Bumped by every open/startNew: only the newest one may set the open chat. */
let openToken = 0;

/** The key for a suggested task in a chat ("Run as task" is offered once per suggestion). */
export function taskKey(chatId: string, task: { prompt: string; files: string[] }): string {
  return `${chatId}\u0000${task.prompt}\u0000${task.files.join("\u0000")}`;
}

const STARTED_TASKS_KEY = "texo.chat.startedTasks";
const MAX_STARTED_TASKS = 200;

function readStartedTasks(project: string): Record<string, "started"> {
  try {
    const list = JSON.parse(readLocal(`${STARTED_TASKS_KEY}:${projectKey(project)}`) ?? "[]");
    return Array.isArray(list) ? Object.fromEntries(list.filter((k) => typeof k === "string").map((k: string) => [k, "started" as const])) : {};
  } catch {
    return {};
  }
}

function writeStartedTasks(project: string, started: Record<string, unknown>) {
  const keys = Object.keys(started).slice(-MAX_STARTED_TASKS);
  writeLocal(`${STARTED_TASKS_KEY}:${projectKey(project)}`, JSON.stringify(keys));
}

function initialIncludeContext(): boolean {
  return readLocal(CONTEXT_KEY) !== "0";
}

export const useChat = create<ChatStore>((set, get) => {
  /** Sends a prepared request (a new message, or the same one again). */
  const dispatch = async (request: ChatSendRequest) => {
    const project = get().project;
    if (!project) return;
    const chatId = request.chatId;
    lastRequest.set(chatId, request);
    set((s) => ({
      failure: null,
      pending: {
        ...s.pending,
        [chatId]: { requestId: request.requestId, user: optimisticUser(request), answer: emptyAnswer(), stopping: false },
      },
    }));
    try {
      await chatApi.send(project, request);
    } catch (err) {
      const f = toFailureKind(err);
      if (get().project !== project) return;
      set((s) => {
        const pending = { ...s.pending };
        delete pending[chatId];
        return {
          pending,
          failure: { chatId, ...f, at: Date.now(), request },
          // Put the words back so nothing is lost.
          drafts: s.drafts[chatId] ? s.drafts : { ...s.drafts, [chatId]: request.text },
        };
      });
      return;
    }
    if (get().project !== project) return;
    // The saved messages are the truth: re-read the chat, and swap the live
    // answer for them in one go (no frame shows both).
    let chat: Chat | null = null;
    try {
      chat = await chatApi.get(project, chatId);
    } catch {
      // Deleted meanwhile.
      void get().refreshList();
    }
    if (get().project !== project) return;
    set((s) => {
      const pending = { ...s.pending };
      if (pending[chatId]?.requestId === request.requestId) delete pending[chatId];
      if (!chat) return { pending };
      return {
        pending,
        chats: upsertSummary(s.chats, summaryOf(chat)),
        ...(s.current?.id === chatId ? { current: chat } : {}),
      };
    });
  };

  return {
    project: null,
    chats: [],
    listLoaded: false,
    listError: null,
    current: null,
    loadingChat: false,
    pending: {},
    failure: null,
    drafts: {},
    attachments: [],
    includeContext: initialIncludeContext(),
    modelChoice: {},
    startedTasks: {},

    init: async (project) => {
      if (get().project === project && get().listLoaded) return;
      openToken++;
      // A draft or model picked in another project's new chat stays there.
      const switching = draftsProject !== project;
      draftsProject = project;
      set({
        project,
        chats: [],
        listLoaded: false,
        listError: null,
        current: null,
        pending: {},
        failure: null,
        attachments: [],
        ...(switching ? { drafts: {}, modelChoice: {}, startedTasks: readStartedTasks(project) } : {}),
      });
      await get().refreshList();
      if (get().project !== project) return;
      const start = pickStartChat(get().chats, readLocal(lastChatKey(project)));
      if (start) await get().open(start);
    },

    reset: () => {
      openToken++;
      set({ project: null, chats: [], listLoaded: false, listError: null, current: null, pending: {}, failure: null, attachments: [] });
    },

    refreshList: async () => {
      const project = get().project;
      if (!project) return;
      try {
        const chats = await chatApi.list(project);
        if (get().project !== project) return;
        set({ chats, listLoaded: true, listError: null });
      } catch (err) {
        if (get().project !== project) return;
        set({ listLoaded: true, listError: toFailureKind(err).message });
      }
    },

    open: async (chatId) => {
      const project = get().project;
      if (!project) return;
      const token = ++openToken;
      // A newer open (or "New chat") wins over this one, whichever answers last.
      const stale = () => token !== openToken || get().project !== project;
      set({ loadingChat: true, failure: null });
      try {
        const chat = await chatApi.get(project, chatId);
        if (stale()) return;
        set({ current: chat, loadingChat: false });
        writeLocal(lastChatKey(project), chat.id);
      } catch (err) {
        if (stale()) return;
        set({ loadingChat: false, current: null, listError: toFailureKind(err).message });
        void get().refreshList();
      }
    },

    startNew: () => {
      openToken++;
      set({ current: null, failure: null, loadingChat: false });
      const project = get().project;
      if (project) writeLocal(lastChatKey(project), null);
    },

    rename: async (chatId, title) => {
      const project = get().project;
      if (!project) return;
      const summary = await chatApi.rename(project, chatId, title);
      set((s) => ({
        chats: s.chats.map((c) => (c.id === chatId ? summary : c)),
        current: s.current?.id === chatId ? { ...s.current, title: summary.title, autoTitle: false } : s.current,
      }));
    },

    remove: async (chatId) => {
      const project = get().project;
      if (!project) return;
      await chatApi.remove(project, chatId);
      lastRequest.delete(chatId);
      set((s) => {
        const pending = { ...s.pending };
        delete pending[chatId];
        const drafts = { ...s.drafts };
        delete drafts[chatId];
        return {
          chats: s.chats.filter((c) => c.id !== chatId),
          current: s.current?.id === chatId ? null : s.current,
          pending,
          drafts,
          failure: s.failure?.chatId === chatId ? null : s.failure,
        };
      });
      if (get().current === null) {
        const next = pickStartChat(get().chats, null);
        if (next) await get().open(next);
        else writeLocal(lastChatKey(project), null);
      }
    },

    send: async (input) => {
      const project = get().project;
      const text = input.text.trim();
      if (!project || (!text && input.attachments.length === 0)) return;
      let chat = get().current;
      if (!chat) {
        try {
          chat = await chatApi.create(project, input.model ?? null);
        } catch (err) {
          const f = toFailureKind(err);
          set({ failure: { chatId: "", ...f, at: Date.now(), request: { chatId: "", requestId: "", text } } });
          return;
        }
        if (get().project !== project) return;
        const created = chat;
        set((s) => ({ current: created, chats: upsertSummary(s.chats, summaryOf(created)), drafts: { ...s.drafts, "": "" } }));
        writeLocal(lastChatKey(project), chat.id);
      }
      if (get().pending[chat.id]) return;
      const request: ChatSendRequest = {
        chatId: chat.id,
        requestId: newRequestId(),
        text,
        ...(input.attachments.length ? { attachments: input.attachments } : {}),
        ...(findMentions(text).length ? { mentions: findMentions(text) } : {}),
        ...(input.currentFile ? { currentFile: input.currentFile } : {}),
        ...(input.dirtyBuffers?.length ? { dirtyBuffers: input.dirtyBuffers } : {}),
        ...(input.model ? { model: input.model } : {}),
      };
      const chatId = chat.id;
      set((s) => ({ drafts: { ...s.drafts, [chatId]: "" }, attachments: [] }));
      await dispatch(request);
    },

    retry: async () => {
      const f = get().failure;
      if (!f || !f.request.chatId) {
        set({ failure: null });
        return;
      }
      set((s) => ({ drafts: { ...s.drafts, [f.request.chatId]: "" } }));
      await dispatch({ ...f.request, requestId: newRequestId() });
    },

    resendLast: async () => {
      const chat = get().current;
      if (!chat || get().pending[chat.id]) return;
      const saved = lastRequest.get(chat.id);
      if (saved) {
        await dispatch({ ...saved, requestId: newRequestId() });
        return;
      }
      // After a restart: the saved message's words and pictures.
      const user = [...chat.messages].reverse().find((m) => m.role === "user");
      if (!user) return;
      const attachments = (user.attachments ?? [])
        .filter((a) => a.kind === "image" && a.dataUrl)
        .map((a) => ({ name: a.name, mime: a.mime, dataUrl: a.dataUrl }));
      await dispatch({
        chatId: chat.id,
        requestId: newRequestId(),
        text: user.text,
        ...(attachments.length ? { attachments } : {}),
        ...(findMentions(user.text).length ? { mentions: findMentions(user.text) } : {}),
      });
    },

    stop: async () => {
      const chat = get().current;
      const p = chat ? get().pending[chat.id] : undefined;
      if (!chat || !p) return;
      set((s) => ({ pending: { ...s.pending, [chat.id]: { ...p, stopping: true } } }));
      try {
        await chatApi.cancel(p.requestId);
      } catch {
        // It ends on its own; the saved answer says so.
      }
    },

    handleEvent: (e) => {
      const p = get().pending[e.chatId];
      if (!p || p.requestId !== e.requestId) return;
      if (e.type === "userMessage") {
        set((s) => ({ pending: { ...s.pending, [e.chatId]: { ...p, user: e.message } } }));
        return;
      }
      set((s) => ({ pending: { ...s.pending, [e.chatId]: { ...p, answer: applyChatEvent(p.answer, e) } } }));
    },

    setDraft: (text) => {
      const id = get().current?.id ?? "";
      set((s) => ({ drafts: { ...s.drafts, [id]: text } }));
    },

    setIncludeContext: (on) => {
      writeLocal(CONTEXT_KEY, on ? "1" : "0");
      set({ includeContext: on });
    },

    setModelChoice: (model) => {
      const id = get().current?.id ?? "";
      set((s) => ({ modelChoice: { ...s.modelChoice, [id]: model } }));
    },

    addAttachment: (a) => set((s) => ({ attachments: [...s.attachments, a] })),
    updateAttachment: (id, patch) => set((s) => ({ attachments: s.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
    removeAttachment: (id) => set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
    dismissFailure: () => set({ failure: null }),

    setTaskState: (key, state) => {
      const project = get().project;
      set((s) => {
        const startedTasks = { ...s.startedTasks };
        if (state) startedTasks[key] = state;
        else delete startedTasks[key];
        if (project && state !== "starting") writeStartedTasks(project, Object.fromEntries(Object.entries(startedTasks).filter(([, v]) => v === "started")));
        return { startedTasks };
      });
    },
  };
});

/** One listener for every chat's events, started with the panel. */
let unlisten: Promise<() => void> | null = null;
export function listenChatEvents() {
  if (!unlisten) unlisten = chatApi.onEvent((e) => useChat.getState().handleEvent(e)).catch(() => () => {});
}
