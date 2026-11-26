// "Let the fixer agent handle it": next to the quick "Explain & fix" in the
// Issues panel. Starts a fixer run in the background (it compiles a private
// copy, fixes, checks again) and shows it in the AI panel's Agents tab.

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { useAiSettings } from "../aiPrefs";
import { startFixerRun } from "./actions";

export function FixerAgentButton() {
  const enabled = useAiSettings((s) => s.settings.enabled);
  const loaded = useAiSettings((s) => s.loaded);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!loaded) void useAiSettings.getState().load();
  }, [loaded]);
  if (!enabled) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void startFixerRun().finally(() => setBusy(false));
      }}
      title="Start the fixer agent in the background: it fixes the errors in a private copy, compiles to check, and you review its changes"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-muted hover:border-accent/60 hover:text-text disabled:opacity-50"
    >
      <Bot size={12} className="text-accent" /> Let the fixer agent handle it
    </button>
  );
}
