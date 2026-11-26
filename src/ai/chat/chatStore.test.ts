import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, ChatSendRequest, ChatSummary } from "../../lib/chatApi";

// The backend, replaced by an in-memory one.
const h = vi.hoisted(() => ({
  chats: new Map<string, Chat>(),
  send: null as null | ((project: string, req: ChatSendRequest) => Promise<ChatMessage>),
  cancelled: [] as string[],
}));

vi.mock("../../lib/chatApi", async (orig) => {
  const real = await orig<typeof import("../../lib/chatApi")>();
  const summary = (c: Chat): ChatSummary => ({
    id: c.id,
    title: c.title,
    created: c.created,
    updated: c.updated,
    model: c.model,
    messageCount: c.messages.length,
    preview: "",
  });
  let n = 0;
  return {
    ...real,
    chatApi: {
      list: vi.fn(async () => [...h.chats.values()].map(summary)),
      get: vi.fn(async (_p: string, id: string) => {
        const c = h.chats.get(id);
        if (!c) throw { kind: "notFound", message: "That chat no longer exists.", retryAfterSecs: null };
        return structuredClone(c);
      }),
      create: vi.fn(async (_p: string, model: string | null) => {
        const c: Chat = { version: 1, id: `c${++n}`, title: "New chat", autoTitle: true, created: n, updated: 1000 + n, model, messages: [] };
        h.chats.set(c.id, c);
        return structuredClone(c);
      }),
      rename: vi.fn(async (_p: string, id: string, title: string) => {
        const c = h.chats.get(id)!;
        c.title = title;
        return summary(c);
      }),
      remove: vi.fn(async (_p: string, id: string) => void h.chats.delete(id)),
      send: vi.fn((p: string, req: ChatSendRequest) => h.send!(p, req)),
      cancel: vi.fn(async (id: string) => {
        h.cancelled.push(id);
        return true;
      }),
      onEvent: vi.fn(async () => () => {}),
    },
  };
});

import { lastChatKey, optimisticUser, pickStartChat, taskKey, toFailureKind, useChat } from "./chatStore";

const msg = (role: "user" | "assistant", text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `${role}-${text}`,
  role,
  text,
  created: 1,
  ...extra,
});

/** A backend answer: saves both messages, like ai_chat_send. */
function answerWith(text: string, extra: Partial<ChatMessage> = {}) {
  h.send = async (_p, req) => {
    const c = h.chats.get(req.chatId)!;
    const a = msg("assistant", text, extra);
    c.messages.push(msg("user", req.text), a);
    c.updated += 10;
    return a;
  };
}

beforeEach(() => {
  h.chats.clear();
  h.cancelled = [];
  h.send = null;
  useChat.getState().reset();
  useChat.setState({ drafts: {}, modelChoice: {}, attachments: [], startedTasks: {} });
});

describe("helpers", () => {
  it("opens the remembered chat, else the newest", () => {
    const list = [
      { id: "a", updated: 1 },
      { id: "b", updated: 5 },
    ] as ChatSummary[];
    expect(pickStartChat(list, "a")).toBe("a");
    expect(pickStartChat(list, "gone")).toBe("b");
    expect(pickStartChat([], null)).toBeNull();
    expect(lastChatKey("C:\\Papers\\One")).toBe(lastChatKey("c:/papers/one"));
  });

  it("maps errors, including a chat that is still answering", () => {
    expect(toFailureKind({ kind: "rateLimited", message: "Slow down", retryAfterSecs: 20 })).toEqual({
      kind: "rateLimited",
      message: "Slow down",
      retryAfter: 20,
    });
    expect(toFailureKind({ kind: "invalidInput", message: "This chat is still answering.", retryAfterSecs: null }).kind).toBe("busy");
    expect(toFailureKind("boom")).toEqual({ kind: "other", message: "boom", retryAfter: null });
  });

  it("shows what was sent while it is sent", () => {
    const u = optimisticUser({
      chatId: "c",
      requestId: "r",
      text: "hi @main.tex",
      mentions: ["main.tex"],
      attachments: [{ name: "a.jpg", mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA" }],
      currentFile: { file: "intro.tex", selection: { startLine: 2, endLine: 4, text: "x" } },
    });
    expect(u.attachments?.[0].kind).toBe("image");
    expect(u.context).toEqual([
      { kind: "selection", file: "intro.tex", startLine: 2, endLine: 4 },
      { kind: "mention", file: "main.tex" },
    ]);
  });
});

describe("chat store", () => {
  it("creates the chat on the first message and streams the answer", async () => {
    await useChat.getState().init("P");
    expect(useChat.getState().current).toBeNull();

    let finish!: () => void;
    h.send = (_p, req) =>
      new Promise((resolve) => {
        finish = () => {
          const c = h.chats.get(req.chatId)!;
          const a = msg("assistant", "Hello there");
          c.messages.push(msg("user", req.text), a);
          resolve(a);
        };
      });
    const sending = useChat.getState().send({ text: "  Hi  ", attachments: [] });
    await vi.waitFor(() => expect(Object.keys(useChat.getState().pending)).toHaveLength(1));
    const chatId = useChat.getState().current!.id;
    const p = useChat.getState().pending[chatId];
    expect(p.user.text).toBe("Hi");

    const ev = { chatId, requestId: p.requestId };
    useChat.getState().handleEvent({ ...ev, type: "delta", text: "Hel" });
    useChat.getState().handleEvent({ ...ev, type: "delta", text: "lo" });
    useChat.getState().handleEvent({ chatId, requestId: "other", type: "delta", text: "ignored" });
    expect(useChat.getState().pending[chatId].answer.text).toBe("Hello");

    finish();
    await sending;
    expect(useChat.getState().pending[chatId]).toBeUndefined();
    expect(useChat.getState().current!.messages.map((m) => m.text)).toEqual(["Hi", "Hello there"]);
    expect(useChat.getState().chats[0].id).toBe(chatId);
  });

  it("keeps the words and offers a retry when sending is refused", async () => {
    await useChat.getState().init("P");
    await useChat.getState().send({ text: "first", attachments: [] });
    h.send = async () => {
      throw { kind: "rateLimited", message: "Too many requests.", retryAfterSecs: 30 };
    };
    // first send above had no backend: it failed too; start clean.
    useChat.getState().dismissFailure();
    useChat.getState().setDraft("second");
    await useChat.getState().send({ text: "second", attachments: [] });
    const f = useChat.getState().failure!;
    expect(f.kind).toBe("rateLimited");
    expect(f.retryAfter).toBe(30);
    const chatId = useChat.getState().current!.id;
    expect(useChat.getState().drafts[chatId]).toBe("second");
    expect(useChat.getState().pending[chatId]).toBeUndefined();

    answerWith("ok now");
    await useChat.getState().retry();
    expect(useChat.getState().failure).toBeNull();
    expect(useChat.getState().current!.messages.at(-1)!.text).toBe("ok now");
    expect(useChat.getState().drafts[chatId]).toBe("");
  });

  it("stops the running answer", async () => {
    await useChat.getState().init("P");
    let release!: () => void;
    h.send = (_p, req) =>
      new Promise((resolve) => {
        release = () => {
          const a = msg("assistant", "partial", { stopped: true });
          h.chats.get(req.chatId)!.messages.push(msg("user", req.text), a);
          resolve(a);
        };
      });
    const sending = useChat.getState().send({ text: "long one", attachments: [] });
    await vi.waitFor(() => expect(Object.keys(useChat.getState().pending)).toHaveLength(1));
    const chatId = useChat.getState().current!.id;
    const requestId = useChat.getState().pending[chatId].requestId;
    await useChat.getState().stop();
    expect(h.cancelled).toEqual([requestId]);
    expect(useChat.getState().pending[chatId].stopping).toBe(true);
    release();
    await sending;
    expect(useChat.getState().current!.messages.at(-1)!.stopped).toBe(true);
  });

  it("opens the last chat on start, renames and deletes", async () => {
    answerWith("a1");
    await useChat.getState().init("P");
    await useChat.getState().send({ text: "one", attachments: [] });
    const first = useChat.getState().current!.id;
    useChat.getState().startNew();
    await useChat.getState().send({ text: "two", attachments: [] });
    const second = useChat.getState().current!.id;
    expect(second).not.toBe(first);

    // A fresh start of the panel opens the newest (localStorage isn't there in Node).
    useChat.getState().reset();
    await useChat.getState().init("P");
    expect(useChat.getState().current?.id).toBe(second);

    await useChat.getState().rename(second, "Abstract ideas");
    expect(useChat.getState().current!.title).toBe("Abstract ideas");
    expect(useChat.getState().chats.find((c) => c.id === second)!.title).toBe("Abstract ideas");

    await useChat.getState().remove(second);
    expect(useChat.getState().chats.map((c) => c.id)).toEqual([first]);
    expect(useChat.getState().current?.id).toBe(first);
  });

  it("resends the last message after a failed answer", async () => {
    answerWith("broken", { error: { kind: "server", message: "The provider had a problem." } });
    await useChat.getState().init("P");
    await useChat.getState().send({ text: "explain", attachments: [] });
    expect(useChat.getState().current!.messages.at(-1)!.error?.kind).toBe("server");
    answerWith("fixed");
    await useChat.getState().resendLast();
    const texts = useChat.getState().current!.messages.map((m) => m.text);
    expect(texts).toEqual(["explain", "broken", "explain", "fixed"]);
  });
});

describe("chat store races and carry-over", () => {
  it("shows the chat opened last, whichever answers first (FE-7)", async () => {
    answerWith("x");
    await useChat.getState().init("P");
    await useChat.getState().send({ text: "one", attachments: [] });
    const a = useChat.getState().current!.id;
    useChat.getState().startNew();
    await useChat.getState().send({ text: "two", attachments: [] });
    const b = useChat.getState().current!.id;

    // A answers after B.
    const get = vi.mocked((await import("../../lib/chatApi")).chatApi.get);
    let releaseA!: () => void;
    const real = get.getMockImplementation()!;
    get.mockImplementationOnce((p, id) => new Promise((resolve) => (releaseA = () => resolve(real(p, id)))));
    const openA = useChat.getState().open(a);
    await useChat.getState().open(b);
    releaseA();
    await openA;
    expect(useChat.getState().current?.id).toBe(b);

    // "New chat" also wins over an open still on its way.
    get.mockImplementationOnce((p, id) => new Promise((resolve) => (releaseA = () => resolve(real(p, id)))));
    const late = useChat.getState().open(a);
    useChat.getState().startNew();
    releaseA();
    await late;
    expect(useChat.getState().current).toBeNull();
  });

  it("doesn't carry a new chat's draft or model into another project (FE-9)", async () => {
    await useChat.getState().init("A");
    useChat.getState().setDraft("half a thought");
    useChat.getState().setModelChoice("big-model");
    await useChat.getState().init("B");
    expect(useChat.getState().drafts[""] ?? "").toBe("");
    expect(useChat.getState().modelChoice[""]).toBeUndefined();

    // Re-opening the same project keeps them.
    useChat.getState().setDraft("keep me");
    useChat.getState().reset();
    await useChat.getState().init("B");
    expect(useChat.getState().drafts[""]).toBe("keep me");
  });

  it("remembers a suggested task was started, past the answer being saved (FE-8)", async () => {
    await useChat.getState().init("P");
    const task = { prompt: "Shorten the abstract", files: ["main.tex"] };
    const key = taskKey("c1", task);
    expect(taskKey("c2", task)).not.toBe(key);
    useChat.getState().setTaskState(key, "starting");
    expect(useChat.getState().startedTasks[key]).toBe("starting");
    useChat.getState().setTaskState(key, "started");
    // A fresh card (the saved message, or the chat reopened) reads the store.
    useChat.getState().reset();
    await useChat.getState().init("P");
    expect(useChat.getState().startedTasks[key]).toBe("started");
    // A failed start can be tried again.
    useChat.getState().setTaskState(key, null);
    expect(useChat.getState().startedTasks[key]).toBeUndefined();
  });
});
