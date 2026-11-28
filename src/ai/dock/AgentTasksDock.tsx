// The background tasks dock at the top of the sidebar footer: the agent runs
// that are working or wait on you, at most three rows (ring, title, what it
// does now) and "n more". A row opens the run's own editor tab; "n more"
// opens the Agents tab. Folded to the rail it is one icon with a ring and a
// count. It follows the run events itself, so it stays live whatever shows.

import { useEffect } from "react";
import { ListChecks } from "lucide-react";
import { isActive, runProgress, runStatusText, type RunSummary } from "../../lib/agentsApi";
import { ProgressRing } from "../../components/ui/ProgressRing";
import { StatusDot } from "../../components/ui/StatusDot";
import { Tooltip } from "../../components/ui/Tooltip";
import { useRunFocus } from "../agents/focusStore";
import { LiveLine } from "../agents/progress/LiveLine";
import { dockRows, health, runFraction } from "../agents/progress/progressModel";
import { kindLabel, listenRunEvents, runsForProject, runStream, useRuns } from "../agents/runsStore";
import { useAiPanel } from "../panel/aiPanelStore";

/** Opens a run's editor tab (or brings it forward). */
export function openRun(runId: string) {
  useRunFocus.getState().focus(runId);
}

const rowBtn = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-2";

function RunIcon({ run, size }: { run: RunSummary; size: number }) {
  if (isActive(run.status) && run.status !== "awaiting_input") {
    const f = runFraction(run);
    return <ProgressRing size={size} stroke={2} value={f ?? undefined} label={`${run.title || kindLabel(run.kind)}: progress`} tone={run.status === "queued" ? "text-muted" : "text-accent"} />;
  }
  const h = health(run);
  return (
    <span className="grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <StatusDot tone={h.tone} label={h.label} />
    </span>
  );
}

function DockRow({ run, stream }: { run: RunSummary; stream?: string }) {
  const working = isActive(run.status) && run.status !== "awaiting_input";
  return (
    <li className="texo-fade-in">
      <button type="button" className={rowBtn} onClick={() => openRun(run.id)} title={`Open “${run.title || kindLabel(run.kind)}” in a tab`}>
        <RunIcon run={run} size={14} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-text/90">{run.title || kindLabel(run.kind)}</span>
          {working ? (
            <LiveLine compact activity={runProgress(run).activity} stream={stream} idle={runStatusText(run)} />
          ) : (
            <span className="block truncate text-[11px] text-muted">{runStatusText(run)}</span>
          )}
        </span>
      </button>
    </li>
  );
}

export interface DockListProps {
  runs: RunSummary[];
  compact: boolean;
  streams?: Record<string, string | undefined>;
}

/** The dock for a list of the project's runs (newest first). */
export function DockList({ runs, compact, streams = {} }: DockListProps) {
  const { shown, more } = dockRows(runs);
  const total = shown.length + more;
  const label = total === 0 ? "No background tasks" : `${total} background task${total === 1 ? "" : "s"}`;
  if (compact) {
    // The rail shows the ring of a run that works, if any; a click opens the first run listed.
    const first = shown[0];
    const icon = shown.find((r) => r.status === "running" || r.status === "queued") ?? first;
    return (
      <Tooltip content={total === 0 ? label : `${label}: ${shown.map((r) => r.title || kindLabel(r.kind)).join(", ")}${more ? ` and ${more} more` : ""}`} side="right">
        <button
          type="button"
          aria-label={label}
          disabled={!first}
          onClick={() => first && openRun(first.id)}
          className="relative grid size-8 place-items-center rounded-md text-muted transition-colors enabled:hover:bg-surface-2 enabled:hover:text-text"
        >
          {icon ? <RunIcon run={icon} size={16} /> : <ListChecks size={15} />}
          {total > 1 && (
            <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-semibold text-accent-ink">
              {total > 9 ? "9+" : total}
            </span>
          )}
        </button>
      </Tooltip>
    );
  }
  if (total === 0)
    return (
      <div className="flex h-7 items-center gap-2 px-2 text-xs text-muted">
        <ListChecks size={14} className="shrink-0" />
        <span className="truncate">{label}</span>
      </div>
    );
  return (
    <section aria-label="Background tasks" className="pb-0.5">
      <p className="flex h-6 items-center gap-2 px-2 text-[11px] font-medium text-muted">
        <ListChecks size={13} className="shrink-0" />
        <span className="truncate">Background tasks</span>
      </p>
      <ul>
        {shown.map((r) => (
          <DockRow key={r.id} run={r} stream={streams[r.id]} />
        ))}
      </ul>
      {more > 0 && (
        <button type="button" onClick={() => useAiPanel.getState().show("agents")} className={`${rowBtn} text-[11px] text-muted hover:text-text`}>
          <span className="w-3.5 shrink-0" aria-hidden="true" />
          {more} more
        </button>
      )}
    </section>
  );
}

export function AgentTasksDock({ project, compact }: { project: string; compact: boolean }) {
  const runs = useRuns((s) => s.runs);
  const streams = useRuns((s) => s.streams);
  useEffect(() => listenRunEvents(), []);
  useEffect(() => {
    void useRuns.getState().load(project);
  }, [project]);
  const list = runsForProject(runs, project);
  const byRun: Record<string, string | undefined> = {};
  for (const r of list) byRun[r.id] = runStream(streams, r.id);
  return <DockList runs={list} compact={compact} streams={byRun} />;
}
