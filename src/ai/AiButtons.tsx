// The AI buttons in the Issues panel: "Explain & fix" on an error, and "Fix
// compile errors" in the panel header. With the helper turned off, the
// per-error buttons hide and the header one leads to Settings > AI.

import { useEffect } from "react";
import { Sparkles } from "lucide-react";
import type { Issue } from "../lib/api";
import { useAiSettings } from "./aiPrefs";
import { explainIssue, fixAllErrors, useFix } from "./fixStore";

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

export function FixAllButton() {
  const enabled = useAiEnabled();
  const busy = useFix((s) => s.open);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={fixAllErrors}
      title={enabled ? "Ask the AI helper to explain and fix the errors" : "The AI helper is off. Turn it on in Settings > AI."}
      className="ml-auto inline-flex items-center gap-1 rounded-full border border-accent/50 bg-accent/10 px-2.5 py-0.5 text-text hover:bg-accent/20 disabled:opacity-50"
    >
      <Sparkles size={12} className="text-accent" /> Fix compile errors
    </button>
  );
}
