// The chat's message list: your messages with their pictures and context,
// answers rendered as Markdown (maths, code with Insert / Copy), the tools an
// answer used, notices, errors with "Try again", and suggested tasks.

import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, AtSign, Check, FileText, ListChecks, Loader2, Play, RotateCcw, Square, TextSelect, Wrench } from "lucide-react";
import type { ChatMessage, ProposedTask, ToolUse } from "../../lib/chatApi";
import { agentsApi } from "../../lib/agentsApi";
import { errorText } from "../../lib/api";
import { toast } from "../../ui";
import { insertAtCursor } from "../../workspace/editorBridge";
import { baseName } from "../../workspace/paths";
import { useAiPanel } from "../panel/aiPanelStore";
import { taskKey, useChat, type PendingAnswer } from "./chatStore";
import { dirtyBuffers } from "./composerActions";
import { isOpenableLink, renderMarkdown } from "./markdown";

/** Clicks on code-block buttons and links inside rendered Markdown. */
function onMarkdownClick(e: MouseEvent<HTMLDivElement>, codes: string[]) {
  const target = e.target as HTMLElement;
  const btn = target.closest<HTMLButtonElement>("button[data-code-action]");
  if (btn) {
    const code = codes[Number(btn.dataset.codeIndex)];
    if (code === undefined) return;
    if (btn.dataset.codeAction === "copy") {
      void navigator.clipboard.writeText(code).then(
        () => toast("Copied.", "success"),
        () => toast("Texo couldn't copy to the clipboard.", "error"),
      );
    } else {
      const file = insertAtCursor(code);
      if (file) toast(`Inserted into ${baseName(file)}. Ctrl+Z takes it out again.`, "success");
      else toast("Open a file in the editor first, then insert.", "info");
    }
    return;
  }
  const link = target.closest<HTMLAnchorElement>("a");
  if (link) {
    e.preventDefault();
    const href = link.getAttribute("href");
    if (isOpenableLink(href)) void openUrl(href).catch(() => toast("Texo couldn't open that link.", "error"));
  }
}

const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const { html, codes } = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={`chat-md ${streaming ? "chat-caret" : ""}`}
      onClick={(e) => onMarkdownClick(e, codes)}
      // Safe: markdown-it runs with raw HTML off, so this is its own markup and KaTeX's.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

function ContextChips({ message }: { message: ChatMessage }) {
  const items = message.context ?? [];
  if (!items.length) return null;
  return (
    <div className="mt-1 flex flex-wrap justify-end gap-1">
      {items.map((c, i) => (
        <span key={i} title={c.file} className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-muted">
          {c.kind === "mention" ? <AtSign size={11} /> : c.kind === "selection" ? <TextSelect size={11} /> : <FileText size={11} />}
          <span className="truncate">
            {baseName(c.file)}
            {c.kind === "selection" && c.startLine ? ` (lines ${c.startLine}–${c.endLine ?? c.startLine})` : ""}
            {c.truncated ? " (start only)" : ""}
          </span>
        </span>
      ))}
    </div>
  );
}

function UserMessage({ message, sending }: { message: ChatMessage; sending?: boolean }) {
  const pictures = (message.attachments ?? []).filter((a) => a.kind === "image" && a.dataUrl);
  const files = (message.attachments ?? []).filter((a) => a.kind !== "image");
  return (
    <div className={`ml-8 flex flex-col items-end ${sending ? "opacity-80" : ""}`}>
      {pictures.length > 0 && (
        <div className="mb-1 flex flex-wrap justify-end gap-1">
          {pictures.map((a, i) => (
            <img key={i} src={a.dataUrl} alt={a.name} title={a.name} className="h-16 max-w-28 rounded-md border border-border object-cover" />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-1 flex flex-wrap justify-end gap-1">
          {files.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-muted">
              <FileText size={11} /> {a.name}
              {a.truncated ? " (start only)" : ""}
            </span>
          ))}
        </div>
      )}
      {message.text && <div className="max-w-full select-text whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-accent/15 px-3 py-2">{message.text}</div>}
      <ContextChips message={message} />
    </div>
  );
}

function ToolList({ tools }: { tools: (ToolUse & { running?: boolean })[] }) {
  if (!tools.length) return null;
  return (
    <ul className="mb-1.5 space-y-0.5 text-[11px] text-muted">
      {tools.map((t, i) => (
        <li key={i} className="flex items-center gap-1.5">
          {t.running ? (
            <Loader2 size={11} className="animate-spin" />
          ) : t.ok ? (
            <Wrench size={11} />
          ) : (
            <AlertTriangle size={11} className="text-danger" />
          )}
          <span className="truncate">{t.summary || t.name}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Run as task": hands the suggestion to the task agent. */
function TaskCard({ task }: { task: ProposedTask }) {
  const project = useChat((s) => s.project);
  // Kept in the store, not here: the streaming card is replaced by the saved
  // one, and a reopened chat shows the card again (FE-8).
  const key = useChat((s) => taskKey(s.current?.id ?? "", task));
  const state = useChat((s) => s.startedTasks[key] ?? "idle");
  const run = async () => {
    if (!project || useChat.getState().startedTasks[key]) return;
    const setState = (next: "starting" | "started" | "idle") => useChat.getState().setTaskState(key, next === "idle" ? null : next);
    setState("starting");
    const files = task.files.filter(Boolean);
    const prompt = files.length ? `${task.prompt}\n\nFiles to work on: ${files.join(", ")}` : task.prompt;
    try {
      await agentsApi.start(project, {
        kind: "task",
        prompt,
        dirtyBuffers: dirtyBuffers(),
        options: { title: task.prompt.split("\n")[0].slice(0, 80) },
      });
      setState("started");
      toast("Task started. Its changes wait for your review in the Agents tab.", "success");
      useAiPanel.getState().show("agents");
    } catch (err) {
      setState("idle");
      toast(errorText(err), "error");
    }
  };
  return (
    <div className="mt-2 rounded-lg border border-accent/30 bg-accent/5 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
        <ListChecks size={13} className="text-accent" /> Suggested task
      </div>
      <p className="select-text whitespace-pre-wrap text-[13px]">{task.prompt}</p>
      {task.files.length > 0 && <p className="mt-1 truncate text-[11px] text-muted">Files: {task.files.join(", ")}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={state !== "idle"}
          onClick={() => void run()}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-ink hover:bg-accent-strong disabled:opacity-60"
        >
          {state === "starting" ? <Loader2 size={12} className="animate-spin" /> : state === "started" ? <Check size={12} /> : <Play size={12} />}
          {state === "started" ? "Started" : "Run as task"}
        </button>
        <span className="text-[11px] text-muted">Nothing changes until you review it.</span>
      </div>
    </div>
  );
}

function AssistantMessage({ message, last }: { message: ChatMessage; last: boolean }) {
  const resendLast = useChat((s) => s.resendLast);
  const busy = useChat((s) => (s.current ? !!s.pending[s.current.id] : false));
  return (
    <div className="mr-2">
      <ToolList tools={message.tools ?? []} />
      {message.text && <Markdown text={message.text} />}
      {message.notices?.map((n, i) => (
        <p key={i} className="mt-1 text-[11px] text-muted">
          {n}
        </p>
      ))}
      {message.stopped && <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted"><Square size={10} /> Stopped</p>}
      {message.error && (
        <div role="alert" className="mt-1.5 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2 text-[13px]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
          <span className="flex-1">{message.error.message}</span>
          {last && (
            <button type="button" disabled={busy} onClick={() => void resendLast()} className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline disabled:opacity-50">
              <RotateCcw size={12} /> Try again
            </button>
          )}
        </div>
      )}
      {message.proposedTask && <TaskCard task={message.proposedTask} />}
      {message.model && <p className="mt-1 text-[10px] text-muted/70">{message.model}</p>}
    </div>
  );
}

function StreamingMessage({ pending }: { pending: PendingAnswer }) {
  const a = pending.answer;
  // Rendering Markdown on every token is wasteful; let React skip frames under load.
  const text = useDeferredValue(a.text);
  return (
    <div className="mr-2" aria-live="polite">
      <ToolList tools={a.tools} />
      {text ? (
        <Markdown text={text} streaming />
      ) : (
        <p className="inline-flex items-center gap-1.5 text-[13px] text-muted">
          <Loader2 size={13} className="animate-spin" /> {pending.stopping ? "Stopping…" : a.tools.some((t) => t.running) ? "Looking things up…" : "Thinking…"}
        </p>
      )}
      {a.notices.map((n, i) => (
        <p key={i} className="mt-1 text-[11px] text-muted">
          {n}
        </p>
      ))}
      {a.proposedTask && <TaskCard task={a.proposedTask} />}
    </div>
  );
}

export function MessageList({ messages, pending }: { messages: ChatMessage[]; pending: PendingAnswer | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastAssistant = messages.length - 1;

  // Follow the answer while the view is at the bottom; leave it alone once the user scrolls up.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [messages.length]);

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3 text-[13px]"
    >
      {messages.map((m, i) =>
        m.role === "user" ? <UserMessage key={m.id} message={m} /> : <AssistantMessage key={m.id} message={m} last={i === lastAssistant} />,
      )}
      {pending && (
        <>
          <UserMessage message={pending.user} sending />
          <StreamingMessage pending={pending} />
        </>
      )}
    </div>
  );
}
