// The Command Center: a pill in the middle of the top bar that tells, in one
// line, the thing about the AI that matters most right now (a run waiting
// for you, changes to review, a failure, the work going on, a finish), and a
// popover (Ctrl+Shift+J) that lists runs and recent chats with a search box.
// It follows runs and chats itself, so it works whatever the editor shows.
// Picking a run opens that run's editor tab; picking a chat opens it in the
// Chat tab; New chat starts a fresh one there; New task starts a task (or
// opens its setup) and its tab. The words and groups come from
// ./commandCenterLogic.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { create } from "zustand";
import { ChevronDown, CircleCheck, CircleX, ClipboardCheck, FileDiff, ListTodo, MessageSquareReply, MessagesSquare, Bot, Plus, Search, Square, UserCog, Wrench } from "lucide-react";
import { Kbd } from "../../components/ui/Kbd";
import { Popover } from "../../components/ui/Popover";
import { ProgressRing } from "../../components/ui/ProgressRing";
import { StatusDot } from "../../components/ui/StatusDot";
import { Tooltip } from "../../components/ui/Tooltip";
import { profilesApi, type AgentProfile, type RunSummary } from "../../lib/agentsApi";
import { formatRelative } from "../../lib/projects";
import { useAccess } from "../aiAccess";
import { startFixerRun, startRun } from "../agents/actions";
import { openAgentDialog, type AgentDialog } from "../agents/dialogStore";
import { useRunFocus } from "../agents/focusStore";
import { elapsedSecs, formatElapsed, listenRunEvents, runsForProject, useRuns } from "../agents/runsStore";
import { listenChatEvents, useChat } from "../chat/chatStore";
import { tabInView, useAiPanel } from "../panel/aiPanelStore";
import { focusComposer } from "../composer/composerFocus";
import { modalOpen } from "../composer/composerLogic";
import { runIdOf, runTabId, useAiTabs } from "../tabs/aiTabsStore";
import {
  buildSections,
  EMPTY_SEEN,
  flatRows,
  isCommandCenterShortcut,
  markSeen,
  moveSelection,
  phaseText,
  pillState,
  runProgressFraction,
  runTitle,
  trackUnseen,
  type PillState,
  type Row,
  type SeenState,
} from "./commandCenterLogic";

export const SHORTCUT = "Ctrl+Shift+J";
/** Below this window width the pill shows only its icon (the words go to a tooltip). */
const NARROW_QUERY = "(max-width: 959px)";

// ---------------------------------------------------------------------------
// Unseen finishes, for the open project
// ---------------------------------------------------------------------------

const useSeen = create<SeenState & { project: string | null }>(() => ({ ...EMPTY_SEEN, project: null }));

/** True while the user can see the Agents tab (finishes there aren't news). */
const agentsInView = () => tabInView("agents");
/** True while the user can see this run, in the Agents tab or its own tab. */
const runInView = (runId: string) => agentsInView() || tabInView(runTabId(runId));

/** Follows runs and chats for `project` and keeps the unseen marks up to date. */
function useFollow(project: string) {
  useEffect(() => listenRunEvents(), []);
  useEffect(() => {
    listenChatEvents();
    useSeen.setState({ ...EMPTY_SEEN, project });
    void useRuns.getState().load(project);
    void useChat.getState().init(project);
  }, [project]);

  useEffect(() => {
    const feed = () => {
      const runs = runsForProject(useRuns.getState().runs, project);
      const seen = useSeen.getState();
      let next = trackUnseen(seen, runs, runInView);
      if (agentsInView()) next = markSeen(next);
      else {
        const shown = useAiTabs.getState().active;
        const runId = shown ? runIdOf(shown) : null;
        if (runId && runInView(runId)) next = markSeen(next, [runId]);
      }
      if (next.last !== seen.last || next.unseen !== seen.unseen) useSeen.setState(next);
    };
    feed();
    const offRuns = useRuns.subscribe(feed);
    // Opening the Agents tab counts as seeing every finish.
    const offPanel = useAiTabs.subscribe((s, prev) => {
      if (s.active === "agents" && prev.active !== "agents") useSeen.setState((v) => markSeen(v));
      // Bringing a run's own tab forward counts as seeing that run.
      const runId = s.active && s.active !== prev.active ? runIdOf(s.active) : null;
      if (runId) useSeen.setState((v) => markSeen(v, [runId]));
    });
    return () => {
      offRuns();
      offPanel();
    };
  }, [project]);
}

/** Matches a CSS media query (false where there is no window). */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return on;
}

/** Seconds since 1970, ticking once a second while `on`. */
function useNowSecs(on: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now() / 1000);
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Opens `runId`'s tab, if any, and one of the agent dialogs, if asked (they
 * show over whatever is in front).
 */
function showInAgents(runId: string | null, dialog?: AgentDialog) {
  if (runId) useRunFocus.getState().focus(runId);
  if (dialog) openAgentDialog(dialog);
}

function runRow(row: Row) {
  switch (row.type) {
    case "attention":
      showInAgents(row.run.id, row.action.dialog ? { type: row.action.dialog, runId: row.run.id } : undefined);
      break;
    case "running":
    case "recent":
      showInAgents(row.run.id);
      break;
    case "chat":
      void useChat.getState().open(row.chat.id);
      useAiPanel.getState().show("chat");
      // The Chat tab has no composer: the bar under the editor takes the typing.
      focusComposer();
      break;
    case "allChats":
      useAiPanel.getState().showChatList();
      break;
  }
}

function newChat() {
  useChat.getState().startNew();
  useAiPanel.getState().show("chat");
  focusComposer();
}

interface NewTask {
  label: string;
  icon: ReactNode;
  run: () => void;
}

/** The same built-in tasks as the Agents tab's New task menu. */
const NEW_TASKS: NewTask[] = [
  { label: "Fix compile errors", icon: <Wrench size={14} />, run: () => void startFixerRun() },
  { label: "Review paper…", icon: <ClipboardCheck size={14} />, run: () => showInAgents(null, { type: "review" }) },
  { label: "Respond to reviewers…", icon: <MessageSquareReply size={14} />, run: () => showInAgents(null, { type: "new", kind: "rebuttal" }) },
  { label: "Custom task…", icon: <ListTodo size={14} />, run: () => showInAgents(null, { type: "new", kind: "task" }) },
];

/** The user's own profiles as New task entries, started the way the Agents tab starts them. */
function profileTasks(project: string, profiles: AgentProfile[]): NewTask[] {
  return profiles
    .filter((p) => p.source !== "builtin" && p.kind !== "chat")
    .map((p) => ({
      label: p.name,
      icon: <UserCog size={14} />,
      run: () => {
        if (p.kind === "fixer") void startRun(project, { kind: "fixer", profileId: p.id, prompt: "", options: { title: p.name } });
        else if (p.kind === "reviewer") showInAgents(null, { type: "review", profile: p });
        else showInAgents(null, { type: "new", kind: p.kind === "rebuttal" ? "rebuttal" : "task", profile: p });
      },
    }));
}

/** The project's agent profiles (none until they load, or if they can't). */
function useProfiles(project: string): AgentProfile[] {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  useEffect(() => {
    let live = true;
    profilesApi.list(project).then(
      (v) => live && setProfiles(v.profiles),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [project]);
  return profiles;
}

// ---------------------------------------------------------------------------
// The pill
// ---------------------------------------------------------------------------

/** A check mark that draws itself (it just appears under reduced motion). */
function DrawnCheck() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden className="shrink-0 text-success">
      <circle cx={8} cy={8} r={7} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={1.5} />
      <path d="M4.8 8.3 7 10.4 11.2 5.9" pathLength={1} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="texo-check-draw" />
    </svg>
  );
}

function PillIcon({ pill }: { pill: PillState }) {
  switch (pill.kind) {
    case "needsInput":
    case "review":
      return <StatusDot tone="warning" pulse className="mx-[3px]" />;
    case "failed":
      return <StatusDot tone="danger" className="mx-[3px]" />;
    case "running":
      return <ProgressRing value={pill.fraction ?? undefined} size={16} label="Agent progress" />;
    case "finished":
      return <DrawnCheck />;
    default:
      return <MessagesSquare size={14} className="shrink-0" />;
  }
}

const PILL_TONES: Record<PillState["kind"], string> = {
  idle: "border-border bg-surface text-muted hover:border-accent/50 hover:text-text",
  running: "border-accent/35 bg-accent/[0.06] text-text hover:border-accent/60",
  needsInput: "border-warning/45 bg-warning/10 text-text hover:border-warning/70",
  review: "border-warning/45 bg-warning/10 text-text hover:border-warning/70",
  failed: "border-danger/45 bg-danger/10 text-text hover:border-danger/70",
  finished: "border-success/40 bg-success/10 text-text hover:border-success/65",
};

interface PillProps {
  pill: PillState;
  open: boolean;
  compact: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

export function CommandPill({ pill, open, compact, onToggle, buttonRef }: PillProps) {
  const more = pill.more > 0 ? ` +${pill.more}` : "";
  const label = pill.kind === "idle" ? "Ask AI and see recent chats" : `${pill.text}${pill.more ? ` (and ${pill.more} more)` : ""}`;
  return (
    <Tooltip content={label} shortcut={SHORTCUT} disabled={open || !compact}>
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Command Center: ${label}`}
        aria-keyshortcuts="Control+Shift+J"
        title={compact ? undefined : `${label} (${SHORTCUT})`}
        data-state={pill.kind}
        className={`inline-flex h-7 max-w-[360px] min-w-0 items-center gap-2 rounded-full border text-xs transition-colors duration-150 ${
          compact ? "px-2" : "min-w-[160px] px-3"
        } ${PILL_TONES[pill.kind]} ${open ? "border-accent/60 text-text" : ""}`}
      >
        <PillIcon pill={pill} />
        {!compact && (
          <>
            {/* Keyed by the words, so a new activity fades in over the old one. */}
            <span key={pill.text} className="texo-fade-in min-w-0 flex-1 truncate text-left">
              <span className={pill.kind === "running" ? "texo-shimmer" : ""}>{pill.text}</span>
            </span>
            {more && <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[10px] leading-4 text-muted">{more.trim()}</span>}
            {pill.kind === "idle" && <Kbd className="hidden shrink-0 lg:inline-flex">{SHORTCUT}</Kbd>}
          </>
        )}
        {compact && more && <span className="text-[10px] text-muted">{more.trim()}</span>}
      </button>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// The popover's rows
// ---------------------------------------------------------------------------

function RunIcon({ run }: { run: RunSummary }) {
  switch (run.status) {
    case "queued":
    case "running":
      return <ProgressRing value={runProgressFraction(run) ?? undefined} size={14} label={`${runTitle(run)} progress`} />;
    case "awaiting_input":
      return <StatusDot tone="warning" pulse className="mx-[3px]" />;
    case "awaiting_review":
      return <FileDiff size={14} className="shrink-0 text-warning" />;
    case "done":
      return <CircleCheck size={14} className="shrink-0 text-success" />;
    case "failed":
    case "interrupted":
      return <CircleX size={14} className="shrink-0 text-danger" />;
    default:
      return <Square size={12} className="mx-px shrink-0 text-muted" />;
  }
}

const settledText = (run: RunSummary) => {
  const when = run.finishedAt ?? run.startedAt;
  const word = run.status === "done" ? "Finished" : run.status === "cancelled" ? "Stopped" : "Didn't finish";
  return `${word} ${formatRelative(new Date(when * 1000).toISOString())}`;
};

function RowBody({ row, nowSecs }: { row: Row; nowSecs: number }) {
  switch (row.type) {
    case "attention":
      return (
        <>
          <RunIcon run={row.run} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-text">{runTitle(row.run)}</span>
            <span className="block truncate text-[11px] text-muted">{row.reason}</span>
          </span>
          <span className="shrink-0 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-text group-data-[active=true]:border-accent/60">{row.action.label}</span>
        </>
      );
    case "running":
      return (
        <>
          <RunIcon run={row.run} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-text">{runTitle(row.run)}</span>
            <span className="block truncate text-[11px] text-muted">{phaseText(row.run)}</span>
          </span>
          <span className="shrink-0 text-[11px] text-muted tabular-nums">{formatElapsed(elapsedSecs(row.run, nowSecs))}</span>
        </>
      );
    case "recent":
      return (
        <>
          <RunIcon run={row.run} />
          <span className="min-w-0 flex-1 truncate text-text">{runTitle(row.run)}</span>
          <span className="shrink-0 text-[11px] text-muted">{settledText(row.run)}</span>
        </>
      );
    case "chat":
      return (
        <>
          <MessagesSquare size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate text-text">{row.chat.title || "New chat"}</span>
          {row.pending && (
            <span className="shrink-0 text-accent" aria-label="Answering">
              ●
            </span>
          )}
          <span className="shrink-0 text-[11px] text-muted">{formatRelative(new Date(row.chat.updated).toISOString())}</span>
        </>
      );
    case "allChats":
      return (
        <>
          <MessagesSquare size={14} className="shrink-0 text-muted" />
          <span className="flex-1 text-muted">Show all chats</span>
        </>
      );
  }
}

// ---------------------------------------------------------------------------
// The popover
// ---------------------------------------------------------------------------

interface PanelProps {
  project: string;
  /** Closes the popover; `restoreFocus` puts focus back on the pill. */
  close: (restoreFocus: boolean) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

function CommandPanel({ project, close, inputRef }: PanelProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const allRuns = useRuns((s) => s.runs);
  const chats = useChat((s) => s.chats);
  const pending = useChat((s) => s.pending);
  const unseen = useSeen((s) => s.unseen);
  const [access] = useAccess();
  const canStart = access.state === "ready" || access.state === "loading";
  const profiles = useProfiles(project);
  const ownTasks = useMemo(() => profileTasks(project, profiles), [project, profiles]);
  const tasksId = `${uid}-tasks`;
  const [tasksWanted, setTasksOpen] = useState(false);
  // It folds up again if the AI stops being usable while it's open.
  const tasksOpen = tasksWanted && canStart;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const runs = useMemo(() => runsForProject(allRuns, project), [allRuns, project]);
  const sections = useMemo(() => buildSections({ runs, chats, unseen, pending, query }), [runs, chats, unseen, pending, query]);
  const rows = flatRows(sections);
  const current = rows[Math.min(active, rows.length - 1)];
  const optionId = (row: Row) => `${uid}-${row.id}`;
  const nowSecs = useNowSecs(rows.some((r) => r.type === "running"));

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (current) document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Focus goes back to the pill first, so it never drops to the page as the
  // popover unmounts. What the action opens then takes it: a dialog (which
  // gives it back to the pill when it closes), the AI Chat bar for a chat,
  // or the Chat tab's list of chats.
  const act = (run: () => void) => {
    close(true);
    run();
  };
  const pick = (row: Row) => act(() => runRow(row));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => moveSelection(Math.min(i, rows.length - 1), e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      pick(current);
    }
  };

  let index = 0;
  return (
    <div className="flex max-h-[calc(70vh-2px)] flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3">
        <Search size={14} className="shrink-0 text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(current) : undefined}
          aria-label="Search chats and tasks"
          placeholder="Search chats and tasks…"
          spellCheck={false}
          className="h-10 min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
        />
        <Kbd>Esc</Kbd>
      </div>

      <div id={listId} role="listbox" aria-label="Chats and tasks" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {rows.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted">{query.trim() ? "Nothing matches." : "No chats or tasks yet. Ask the AI something to start."}</p>
        )}
        {sections.map((section) => (
          <div key={section.id} role="group" aria-labelledby={section.label ? `${uid}-h-${section.id}` : undefined} aria-label={section.label ? undefined : "More"} className="mb-1 last:mb-0">
            {section.label && (
              <div id={`${uid}-h-${section.id}`} role="presentation" className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
                {section.label}
              </div>
            )}
            {section.rows.map((row) => {
              const i = index++;
              const isActive = current?.id === row.id;
              return (
                <div
                  key={row.id}
                  id={optionId(row)}
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive}
                  onMouseMove={() => i !== active && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(row)}
                  className="group flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-100 data-[active=true]:bg-surface-2"
                >
                  <RowBody row={row} nowSecs={nowSecs} />
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Inert while collapsed, so its entries are out of the tab order and the accessibility tree. */}
      <div className="texo-collapse shrink-0" data-open={tasksOpen} inert={!tasksOpen}>
        <div id={tasksId} role="group" aria-label="New task">
          <div className="grid grid-cols-2 gap-1 border-t border-border p-1.5">
            {NEW_TASKS.map((t) => (
              <TaskButton key={t.label} task={t} onPick={act} />
            ))}
          </div>
          {ownTasks.length > 0 && (
            <div className="grid grid-cols-2 gap-1 border-t border-border p-1.5">
              {ownTasks.map((t, i) => (
                <TaskButton key={`${i}-${t.label}`} task={t} onPick={act} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-border bg-surface-2/40 p-1.5">
        <FooterButton onClick={() => act(newChat)}>
          <Plus size={14} /> New chat
        </FooterButton>
        <FooterButton
          onClick={() => setTasksOpen((o) => !o)}
          aria-expanded={tasksOpen}
          aria-controls={tasksId}
          disabled={!canStart}
          title={canStart ? undefined : "Set up AI first (see the Agents tab)."}
        >
          <ListTodo size={14} /> New task <ChevronDown size={13} className={`transition-transform duration-150 ${tasksOpen ? "rotate-180" : ""}`} />
        </FooterButton>
        <FooterButton
          className="ml-auto"
          onClick={() => act(() => useAiPanel.getState().show("agents"))}
        >
          <Bot size={14} /> All tasks
        </FooterButton>
      </div>
    </div>
  );
}

function TaskButton({ task, onPick }: { task: NewTask; onPick: (run: () => void) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(task.run)}
      className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-text hover:bg-surface-2"
    >
      <span className="shrink-0 text-muted">{task.icon}</span>
      <span className="truncate">{task.label}</span>
    </button>
  );
}

function FooterButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------

export function CommandCenter({ project }: { project: string }) {
  useFollow(project);
  const allRuns = useRuns((s) => s.runs);
  const unseen = useSeen((s) => s.unseen);
  const [open, setOpen] = useState(false);
  const compact = useMedia(NARROW_QUERY);
  const pillRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pill = useMemo(() => pillState(runsForProject(allRuns, project), unseen), [allRuns, project, unseen]);

  const openRef = useRef(open);
  openRef.current = open;
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) pillRef.current?.focus();
  };

  // The popover showed every finish: they are seen once it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) useSeen.setState((s) => markSeen(s));
    wasOpen.current = open;
  }, [open]);

  // Ctrl+Shift+J from anywhere in the window, the editors included (they don't use it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not behind an open dialog: the popover would take focus from it.
      if (!isCommandCenterShortcut(e) || e.repeat || modalOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      if (openRef.current) close(true);
      else setOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Command Center"
      role="dialog"
      align="center"
      width="min(420px, calc(100vw - 24px))"
      initialFocus={inputRef}
      className="max-w-full min-w-0"
      trigger={<CommandPill pill={pill} open={open} compact={compact} onToggle={() => setOpen((o) => !o)} buttonRef={pillRef} />}
    >
      <CommandPanel project={project} close={close} inputRef={inputRef} />
    </Popover>
  );
}
