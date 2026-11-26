// The right-dock AI panel (spec "UI placement"): toggled from the toolbar or
// with Ctrl+Shift+A, resizable from its left edge, width and tab remembered.
// Tabs: Chat (src/ai/chat) and Agents (src/ai/agents/AgentsTab.tsx, built
// separately). While the panel is hidden or on Chat, agent runs that finish
// raise a badge on the toolbar button and the Agents tab, and show a toast.

import { useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { Bot, MessagesSquare, Sparkles, X } from "lucide-react";
import { agentsApi } from "../../lib/agentsApi";
import { toast } from "../../ui";
import { AgentsTab } from "../agents/AgentsTab";
import { ChatTab } from "../chat/ChatTab";
import { listenChatEvents } from "../chat/chatStore";
import { finishText, useAiPanel, type AiTab } from "./aiPanelStore";

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Watches agent runs of the open project for the finish badge and toast (mounted with the toolbar, so it runs while the panel is closed). */
function useRunWatcher(project: string) {
  useEffect(() => {
    let live = true;
    const panel = useAiPanel.getState;
    // Seed what is already known, so only later finishes count.
    agentsApi.list(project).then(
      (runs) => live && runs.forEach((r) => panel().noteRun(r)),
      () => {},
    );
    const off = agentsApi.onRunUpdated((run) => {
      if (!live || !samePath(run.project, project)) return;
      if (panel().noteRun(run)) toast(finishText(run), run.status === "failed" || run.status === "interrupted" ? "error" : "info");
    });
    return () => {
      live = false;
      void off.then((f) => f()).catch(() => {});
    };
  }, [project]);
}

/** The toolbar's toggle, with the finished-runs badge. */
export function AiPanelButton({ project }: { project: string }) {
  const open = useAiPanel((s) => s.open);
  const badge = useAiPanel((s) => s.badge);
  const toggle = useAiPanel((s) => s.toggle);
  useRunWatcher(project);
  const label = badge ? `AI panel (${badge} finished)` : "AI panel";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-pressed={open}
      title={`${label} (Ctrl+Shift+A)`}
      className={`relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[13px] transition ${
        open ? "border-accent/50 bg-accent/15 text-text" : "border-border bg-surface text-muted hover:text-text"
      }`}
    >
      <Sparkles size={14} className="text-accent" />
      <span className="hidden lg:inline">AI</span>
      {badge > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}

/** Starts a drag on the panel's left edge. */
function startResize(e: ReactPointerEvent) {
  e.preventDefault();
  const right = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().right;
  const { setWidth } = useAiPanel.getState();
  const move = (ev: PointerEvent) => setWidth(right - ev.clientX, false);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
    setWidth(useAiPanel.getState().width, true);
  };
  document.body.style.cursor = "col-resize";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

const TABS: [AiTab, string, typeof Bot][] = [
  ["chat", "Chat", MessagesSquare],
  ["agents", "Agents", Bot],
];

export function AiPanel({ project }: { project: string }) {
  const open = useAiPanel((s) => s.open);
  const width = useAiPanel((s) => s.width);
  const tab = useAiPanel((s) => s.tab);
  const badge = useAiPanel((s) => s.badge);
  const setTab = useAiPanel((s) => s.setTab);

  useEffect(() => listenChatEvents(), []);

  // Keep the remembered width within a smaller window.
  useEffect(() => {
    const fit = () => useAiPanel.getState().setWidth(useAiPanel.getState().width, false);
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  if (!open) return null;
  return (
    <aside style={{ width }} aria-label="AI panel" className="relative flex shrink-0 flex-col border-l border-border bg-surface/60">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI panel"
        onPointerDown={startResize}
        onDoubleClick={() => useAiPanel.getState().setWidth(400)}
        className="absolute inset-y-0 -left-0.5 z-10 w-1 cursor-col-resize hover:bg-accent/40"
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <div role="tablist" className="flex flex-1 gap-1">
          {TABS.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${tab === value ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}
            >
              <Icon size={14} /> {label}
              {value === "agents" && badge > 0 && <span className="ml-0.5 rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-accent-ink">{badge}</span>}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Close AI panel" title="Close (Ctrl+Shift+A)" onClick={() => useAiPanel.getState().setOpen(false)} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text">
          <X size={15} />
        </button>
      </div>
      {/* Both stay mounted while the panel is open, so switching tabs keeps scroll and drafts. */}
      <div className={tab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <ChatTab project={project} />
      </div>
      <div className={tab === "agents" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <AgentsTab project={project} />
      </div>
    </aside>
  );
}
