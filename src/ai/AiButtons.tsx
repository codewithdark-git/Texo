// The AI buttons in the Issues panel: "Explain & fix" on an error, and the
// "Fix issues" split button in the panel's header. The main part starts the
// fixer agent; its menu also offers the quick "Explain & fix" over every
// error. While a fixer run works the button becomes a progress chip. With the
// helper turned off, both hide.

import { useEffect, useState } from "react";
import { Bot, ChevronDown, Loader2, Sparkles } from "lucide-react";
import type { Issue } from "../lib/api";
import { Popover } from "../components/ui/Popover";
import { Tooltip } from "../components/ui/Tooltip";
import { useAiSettings } from "./aiPrefs";
import { explainIssue, fixAllErrors, useFix } from "./fixStore";
import { fixIssuesLabel, fixIssuesState, type FixCompileStatus, type FixIssuesState, type IssueCounts } from "./fixIssues";
import { FixerProgressChip, focusRun, useActiveFixer, useStartFixer } from "./agents/FixerButton";

function useAiEnabled(): boolean {
  const enabled = useAiSettings((s) => s.settings.enabled);
  const loaded = useAiSettings((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useAiSettings.getState().load();
  }, [loaded]);
  return enabled;
}

export function ExplainIssueButton({ issue }: { issue: Issue }) {
  const enabled = useAiEnabled();
  const busy = useFix((s) => s.open);
  if (!enabled || issue.severity !== "error") return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => explainIssue(issue)}
      title="Ask the AI helper what this error means and how to fix it"
      className="mt-1 inline-flex h-6 shrink-0 items-center gap-1 self-start rounded-md border border-border px-2 text-[11px] text-muted hover:border-accent/60 hover:text-text disabled:opacity-50"
    >
      <Sparkles size={12} className="text-accent" /> Explain &amp; fix
    </button>
  );
}

/** The split button's menu, in order. */
export const FIX_MENU = [
  { id: "quick", label: "Quick fix (Explain & fix)", hint: "Proposes edits here for you to review" },
  { id: "agent", label: "Let the fixer agent handle it", hint: "Works in the background, compiles to check, then you review" },
] as const;

interface FixIssuesViewProps {
  state: FixIssuesState;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** Start the fixer agent (the main click, and the menu's second item). */
  onAgent: () => void;
  onQuickFix: () => void;
  onShowRun: (runId: string) => void;
  /** A fixer run is being started. */
  starting?: boolean;
  /** The quick fix is already open. */
  quickBusy?: boolean;
}

/** The "Fix issues" button for a state; no stores, so it renders anywhere. */
export function FixIssuesView({ state, menuOpen, onMenuOpenChange, onAgent, onQuickFix, onShowRun, starting = false, quickBusy = false }: FixIssuesViewProps) {
  if (state.kind === "hidden") return null;
  if (state.kind === "progress") return <FixerProgressChip label={state.label} value={state.value} onClick={() => onShowRun(state.runId)} />;

  const off = state.kind === "disabled" || starting;
  const label = fixIssuesLabel(state.count);
  const tip = state.kind === "disabled" ? state.reason : "Start the fixer agent: it fixes the errors in a private copy, compiles to check, and you review its changes";
  const menuOff = state.kind === "disabled";
  const segment = (disabled: boolean) =>
    `inline-flex h-6 items-center bg-accent text-accent-ink transition-colors duration-[var(--dur-2)] ${disabled ? "cursor-not-allowed" : "hover:bg-accent-strong"}`;
  const pick = (run: () => void) => () => {
    onMenuOpenChange(false);
    run();
  };

  return (
    <div role="group" aria-label="Fix issues" className={`texo-fade-in inline-flex shrink-0 rounded-full text-xs font-medium transition-opacity duration-[var(--dur-2)] ${off ? "opacity-60" : ""}`}>
      <Tooltip content={tip} side="bottom">
        <button
          type="button"
          aria-disabled={off || undefined}
          onClick={() => !off && onAgent()}
          className={`${segment(off)} gap-1.5 rounded-l-full pr-2 pl-2.5`}
        >
          {starting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          <span className="whitespace-nowrap">{label}</span>
        </button>
      </Tooltip>
      <Popover
        open={menuOpen && state.kind === "ready"}
        onOpenChange={onMenuOpenChange}
        label="Ways to fix the issues"
        role="menu"
        align="end"
        width={264}
        panelClassName="p-1"
        trigger={
          <button
            type="button"
            aria-label="More ways to fix"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-disabled={menuOff || undefined}
            onClick={() => !menuOff && onMenuOpenChange(!menuOpen)}
            className={`${segment(menuOff)} rounded-r-full border-l border-accent-ink/20 pr-1.5 pl-1`}
          >
            <ChevronDown size={13} className={`transition-transform duration-[var(--dur-2)] ${menuOpen ? "rotate-180" : ""}`} />
          </button>
        }
      >
        {FIX_MENU.map((item) => {
          const disabled = item.id === "quick" ? quickBusy : starting;
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={pick(item.id === "quick" ? onQuickFix : onAgent)}
              className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-normal text-text enabled:hover:bg-surface-2 disabled:opacity-50"
            >
              <span className="mt-0.5 shrink-0 text-accent">{item.id === "quick" ? <Sparkles size={14} /> : <Bot size={14} />}</span>
              <span className="min-w-0">
                <span className="block">{item.label}</span>
                <span className="block text-xs text-muted">{item.hint}</span>
              </span>
            </button>
          );
        })}
      </Popover>
    </div>
  );
}

/** The Issues header's "Fix issues" button, wired to the stores. */
export function FixIssuesButton({ project, counts, status }: { project: string | null; counts: IssueCounts; status: FixCompileStatus }) {
  const enabled = useAiEnabled();
  const quickBusy = useFix((s) => s.open);
  const fixer = useActiveFixer(enabled ? project : null);
  const { busy, start } = useStartFixer();
  const [menuOpen, setMenuOpen] = useState(false);
  const state = fixIssuesState(counts, status, enabled, fixer);
  useEffect(() => {
    if (state.kind !== "ready") setMenuOpen(false);
  }, [state.kind]);
  return (
    <FixIssuesView
      state={state}
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
      onAgent={start}
      onQuickFix={fixAllErrors}
      onShowRun={focusRun}
      starting={busy}
      quickBusy={quickBusy}
    />
  );
}
