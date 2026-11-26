// Whether the AI features can be used right now: AI turned on, a key for
// the chosen provider, and that provider's privacy notice accepted. Shared by
// the Chat and Agents tabs; re-checked when the Settings dialog closes.

import { useCallback, useEffect, useState } from "react";
import { aiApi, type AiProviderInfo } from "../lib/api";
import { useUi } from "../ui";
import { loadProviders, useAiSettings } from "./aiPrefs";

export type Access =
  | { state: "loading" }
  | { state: "off" }
  | { state: "noKey"; provider: AiProviderInfo }
  | { state: "notice"; provider: AiProviderInfo }
  | { state: "ready"; provider: AiProviderInfo };

/** Whether the AI can be used now: AI on, a key for the provider, the privacy notice accepted. Re-checked when Settings closes. */
export function useAccess(): [Access, () => void] {
  const settings = useAiSettings((s) => s.settings);
  const dialog = useUi((s) => s.dialog);
  const [access, setAccess] = useState<Access>({ state: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (dialog === "settings") return;
    let live = true;
    void (async () => {
      const s = await useAiSettings.getState().load();
      if (!s.enabled) {
        if (live) setAccess({ state: "off" });
        return;
      }
      const providers = await loadProviders();
      const provider = providers.find((p) => p.id === s.provider) ?? providers[0];
      let hasKey = provider.key.hasKey || !provider.keyRequired;
      if (provider.keyRequired) {
        try {
          hasKey = (await aiApi.keyStatus(provider.id)).hasKey;
        } catch {
          // Use what the provider list said.
        }
      }
      if (!live) return;
      if (!hasKey) setAccess({ state: "noKey", provider });
      else if (!s.noticeAccepted.includes(provider.id)) setAccess({ state: "notice", provider });
      else setAccess({ state: "ready", provider });
    })();
    return () => {
      live = false;
    };
  }, [dialog, settings.enabled, settings.provider, settings.noticeAccepted.join(","), tick]);

  // Stable, so effects that depend on it don't re-run (and re-check) every render (FE-3).
  const recheck = useCallback(() => setTick((t) => t + 1), []);
  return [access, recheck];
}
