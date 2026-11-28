// The AI tabs' parts for the editor (Chat, Agents, Papers, the run tabs): what each tab shows in the tab strip
// (icon, name, badge), the content that takes the editor area while an AI
// tab is in front, and the hook that keeps the tabs in step with the project
// (restore on open, a file shown puts the file in front, a deleted run's tab
// closes).

import { useEffect } from "react";
import { BookOpen, Bot, MessagesSquare } from "lucide-react";
import { isActive, type RunSummary } from "../../lib/agentsApi";
import { ProgressRing } from "../../components/ui/ProgressRing";
import { StatusDot } from "../../components/ui/StatusDot";
import { LibraryPanel } from "../../library/LibraryPanel";
import { onOpenFile, useWorkspace } from "../../workspace/store";
import { AgentsTab } from "../agents/AgentsTab";
import { health, runFraction } from "../agents/progress/progressModel";
import { RunView } from "../agents/RunCard";
import { kindLabel, useRuns } from "../agents/runsStore";
import { ChatTab } from "../chat/ChatTab";
import { useChat } from "../chat/chatStore";
import { useAiPanel } from "../panel/aiPanelStore";
import { runIdOf, runsListed, runTabKeeper, showFileInFront, useAiTabs, type AiTabId } from "./aiTabsStore";

/** The tab's DOM id (the strip's `role=tab`), so its panel can point at it. */
export const aiTabDomId = (id: AiTabId) => `editor-tab-ai-${id.replace(/[^\w-]/g, "_")}`;
export const AI_TAB_PANEL_ID = "editor-ai-panel";

/** A tab's name: Chat, Agents, Papers, or the run's title. */
export function aiTabLabel(id: AiTabId, run?: Pick<RunSummary, "title" | "kind">): string {
  if (id === "chat") return "Chat";
  if (id === "agents") return "Agents";
  if (id === "papers") return "Papers";
  return run ? run.title.trim() || kindLabel(run.kind) : "Task";
}

/** A run tab's icon: a ring while it works, else a dot for how it stands. */
function RunTabIcon({ run }: { run: RunSummary | undefined }) {
  if (!run) return <Bot size={13} className="shrink-0 text-muted" aria-hidden="true" />;
  if (isActive(run.status) && run.status !== "awaiting_input") {
    const f = runFraction(run);
    return <ProgressRing size={13} stroke={2} value={f ?? undefined} tone={run.status === "queued" ? "text-muted" : "text-accent"} className="shrink-0" />;
  }
  const h = health(run);
  return (
    <span className="grid size-[13px] shrink-0 place-items-center" aria-hidden="true">
      <StatusDot tone={h.tone} />
    </span>
  );
}

/** The icon, name and badge of an AI tab in the strip. */
export function AiTabLabel({ id }: { id: AiTabId }) {
  const runId = runIdOf(id);
  const run = useRuns((s) => (runId ? s.runs[runId] : undefined));
  const badge = useAiPanel((s) => (id === "agents" ? s.badge : 0));
  const answering = useChat((s) => id === "chat" && !!s.current && !!s.pending[s.current.id]);
  const label = aiTabLabel(id, run);
  return (
    <>
      {id === "chat" ? (
        <MessagesSquare size={13} className="shrink-0 text-accent" aria-hidden="true" />
      ) : id === "agents" ? (
        <Bot size={13} className="shrink-0 text-accent" aria-hidden="true" />
      ) : id === "papers" ? (
        <BookOpen size={13} className="shrink-0 text-accent" aria-hidden="true" />
      ) : (
        <RunTabIcon run={run} />
      )}
      <span className="truncate">{label}</span>
      {answering && <StatusDot tone="accent" pulse label="Answering" />}
      {badge > 0 && (
        <span className="texo-pop rounded-full bg-accent px-1.5 text-[10px] leading-4 font-semibold text-accent-ink" aria-label={`${badge} finished`}>
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </>
  );
}

/** The editor area while an AI tab is in front. */
export function AiTabView({ project, tab }: { project: string; tab: AiTabId }) {
  const runId = runIdOf(tab);
  return (
    <div
      key={tab}
      id={AI_TAB_PANEL_ID}
      role="tabpanel"
      aria-labelledby={aiTabDomId(tab)}
      className="texo-fade-in flex min-h-0 flex-1 flex-col bg-bg [animation-duration:var(--dur-1)]!"
    >
      {tab === "chat" ? (
        <ChatTab project={project} />
      ) : tab === "agents" ? (
        <AgentsTab project={project} />
      ) : tab === "papers" ? (
        <PapersTab project={project} />
      ) : (
        runId && <RunView project={project} runId={runId} />
      )}
    </div>
  );
}

/**
 * The paper library in the editor area: the sidebar-sized panel in a centred
 * column like Chat and Agents, edged once the area is wide enough to leave
 * space either side.
 */
export function PapersTab({ project }: { project: string }) {
  return (
    <div className="@container/papers-tab flex min-h-0 flex-1 justify-center">
      <div className="flex min-h-0 w-full max-w-3xl flex-col @min-[52rem]/papers-tab:border-x @min-[52rem]/papers-tab:border-border">
        <LibraryPanel project={project} />
      </div>
    </div>
  );
}

/**
 * Closes an AI tab; when it was in front and no other AI tab takes its
 * place, the last file tab shows again.
 */
export function closeAiTab(id: AiTabId) {
  const ws = useWorkspace.getState();
  const next = useAiTabs.getState().close(id, ws.tabs);
  if (next.kind === "file" && next.path !== ws.active) void ws.openFile(next.path);
}

/**
 * Keeps the AI tabs in step with the open project: restores its saved tabs
 * once the files are back (`ready`), puts a file in front whenever one is
 * asked to show, and closes the tab of a run that was deleted.
 */
export function useAiTabsSync(projectKey: string, project: string, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    useAiTabs.getState().load(projectKey);
    // Tabs of runs deleted since last time close, if the runs are listed already.
    const runs = useRuns.getState();
    if (runsListed(runs, project)) useAiTabs.getState().pruneRuns((id) => !!runs.runs[id]);
    return () => useAiTabs.getState().reset();
  }, [projectKey, project, ready]);

  useEffect(() => onOpenFile(showFileInFront), []);

  useEffect(
    () =>
      useRuns.subscribe((next, prev) => {
        const keep = runTabKeeper(prev, next, project);
        if (keep) useAiTabs.getState().pruneRuns(keep);
      }),
    [project],
  );
}
