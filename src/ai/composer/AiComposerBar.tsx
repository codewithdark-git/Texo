// The AI Chat bar under the editor: the app's chat composer. One line until
// it takes focus (Ctrl+J from anywhere); then it grows into a text box with
// attachments, an "Include <file>" chip and the model picker. Enter sends to
// the open chat and brings up the Chat tab, where the answer streams; while
// it does, the bar says "Answering…" and Send becomes Stop.
//
// The "+" menu attaches a file (from the project or the computer) or
// pictures, and lists every agent. Picking one (there, or by typing "/" at
// the start) puts the bar in agent mode: a "/review" chip sits before the
// words, and Enter starts that agent with them (and the attachments) and
// brings up the run's tab; an agent that needs setup opens its dialog.
// With AI off or no key the bar is a single line that leads to Settings.

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FileText,
  FolderOpen,
  ImageIcon,
  ListTodo,
  Loader2,
  MessageSquareReply,
  Monitor,
  Play,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  TextSelect,
  UserCog,
  Wrench,
  X,
} from "lucide-react";
import type { AiProviderInfo } from "../../lib/api";
import { useUi, toast } from "../../ui";
import { useWorkspace } from "../../workspace/store";
import { useLayout } from "../../workspace/layoutStore";
import { getActiveEditor } from "../../workspace/editorBridge";
import { Kbd } from "../../components/ui/Kbd";
import { Popover } from "../../components/ui/Popover";
import { Tooltip } from "../../components/ui/Tooltip";
import { useAccess, type Access } from "../aiAccess";
import { useAiPanel } from "../panel/aiPanelStore";
import { listenChatEvents, useChat } from "../chat/chatStore";
import { activeTextFile, attachFiles, CHAT_DROP_ATTR, currentFileContext, dirtyBuffers } from "../chat/composerActions";
import { ModelPicker } from "../chat/Composer";
import { buildSendInput } from "../chat/sendInput";
import { agentEntries, agentPlaceholder, agentStartLabel, dropSlash, filterAgents, slashQuery, typedAgent, type AgentEntry, type AgentIcon } from "./agentMenu";
import { attachProjectFile, startAgentFromBar, useAgentProfiles } from "./barActions";
import {
  attachableFiles,
  COMPOSER_SHORTCUT_LABEL,
  composerKey,
  includedFile,
  includeHint,
  includeLabel,
  isComposerShortcut,
  modalOpen,
  placeholderFor,
  sendFromBar,
  suggestFiles,
  type EditorContext,
} from "./composerLogic";
import { composersMounted, focusComposer, focusNotice, registerComposer, shortcutNeedsEditor, takeComposerRequest, useComposerRequest } from "./composerFocus";

const FILE_ACCEPT = ".pdf,.tex,.ltx,.bib,.sty,.cls,.bst,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.svg,.log,.py,.r,.m";
const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/bmp";

/** About eight lines of text before the box scrolls. */
const MAX_INPUT_PX = 168;

const AGENT_ICONS: Record<AgentIcon, (size: number) => ReactNode> = {
  fix: (s) => <Wrench size={s} />,
  review: (s) => <ClipboardCheck size={s} />,
  respond: (s) => <MessageSquareReply size={s} />,
  task: (s) => <ListTodo size={s} />,
  custom: (s) => <UserCog size={s} />,
};

const toAiSettings = () => useUi.getState().openSettings("ai");

/** What the editor offers right now: the text file in front and its selection. */
function readEditor(): EditorContext {
  const ctx = currentFileContext();
  return { file: ctx?.file ?? null, text: ctx?.text, selection: ctx?.selection ?? null };
}

/** Ctrl+J puts focus on `target` from anywhere in the workspace (but not out of an open dialog). */
function useFocusShortcut(target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const unregister = registerComposer();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !isComposerShortcut(e) || modalOpen()) return;
      const el = target.current;
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unregister();
      window.removeEventListener("keydown", onKey);
    };
  }, [target]);
}

/**
 * Ctrl+J while no bar shows ("PDF only"): bring the editor side back, and the
 * bar with it, then put focus there. Mounted by the workspace.
 */
export function useComposerShortcutFallback() {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const layout = useLayout.getState();
      if (!shortcutNeedsEditor({ shortcut: isComposerShortcut(e), defaultPrevented: e.defaultPrevented, modal: modalOpen(), mounted: composersMounted(), layout: layout.layout })) return;
      e.preventDefault();
      layout.setLayout("split");
      focusComposer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The muted one-liner shown instead of the bar when AI can't be used yet. */
function SetupLine({ text, onClick, icon }: { text: string; onClick: () => void; icon: ReactNode }) {
  const button = useRef<HTMLButtonElement>(null);
  useFocusShortcut(button);
  // Focus asked for elsewhere (the Command Center, Ctrl+J from "PDF only") lands here until AI is ready.
  const seq = useComposerRequest((s) => s.seq);
  useEffect(() => {
    if (!takeComposerRequest("setup").focus) return;
    const id = requestAnimationFrame(() => button.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [seq]);
  return (
    <div className="shrink-0 px-2 pt-1 pb-2">
      <button
        ref={button}
        type="button"
        onClick={onClick}
        className="flex h-8 w-full items-center gap-2 rounded-xl border border-dashed border-border px-3 text-left text-xs text-muted transition-colors duration-[var(--dur-2)] hover:border-accent/50 hover:text-text focus-visible:border-accent focus-visible:outline-none"
      >
        <span className="shrink-0 text-accent">{icon}</span>
        <span className="truncate">{text}</span>
      </button>
    </div>
  );
}

/** The bar for an access state (split out so each state can be checked on its own). */
export function ComposerBarFor({ access, project }: { access: Access; project: string }) {
  if (access.state === "loading") return null;
  if (access.state === "off" || access.state === "noKey") {
    return <SetupLine icon={<Settings size={13} />} text="Set up AI in Settings" onClick={toAiSettings} />;
  }
  if (access.state === "notice") {
    return <SetupLine icon={<Sparkles size={13} />} text="Read the AI privacy note to start chatting" onClick={readNotice} />;
  }
  return <ReadyBar provider={access.provider} project={project} />;
}

/** The note sits in the Chat tab: bring the tab up and put focus on its "OK, start chatting". */
function readNotice() {
  useAiPanel.getState().show("chat");
  focusNotice();
}

export function AiComposerBar({ project }: { project: string }) {
  const [access] = useAccess();
  return <ComposerBarFor access={access} project={project} />;
}

type MenuView = "main" | "file" | "agents";

function ReadyBar({ provider, project }: { provider: AiProviderInfo; project: string }) {
  const chatId = useChat((s) => s.current?.id ?? "");
  const pending = useChat((s) => (s.current ? s.pending[s.current.id] : undefined));
  const attachments = useChat((s) => s.attachments);
  const choice = useChat((s) => s.modelChoice[chatId]);
  const includeOn = useChat((s) => s.includeContext);
  const active = useWorkspace((s) => s.active);
  const isText = useWorkspace((s) => (s.active ? s.views[s.active]?.kind === "text" : false));
  const files = useWorkspace((s) => s.files);

  const input = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<MenuView>("main");
  const [dragging, setDragging] = useState(false);
  const [editor, setEditor] = useState<EditorContext>(() => ({ file: null, selection: null }));
  const [agent, setAgent] = useState<AgentEntry | null>(null);
  const [starting, setStarting] = useState(false);
  const [slashPick, setSlashPick] = useState(0);
  /** The text when Esc closed the "/" menu; it stays closed until the text changes. */
  const [slashClosed, setSlashClosed] = useState<string | null>(null);

  useFocusShortcut(input);

  // Works with the Chat tab closed: the chats load and answers are heard here too.
  useEffect(() => {
    listenChatEvents();
    void useChat.getState().init(project);
  }, [project]);

  const slash = agent ? null : slashQuery(draft, caret);
  const slashOpen = slash !== null && draft !== slashClosed;
  // Read the agents again when a menu that lists them opens (new ones may have been added in Settings).
  const profiles = useAgentProfiles(project, menuOpen || slashOpen);
  const entries = useMemo(() => agentEntries(profiles), [profiles]);
  const matches = useMemo(() => (slashOpen ? filterAgents(entries, slash ?? "") : []), [entries, slash, slashOpen]);
  const pick = Math.min(slashPick, Math.max(0, matches.length - 1));

  // Grow with the text, up to about eight lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(MAX_INPUT_PX, el.scrollHeight)}px`;
  }, [draft, focused, agent]);

  const expanded = focused || menuOpen || draft.length > 0 || !!agent;
  const reading = attachments.some((a) => a.status === "reading");
  const canSend = agent ? !starting && !reading : !pending && !reading && (draft.trim().length > 0 || attachments.length > 0);
  // The chip follows the editor: no text file open, nothing to include; another file, no selection.
  const editorNow = { file: isText ? active : null, selection: isText && active === editor.file ? editor.selection : null };
  const including = includeOn && !!editorNow.file;

  /** Taking focus: look at the editor once, for the chip and what it sends. */
  const onFocus = () => {
    if (focused) return;
    setEditor(readEditor());
    setFocused(true);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };

  const focusInput = (at?: number) =>
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      const pos = at ?? el.value.length;
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });

  // Focus or words asked for elsewhere (a starter in the Chat tab, the Command Center, Ctrl+J from "PDF only").
  const request = useComposerRequest((s) => s.seq);
  useEffect(() => {
    const { focus, text } = takeComposerRequest("bar");
    if (text !== null) {
      setAgent(null);
      setDraft(text);
      setSlashClosed(null);
    }
    if (focus || text !== null) focusInput();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const chooseAgent = (entry: AgentEntry, rest = draft) => {
    setAgent(entry);
    setDraft(rest);
    setMenuOpen(false);
    setView("main");
    setSlashClosed(null);
    focusInput();
  };

  const leaveAgent = () => {
    setAgent(null);
    focusInput(0);
  };

  const sendChat = () => {
    const store = useChat.getState();
    // Until the project's chats are listed and the last one is open, a send
    // would start a new chat that the opening one then hides.
    if (store.project !== project || !store.listLoaded || store.loadingChat) {
      toast("The chat is still loading. Try again in a moment.", "info");
      return;
    }
    if (store.current && store.pending[store.current.id]) return;
    const text = draft;
    const currentFile = includedFile(store.includeContext && !!activeTextFile(), readEditor());
    const message = buildSendInput({ text, attachments: store.attachments, currentFile, dirtyBuffers: dirtyBuffers(), model: choice });
    setDraft("");
    useAiPanel.getState().show("chat");
    void sendFromBar(useChat, () => store.send(message)).then((failed) => {
      // Nothing is lost: the words come back unless something new was typed.
      if (failed) setDraft((now) => now || text);
    });
  };

  const startAgent = async (entry: AgentEntry) => {
    setStarting(true);
    try {
      const text = draft;
      const files = useChat.getState().attachments;
      // A setup dialog took the words and files: once it starts the run, the bar lets go of them
      // (but keeps anything typed or attached meanwhile).
      const onDialogStarted = () => {
        setDraft((now) => (now === text ? "" : now));
        setAgent((now) => (now?.id === entry.id ? null : now));
        for (const a of files) useChat.getState().removeAttachment(a.id);
      };
      const outcome = await startAgentFromBar(project, entry, text, files, onDialogStarted);
      // Started: let go of what was sent, but keep anything typed or attached while it started.
      if (outcome === "started") onDialogStarted();
    } finally {
      setStarting(false);
    }
  };

  const submit = () => {
    if (!canSend) return;
    if (agent) void startAgent(agent);
    else sendChat();
  };

  const backToEditor = () => {
    input.current?.blur();
    getActiveEditor()?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (slashOpen) {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setSlashPick((pick + step + matches.length) % matches.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && plain && matches.length) {
        e.preventDefault();
        chooseAgent(matches[pick] ?? matches[0], dropSlash(draft));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSlashClosed(draft);
        return;
      }
    }
    if (agent && e.key === "Backspace" && plain && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault();
      leaveAgent();
      return;
    }
    const action = composerKey({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey });
    if (action === "send") {
      e.preventDefault();
      submit();
    } else if (action === "blur") {
      e.preventDefault();
      // Esc in agent mode with nothing typed leaves agent mode first.
      if (agent && !draft) leaveAgent();
      else backToEditor();
    }
  };

  const onChange = (value: string, at: number) => {
    setDraft(value);
    setCaret(at);
    setSlashPick(0);
    if (slashClosed !== null && value !== slashClosed) setSlashClosed(null);
    // "/review " typed out in full switches to that agent.
    if (!agent) {
      const typed = typedAgent(entries, value);
      if (typed) chooseAgent(typed, dropSlash(value));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    attachFiles(pasted);
  };
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");

  const openMenu = (open: boolean) => {
    setMenuOpen(open);
    if (!open) setView("main");
  };

  const status = !agent && pending ? (pending.stopping ? "Stopping…" : "Answering…") : null;
  const placeholder = agent ? agentPlaceholder(agent) : status ? "" : placeholderFor(editorNow, including);
  // Whether Enter starts the run or only opens its setup, from what would go with it now.
  const start = agent ? agentStartLabel(agent, draft, attachments) : null;

  return (
    <div className="relative shrink-0 px-2 pt-1 pb-2">
      {slashOpen && <SlashMenu matches={matches} pick={pick} query={slash ?? ""} onPick={(a) => chooseAgent(a, dropSlash(draft))} onHover={setSlashPick} />}
      <div
        {...{ [CHAT_DROP_ATTR]: "" }}
        onFocus={onFocus}
        onBlur={onBlur}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (!hasFiles(e)) return;
          e.preventDefault();
          attachFiles([...e.dataTransfer.files]);
        }}
        className={`rounded-xl border bg-surface transition-[border-color,box-shadow] duration-[var(--dur-2)] ease-standard ${
          dragging ? "border-accent" : expanded ? "border-accent/60 ring-2 ring-accent/15" : "border-border hover:border-muted/40"
        }`}
      >
        {attachments.length > 0 && <AttachmentChips />}

        <div className="flex items-end gap-1 p-1">
          <input
            ref={filePicker}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) attachFiles([...e.target.files]);
              e.target.value = "";
            }}
          />
          <input
            ref={imagePicker}
            type="file"
            multiple
            accept={IMAGE_ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) attachFiles([...e.target.files]);
              e.target.value = "";
            }}
          />
          <Popover
            open={menuOpen}
            onOpenChange={openMenu}
            label="Add to the message"
            role="menu"
            side="top"
            align="start"
            width={272}
            panelClassName="p-1"
            trigger={
              <button
                type="button"
                aria-label="Add to the message"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => openMenu(!menuOpen)}
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-[var(--dur-2)] hover:bg-surface-2 hover:text-text ${menuOpen ? "bg-surface-2 text-text" : ""}`}
              >
                <Plus size={15} className={`transition-transform duration-[var(--dur-2)] ease-standard motion-reduce:transition-none ${menuOpen ? "rotate-45" : ""}`} />
              </button>
            }
          >
            <PlusMenu
              view={view}
              onView={setView}
              files={files}
              entries={entries}
              current={agent}
              onComputerFile={() => {
                openMenu(false);
                // The menu closes under the file dialog: focus goes back to the bar, not the page.
                focusInput();
                filePicker.current?.click();
              }}
              onImages={() => {
                openMenu(false);
                // The menu closes under the file dialog: focus goes back to the bar, not the page.
                focusInput();
                imagePicker.current?.click();
              }}
              onProjectFile={(f) => {
                openMenu(false);
                void attachProjectFile(project, f);
                focusInput();
              }}
              onAgent={(a) => chooseAgent(a)}
              onManage={() => {
                openMenu(false);
                toAiSettings();
              }}
            />
          </Popover>

          {agent && (
            <span
              className="texo-fade-in mb-0.5 flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-md bg-accent/15 pr-0.5 pl-1.5 text-[11px] font-medium text-text"
              title={`${agent.label}: ${agent.hint}`}
            >
              <span className="shrink-0 text-accent">{AGENT_ICONS[agent.icon](11)}</span>
              <span className="truncate">/{agent.slug}</span>
              <button
                type="button"
                aria-label={`Leave ${agent.label}`}
                onClick={leaveAgent}
                className="shrink-0 rounded p-0.5 text-muted hover:bg-accent/15 hover:text-text"
              >
                <X size={11} />
              </button>
            </span>
          )}

          <div className="relative min-w-0 flex-1">
            <textarea
              ref={input}
              rows={1}
              value={draft}
              aria-label={agent ? `Instructions for ${agent.label}` : "Message to AI Chat"}
              aria-keyshortcuts="Control+J"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={slashOpen && matches.length > 0}
              aria-controls={slashOpen && matches.length ? "ai-bar-agents" : undefined}
              aria-activedescendant={slashOpen && matches[pick] ? agentOptionId(matches[pick]) : undefined}
              placeholder={placeholder}
              onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              style={{ maxHeight: MAX_INPUT_PX }}
              className="block w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-5 outline-none placeholder:text-muted/80"
            />
            {status && !draft && (
              <span aria-hidden="true" className="texo-shimmer pointer-events-none absolute inset-y-0 left-1.5 flex items-center text-[13px]">
                {status}
              </span>
            )}
          </div>

          {!expanded && !status && <Kbd className="mb-1.5 shrink-0">{COMPOSER_SHORTCUT_LABEL}</Kbd>}

          {agent ? (
            <Tooltip content={`${start?.full} (Enter)`} side="top">
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label={start?.full}
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg bg-accent px-2 text-[11px] font-medium text-accent-ink transition-[background-color,opacity] duration-[var(--dur-2)] hover:bg-accent-strong disabled:opacity-50"
              >
                {starting ? (
                  <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                ) : start?.setup ? (
                  <SlidersHorizontal size={11} />
                ) : (
                  <Play size={11} className="fill-current" />
                )}
                {start?.short}
              </button>
            </Tooltip>
          ) : pending ? (
            <Tooltip content="Stop the answer" side="top">
              <button
                type="button"
                onClick={() => void useChat.getState().stop()}
                disabled={pending.stopping}
                aria-label="Stop the answer"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text transition-[filter] hover:brightness-125 disabled:opacity-50"
              >
                <Square size={11} className="fill-current" />
              </button>
            </Tooltip>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send"
              title={reading ? "Reading attachments…" : "Send (Enter)"}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink transition-[background-color,opacity] duration-[var(--dur-2)] hover:bg-accent-strong disabled:bg-transparent disabled:text-muted disabled:opacity-60"
            >
              <SendHorizontal size={14} />
            </button>
          )}
        </div>

        <div className="texo-collapse" data-open={expanded ? "" : "false"}>
          <div>
            <div className="flex min-w-0 items-center gap-1.5 px-2 pb-1.5">
              {agent ? (
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                  <Bot size={12} className="shrink-0 text-accent" />
                  <span className="truncate">
                    {agent.label}: {agent.hint}. Backspace at the start goes back to chat.
                  </span>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!editorNow.file}
                    aria-pressed={including}
                    onClick={() => useChat.getState().setIncludeContext(!includeOn)}
                    title={includeHint(editorNow, including)}
                    className={`inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors duration-[var(--dur-2)] disabled:opacity-50 ${
                      including ? "bg-accent/15 text-text" : "text-muted hover:bg-surface-2 hover:text-text"
                    }`}
                  >
                    {editorNow.selection ? <TextSelect size={12} className="shrink-0" /> : <FileText size={12} className="shrink-0" />}
                    <span className="truncate">{includeLabel(editorNow)}</span>
                  </button>
                  <span className="flex-1" />
                  <span className="hidden truncate text-[11px] text-muted lg:inline">Type / for agents. Shift+Enter starts a new line.</span>
                  <ModelPicker provider={provider} disabled={!!pending} className="max-w-44" />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {status ?? (slashOpen ? (matches.length ? `${matches[pick]?.label}. ${matches.length} agents, arrows to move, Enter to pick.` : "No agent by that name.") : agent ? `Agent mode: ${agent.label}` : "")}
      </span>
    </div>
  );
}

/** The attachments waiting to go with the next message or run. */
function AttachmentChips() {
  const attachments = useChat((s) => s.attachments);
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1 px-2 pt-1.5">
      {attachments.map((a) => (
        <li key={a.id} title={a.note ?? a.name} className="texo-fade-in flex h-6 max-w-52 items-center gap-1 rounded-md border border-border bg-surface-2 pr-0.5 pl-1.5 text-[11px]">
          {a.status === "reading" ? (
            <Loader2 size={11} className="shrink-0 animate-spin text-muted motion-reduce:animate-none" />
          ) : a.kind === "image" && a.dataUrl ? (
            <img src={a.dataUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm object-cover" />
          ) : (
            <FileText size={11} className="shrink-0 text-muted" />
          )}
          <span className="truncate">{a.status === "reading" ? `${a.name} (reading…)` : a.name}</span>
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            onClick={() => useChat.getState().removeAttachment(a.id)}
            className="shrink-0 rounded p-0.5 text-muted hover:bg-surface hover:text-text"
          >
            <X size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The DOM id of an agent's row in the "/" menu (slugs are unique and id-safe). */
const agentOptionId = (a: AgentEntry) => `ai-bar-agent-${a.slug}`;

/** The "/" menu above the bar: the agents whose name or slug fits what follows the "/". */
function SlashMenu({ matches, pick, query, onPick, onHover }: { matches: AgentEntry[]; pick: number; query: string; onPick: (a: AgentEntry) => void; onHover: (i: number) => void }) {
  return (
    <div data-side="top" className="texo-menu absolute inset-x-2 bottom-full z-40 mb-1 overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow-pop)]">
      <div className="flex items-center justify-between border-b border-border px-2.5 py-1 text-[10px] font-medium tracking-wide text-muted uppercase">
        <span>Agents</span>
        <span className="font-normal normal-case">↑↓ move · Enter or Tab picks · Esc closes</span>
      </div>
      {matches.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted">No agent called “/{query}”. Enter sends it to the chat.</p>
      ) : (
        <ul id="ai-bar-agents" role="listbox" aria-label="Agents" className="max-h-64 overflow-y-auto p-1">
          {matches.map((a, i) => (
            <li key={a.id} role="presentation">
              <button
                type="button"
                id={agentOptionId(a)}
                role="option"
                aria-selected={i === pick}
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(a);
                }}
                onMouseEnter={() => onHover(i)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--dur-1)] ${i === pick ? "bg-surface-2 text-text" : "text-muted"}`}
              >
                <span className={`shrink-0 ${i === pick ? "text-accent" : ""}`}>{AGENT_ICONS[a.icon](14)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-text">{a.label}</span>
                  <span className="block truncate text-[11px] text-muted">{a.hint}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted">/{a.slug}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Up/Down move between the menu's rows (and its search box). */
function onMenuKeys(e: KeyboardEvent<HTMLDivElement>, onBack?: () => void) {
  const root = e.currentTarget;
  const rows = [...root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]), input')];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]?.focus();
  } else if (onBack && e.key === "ArrowLeft" && (document.activeElement as HTMLElement)?.tagName !== "INPUT") {
    e.preventDefault();
    onBack();
  } else if (e.key === "ArrowRight" && (document.activeElement as HTMLElement)?.dataset.submenu) {
    e.preventDefault();
    (document.activeElement as HTMLElement).click();
  }
}

function PlusMenu({
  view,
  onView,
  files,
  entries,
  current,
  onComputerFile,
  onImages,
  onProjectFile,
  onAgent,
  onManage,
}: {
  view: MenuView;
  onView: (v: MenuView) => void;
  files: { path: string; isDir: boolean; size: number }[];
  entries: AgentEntry[];
  current: AgentEntry | null;
  onComputerFile: () => void;
  onImages: () => void;
  onProjectFile: (file: string) => void;
  onAgent: (a: AgentEntry) => void;
  onManage: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const paths = useMemo(() => attachableFiles(files), [files]);
  const found = useMemo(() => suggestFiles(paths, query), [paths, query]);

  // A new view puts focus on its first row.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setQuery("");
    body.current?.querySelector<HTMLElement>('[role="menuitem"], input')?.focus();
  }, [view]);

  const back = () => onView("main");

  if (view === "file") {
    return (
      <div ref={body} onKeyDown={(e) => onMenuKeys(e, back)} className="texo-fade-in">
        <BackRow label="File" onBack={back} />
        <MenuRow icon={<Monitor size={14} />} label="From your computer…" hint="PDFs and text files" onSelect={onComputerFile} />
        <div className="my-1 h-px bg-border" />
        <label className="mx-1 mb-1 flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg px-2 text-xs focus-within:border-accent">
          <Search size={12} className="shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && found[0]) {
                e.preventDefault();
                onProjectFile(found[0]);
              }
            }}
            placeholder="Find a project file"
            aria-label="Find a project file"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted/80"
          />
        </label>
        {found.length === 0 ? (
          <p className="px-2.5 py-1.5 text-xs text-muted">{paths.length ? "No file matches." : "This project has no files to attach."}</p>
        ) : (
          found.map((f) => <MenuRow key={f} icon={<FileText size={14} />} label={f} compact onSelect={() => onProjectFile(f)} />)
        )}
      </div>
    );
  }

  if (view === "agents") {
    const builtIn = entries.filter((a) => !a.profile);
    const own = entries.filter((a) => a.profile);
    const row = (a: AgentEntry) => (
      <MenuRow key={a.id} icon={AGENT_ICONS[a.icon](14)} label={a.label} hint={a.hint} trail={`/${a.slug}`} active={current?.id === a.id} onSelect={() => onAgent(a)} />
    );
    return (
      <div ref={body} onKeyDown={(e) => onMenuKeys(e, back)} className="texo-fade-in">
        <BackRow label="Agents" onBack={back} />
        {builtIn.map(row)}
        {own.length > 0 && (
          <>
            <div className="my-1 h-px bg-border" />
            <p className="px-2.5 pt-0.5 pb-1 text-[10px] font-medium tracking-wide text-muted uppercase">Your agents</p>
            {own.map(row)}
          </>
        )}
        <div className="my-1 h-px bg-border" />
        <MenuRow icon={<Settings size={14} />} label="Manage agents…" hint="Settings ▸ AI ▸ Agents" onSelect={onManage} />
      </div>
    );
  }

  return (
    <div ref={body} onKeyDown={(e) => onMenuKeys(e)} className="texo-fade-in">
      <MenuRow icon={<FolderOpen size={14} />} label="File" hint="From this project or your computer" submenu onSelect={() => onView("file")} />
      <MenuRow icon={<ImageIcon size={14} />} label="Images" hint="Pictures, screenshots or plots" onSelect={onImages} />
      <MenuRow icon={<Bot size={14} />} label="Agents" hint="Start one with your message, or type /" submenu onSelect={() => onView("agents")} />
    </div>
  );
}

function BackRow({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onBack}
      className="mb-0.5 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted hover:bg-surface-2 hover:text-text focus-visible:bg-surface-2 focus-visible:outline-none"
    >
      <ChevronLeft size={14} className="shrink-0" />
      {label}
    </button>
  );
}

function MenuRow({
  icon,
  label,
  hint,
  trail,
  submenu,
  active,
  compact,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  trail?: string;
  submenu?: boolean;
  active?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-haspopup={submenu ? "menu" : undefined}
      aria-current={active ? "true" : undefined}
      data-submenu={submenu ? "" : undefined}
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-text transition-colors duration-[var(--dur-1)] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-50 disabled:hover:bg-transparent ${
        compact ? "py-1" : "py-1.5"
      } ${active ? "bg-accent/10" : ""}`}
    >
      <span className={`shrink-0 ${active ? "text-accent" : "text-muted"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${compact ? "text-xs" : ""}`}>{label}</span>
        {hint && <span className="block truncate text-xs text-muted">{hint}</span>}
      </span>
      {trail && <span className="shrink-0 font-mono text-[11px] text-muted">{trail}</span>}
      {submenu && <ChevronRight size={14} className="shrink-0 text-muted" />}
    </button>
  );
}
