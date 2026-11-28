// The Chat editor tab: the conversation list (new, rename, delete), the
// messages, and every state around them in plain words: AI off, no key, the
// privacy notice, offline, rate limited, and errors with "Try again". You
// write in the AI Chat bar under the editor, which sends to the chat shown
// here; the tab has no composer of its own.

import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ArrowDown, ChevronDown, KeyRound, MessageSquarePlus, Pencil, PowerOff, RotateCcw, Settings, Trash2, WifiOff, X } from "lucide-react";
import { type AiProviderInfo } from "../../lib/api";
import { formatRelative } from "../../lib/projects";
import { useUi, toast } from "../../ui";
import { Button, ConfirmDialog, PromptDialog } from "../../components/Dialog";
import { useAiSettings } from "../aiPrefs";
import { useChat, type SendFailure } from "./chatStore";
import { Kbd } from "../../components/ui/Kbd";
import { MessageList } from "./Messages";
import "./chat.css";
import { useAccess } from "../aiAccess";
import { useAiPanel } from "../panel/aiPanelStore";
import { focusComposer, focusNotice, queueComposerText, takeNoticeRequest, useComposerRequest } from "../composer/composerFocus";

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

const toAiSettings = () => useUi.getState().openSettings("ai");

function CenterNote({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[13px]">
      <span className="text-accent">{icon}</span>
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

function Notice({ provider, onAccepted }: { provider: AiProviderInfo; onAccepted: () => void }) {
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLElement>(null);
  // The bar's "Read the AI privacy note" (or a starter picked before reading it) brings focus here.
  const asked = useComposerRequest((s) => s.seq);
  useEffect(() => {
    if (!takeNoticeRequest()) return;
    const id = requestAnimationFrame(() => {
      box.current?.scrollIntoView({ block: "nearest" });
      box.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [asked]);
  const accept = async () => {
    setBusy(true);
    try {
      await useAiSettings.getState().update({ acceptNotice: provider.id });
      onAccepted();
    } catch (err) {
      toast(err && typeof err === "object" && "message" in err ? String(err.message) : "Texo couldn't save that.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section ref={box} aria-label="AI privacy note" className="mx-auto my-3 w-[calc(100%-1.5rem)] max-w-3xl rounded-lg border border-accent/30 bg-accent/10 px-3 py-2.5 text-[13px]">
      <p className="font-medium">Before you chat with {provider.label}</p>
      <p className="mt-1 text-muted">When you send a message, Texo sends {provider.label}:</p>
      <ul className="mt-1 list-disc pl-5 text-muted">
        <li>your message, and the earlier messages of this chat,</li>
        <li>files and pictures you attach, and files you mention with @,</li>
        <li>the open file or the selected lines, when "Include" is on,</li>
        <li>parts of project files the assistant reads to answer (it can't change them),</li>
        <li>paper and web lookups it makes go to those services (OpenAlex, Crossref, arXiv, Semantic Scholar, doi.org, web pages it opens, and a search service if you set one up).</li>
      </ul>
      <p className="mt-1 text-muted">Your API key stays on this computer. Nothing is sent until you press Send.</p>
      <div className="mt-2 flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void accept()}>
          OK, start chatting
        </Button>
        <Button variant="ghost" onClick={toAiSettings}>
          <Settings size={14} /> AI settings
        </Button>
      </div>
    </section>
  );
}

/** Seconds left of a rate-limit wait, counting down. */
function useCountdown(f: SendFailure | null): number {
  const [now, setNow] = useState(() => Date.now());
  const wait = f?.kind === "rateLimited" ? (f.retryAfter ?? 0) : 0;
  useEffect(() => {
    if (!wait) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [f, wait]);
  if (!f || !wait) return 0;
  return Math.max(0, Math.ceil((f.at + wait * 1000 - now) / 1000));
}

function FailureBanner({ failure, recheck }: { failure: SendFailure; recheck: () => void }) {
  const retry = useChat((s) => s.retry);
  const dismiss = useChat((s) => s.dismissFailure);
  const left = useCountdown(failure);
  const settingsKinds = ["noKey", "badKey", "disabled", "forbidden", "payment"];
  const text =
    failure.kind === "rateLimited"
      ? `The AI service is getting too many requests. ${left > 0 ? `You can try again in ${left} s.` : "Try again now."}`
      : failure.kind === "offline"
        ? "Texo can't reach the AI service. Check your internet connection, then try again."
        : failure.kind === "busy"
          ? "This chat is still answering. Wait for it, or press Stop first."
          : failure.message;
  // Once per failure (recheck is stable): the access check it starts must be allowed to finish (FE-3).
  useEffect(() => {
    if (failure.kind === "noticeRequired" || failure.kind === "noKey" || failure.kind === "disabled") recheck();
  }, [failure.at, failure.kind, recheck]);
  return (
    <div role="alert" className="mx-auto mb-2 flex w-[calc(100%-1.5rem)] max-w-3xl items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2 text-[13px]">
      {failure.kind === "offline" ? <WifiOff size={14} className="mt-0.5 shrink-0 text-danger" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />}
      <div className="flex-1">
        <p>{text}</p>
        <div className="mt-1 flex gap-3">
          {settingsKinds.includes(failure.kind) ? (
            <button type="button" onClick={toAiSettings} className="text-accent hover:underline">
              Open AI settings
            </button>
          ) : (
            failure.request.chatId &&
            failure.kind !== "busy" && (
              <button type="button" disabled={left > 0} onClick={() => void retry()} className="inline-flex items-center gap-1 text-accent hover:underline disabled:opacity-50 disabled:no-underline">
                <RotateCcw size={12} /> Try again
              </button>
            )
          )}
        </div>
      </div>
      <button type="button" aria-label="Dismiss" onClick={dismiss} className="text-muted hover:text-text">
        <X size={14} />
      </button>
    </div>
  );
}

function ChatPicker() {
  const chats = useChat((s) => s.chats);
  const current = useChat((s) => s.current);
  const pending = useChat((s) => s.pending);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const listWanted = useAiPanel((s) => s.chatListWanted);
  // Set when the list opens for the keyboard: focus then goes into it.
  const [focusList, setFocusList] = useState(false);

  // "Show all chats" in the Command Center opens this list, with focus in it.
  useEffect(() => {
    if (!listWanted) return;
    useAiPanel.setState({ chatListWanted: false });
    setOpen(true);
    setFocusList(true);
  }, [listWanted]);

  useEffect(() => {
    if (!focusList || !open) return;
    setFocusList(false);
    const id = requestAnimationFrame(() => {
      const root = box.current;
      const target =
        root?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
        root?.querySelector<HTMLElement>('[role="option"]') ??
        root?.querySelector<HTMLElement>('button[aria-label="New chat"]');
      target?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [focusList, open]);

  /** Up/Down move between the chats in the list. */
  const onListKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const options = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
    if (!options.length) return;
    e.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    options[at < 0 ? 0 : (at + step + options.length) % options.length]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative flex min-w-0 flex-1 items-center gap-1">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Your chats in this project"
        className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-[13px] font-medium hover:bg-surface-2"
      >
        <span className="truncate">{current?.title ?? "New chat"}</span>
        <ChevronDown size={13} className="shrink-0 text-muted" />
      </button>
      <button
        type="button"
        onClick={() => {
          useChat.getState().startNew();
          setOpen(false);
        }}
        aria-label="New chat"
        title="New chat"
        className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"
      >
        <MessageSquarePlus size={15} />
      </button>
      {open && (
        <div className="texo-fade-in absolute top-full left-0 z-30 mt-1 max-h-80 w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-xl [animation-duration:var(--dur-1)]!" role="listbox" aria-label="Chats" onKeyDown={onListKeys}>
          {chats.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted">No chats yet. Your first message starts one.</p>}
          {chats.map((c) => (
            <div key={c.id} className={`group flex items-center gap-1 rounded-md ${c.id === current?.id ? "bg-surface-2" : "hover:bg-surface-2"}`}>
              <button
                type="button"
                role="option"
                aria-selected={c.id === current?.id}
                onClick={() => {
                  setOpen(false);
                  void useChat.getState().open(c.id);
                }}
                className="min-w-0 flex-1 px-2 py-1.5 text-left"
              >
                <span className="block truncate text-[13px]">
                  {pending[c.id] ? "● " : ""}
                  {c.title}
                </span>
                <span className="block truncate text-[11px] text-muted">
                  {formatRelative(new Date(c.updated).toISOString())}
                  {c.preview ? ` · ${c.preview}` : ""}
                </span>
              </button>
              <button type="button" aria-label={`Rename ${c.title}`} title="Rename" onClick={() => {
                  setOpen(false);
                  setRenaming({ id: c.id, title: c.title });
                }} className="rounded p-1 text-muted opacity-0 hover:text-text focus:opacity-100 group-hover:opacity-100">
                <Pencil size={13} />
              </button>
              <button type="button" aria-label={`Delete ${c.title}`} title="Delete" onClick={() => {
                  setOpen(false);
                  setDeleting({ id: c.id, title: c.title });
                }} className="mr-1 rounded p-1 text-muted opacity-0 hover:text-danger focus:opacity-100 group-hover:opacity-100">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {renaming && (
        <PromptDialog
          title="Rename chat"
          label="Name"
          initial={renaming.title}
          confirmLabel="Rename"
          onClose={() => setRenaming(null)}
          onSubmit={(title) => {
            const id = renaming.id;
            setRenaming(null);
            void useChat
              .getState()
              .rename(id, title)
              .catch((err) => toast(err?.message ?? "Texo couldn't rename the chat.", "error"));
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this chat?"
          message={
            <>
              <span className="font-medium text-text">{deleting.title}</span> and all its messages will be deleted from this project. This can't be undone.
              {pending[deleting.id] ? " Its answer in progress stops." : ""}
            </>
          }
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            void useChat
              .getState()
              .remove(id)
              .then(() => toast("Chat deleted."))
              .catch((err) => toast(err?.message ?? "Texo couldn't delete the chat.", "error"));
          }}
        />
      )}
    </div>
  );
}

const STARTERS = [
  "Summarise my paper in five sentences.",
  "What is unclear in my introduction?",
  "Suggest a better title.",
  "Check my abstract for grammar.",
];

function EmptyChat({ onStarter }: { onStarter: (text: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto mt-auto flex w-full max-w-3xl flex-col gap-2 p-5 text-[13px]">
        <p className="font-medium">Chat about your paper</p>
        <p className="text-muted">Ask questions, get explanations, or ask for help with a passage. The assistant can read your project but never changes it; for changes it suggests a task you can run.</p>
        <div className="mt-1 flex flex-wrap items-start gap-1.5">
          {STARTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onStarter(s)}
              className="rounded-lg border border-border px-2.5 py-1 text-left text-xs text-muted transition-colors duration-[var(--dur-2)] hover:border-accent/50 hover:text-text"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Where to write: the AI Chat bar under this tab. */
function ComposerHint({ disabledReason, onClick }: { disabledReason?: string; onClick: () => void }) {
  return (
    <div className="shrink-0 border-t border-border/60 px-3 py-1.5">
      <button
        type="button"
        onClick={onClick}
        className="mx-auto flex w-full max-w-3xl items-center gap-1.5 text-left text-[11px] text-muted transition-colors hover:text-text"
      >
        <ArrowDown size={12} className="shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate">{disabledReason ?? "Write in the AI Chat bar below. Type / for an agent. AI answers can be wrong; check them."}</span>
        <Kbd>Ctrl+J</Kbd>
      </button>
    </div>
  );
}

export function ChatTab({ project }: { project: string }) {
  const [access, recheck] = useAccess();
  const online = useOnline();
  const current = useChat((s) => s.current);
  const pending = useChat((s) => (s.current ? s.pending[s.current.id] : undefined));
  const failure = useChat((s) => s.failure);
  const listError = useChat((s) => s.listError);
  const loadingChat = useChat((s) => s.loadingChat);

  useEffect(() => {
    void useChat.getState().init(project);
  }, [project]);

  if (access.state === "loading") return <div className="flex-1" />;
  if (access.state === "off") {
    return (
      <CenterNote icon={<PowerOff size={22} />} title="The AI helper is off">
        <p className="text-muted">Turn it on in Settings to chat about your paper.</p>
        <Button variant="primary" onClick={toAiSettings}>
          <Settings size={14} /> Open AI settings
        </Button>
      </CenterNote>
    );
  }
  if (access.state === "noKey") {
    const p = access.provider;
    return (
      <CenterNote icon={<KeyRound size={22} />} title={`Add your ${p.label} API key`}>
        <p className="max-w-xs text-muted">{p.howTo || `Chat uses your own ${p.label} key. It stays on this computer.`}</p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={toAiSettings}>
            <Settings size={14} /> Open AI settings
          </Button>
          {p.keyUrl && (
            <Button variant="ghost" onClick={() => void openUrl(p.keyUrl!)}>
              Get a key
            </Button>
          )}
        </div>
      </CenterNote>
    );
  }

  // Until the privacy note is read the bar is a single line: a starter waits for it, and focus goes to the note.
  const unread = access.state === "notice";
  const onStarter = (text: string) => {
    if (unread) {
      queueComposerText(text);
      focusNotice();
    } else focusComposer(text);
  };
  const failureHere = failure && (failure.chatId === (current?.id ?? "") || failure.chatId === "") ? failure : null;
  const messages = current?.messages ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <div className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-1">
          <ChatPicker />
        </div>
      </div>
      {!online && (
        <p className="flex items-center gap-1.5 border-b border-border bg-surface-2 px-3 py-1.5 text-xs text-muted">
          <WifiOff size={12} /> You're offline. Messages can't be answered until you're back online.
        </p>
      )}
      {listError && !current && <p className="px-3 py-2 text-xs text-danger">{listError}</p>}
      {loadingChat ? (
        <div className="flex-1" />
      ) : messages.length === 0 && !pending ? (
        <EmptyChat onStarter={onStarter} />
      ) : (
        <MessageList messages={messages} pending={pending} />
      )}
      {access.state === "notice" && <Notice provider={access.provider} onAccepted={recheck} />}
      {failureHere && <FailureBanner failure={failureHere} recheck={recheck} />}
      <ComposerHint disabledReason={unread ? "Read the note above to start chatting." : undefined} onClick={unread ? focusNotice : () => focusComposer()} />
    </div>
  );
}
