// The top bar's AI button. Chat, Agents and each agent run open as editor
// tabs (src/ai/tabs), so the button opens the Chat tab or brings it forward
// (Ctrl+Shift+A does the same). It also watches the open project's agent
// runs: a run that finishes while neither the Agents tab nor its own tab is
// in view raises a badge here and on the Agents tab, and shows a toast with
// an Open button. While the badge shows, the button opens the finished work.
// It is a plain button, not a toggle: it never closes anything.

import { useEffect } from "react";
import { Sparkles } from "lucide-react";
import { agentsApi } from "../../lib/agentsApi";
import { toast } from "../../ui";
import { useAiTabs } from "../tabs/aiTabsStore";
import { finishText, openRunTab, showFinished, useAiPanel } from "./aiPanelStore";

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Watches agent runs of the open project for the finish badge and toast (mounted with the top bar, so it always runs). */
export function useRunWatcher(project: string) {
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
      if (panel().noteRun(run))
        toast(finishText(run), run.status === "failed" || run.status === "interrupted" ? "error" : "info", { label: "Open", run: () => openRunTab(run.id) });
    });
    return () => {
      live = false;
      void off.then((f) => f()).catch(() => {});
    };
  }, [project]);
}

/** What the AI button says: where a click goes, and how many tasks finished unseen. */
export function buttonLabel(badge: number): string {
  if (!badge) return "AI chat";
  return badge === 1 ? "1 task finished: open it" : `${badge} tasks finished: open the Agents tab`;
}

/**
 * The top bar's AI button: opens the Chat tab. While the finished-runs badge
 * shows, it opens what the badge counts instead (the one finished run, or the
 * Agents tab), so a click always clears it.
 */
export function AiPanelButton({ project }: { project: string }) {
  const chatInFront = useAiTabs((s) => s.active === "chat");
  const badge = useAiPanel((s) => s.badge);
  useRunWatcher(project);
  const label = buttonLabel(badge);
  return (
    <button
      type="button"
      onClick={() => (useAiPanel.getState().badge ? showFinished() : useAiPanel.getState().show("chat"))}
      aria-label={label}
      title={badge ? label : "AI chat (Ctrl+Shift+A)"}
      className={`relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[13px] transition-colors duration-[var(--dur-2)] ${
        chatInFront ? "border-accent/50 bg-accent/15 text-text" : "border-border bg-surface text-muted hover:text-text"
      }`}
    >
      <Sparkles size={14} className="text-accent" />
      <span className="hidden lg:inline">AI</span>
      {badge > 0 && (
        <span className="texo-pop absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}
