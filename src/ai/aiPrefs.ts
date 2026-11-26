// The AI helper's settings that aren't secret: on or off, which provider and
// model, a custom server address, and which providers' privacy notice the
// user has accepted. The backend keeps them (ai.json); this store mirrors
// them for the UI. API keys are never part of it.

import { create } from "zustand";
import { aiApi, type AiProviderId, type AiProviderInfo, type AiSettings, type AiSettingsPatch } from "../lib/api";

const PROVIDERS: AiProviderId[] = ["nvidia", "openrouter", "groq", "gemini", "anthropic", "custom"];

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  provider: "nvidia",
  models: {},
  customBaseUrl: null,
  noticeAccepted: [],
};

/** Settings from the backend, with anything unexpected replaced by defaults. */
export function normalizeAiSettings(raw: unknown): AiSettings {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const isProvider = (v: unknown): v is AiProviderId => PROVIDERS.includes(v as AiProviderId);
  const models: AiSettings["models"] = {};
  if (o.models && typeof o.models === "object") {
    for (const [k, v] of Object.entries(o.models as Record<string, unknown>)) {
      if (isProvider(k) && typeof v === "string" && v) models[k] = v;
    }
  }
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_AI_SETTINGS.enabled,
    provider: isProvider(o.provider) ? o.provider : DEFAULT_AI_SETTINGS.provider,
    models,
    customBaseUrl: typeof o.customBaseUrl === "string" && o.customBaseUrl ? o.customBaseUrl : null,
    noticeAccepted: Array.isArray(o.noticeAccepted) ? o.noticeAccepted.filter(isProvider) : [],
  };
}

interface AiSettingsStore {
  settings: AiSettings;
  /** False until the backend has answered once. */
  loaded: boolean;
  load: () => Promise<AiSettings>;
  /** Saves a change; throws the backend's error (e.g. a bad server address). */
  update: (patch: AiSettingsPatch) => Promise<AiSettings>;
}

export const useAiSettings = create<AiSettingsStore>((set, get) => ({
  settings: DEFAULT_AI_SETTINGS,
  loaded: false,
  load: async () => {
    try {
      const settings = normalizeAiSettings(await aiApi.getSettings());
      set({ settings, loaded: true });
      return settings;
    } catch {
      return get().settings;
    }
  },
  update: async (patch) => {
    const settings = normalizeAiSettings(await aiApi.updateSettings(patch));
    set({ settings, loaded: true });
    return settings;
  },
}));

/** A custom server address that is plain http(s), or the reason it isn't. */
export function badBaseUrl(url: string): string | null {
  const text = url.trim();
  if (!text) return "Enter the server's address, for example http://localhost:11434/v1.";
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "That doesn't look like a web address.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "The address must start with http:// or https://.";
  if (parsed.username || parsed.password) return "Put the key in the key field, not in the address.";
  return null;
}

/** Shown before the backend's provider list arrives, and if it can't be read. */
export const FALLBACK_PROVIDERS: AiProviderInfo[] = (
  [
    ["nvidia", "NVIDIA", true],
    ["openrouter", "OpenRouter", true],
    ["groq", "Groq", true],
    ["gemini", "Google Gemini", true],
    ["anthropic", "Anthropic Claude", true],
    ["custom", "Custom (OpenAI-compatible)", false],
  ] as const
).map(([id, label, keyRequired]) => ({
  id,
  label,
  keyRequired,
  keyUrl: null,
  howTo: "",
  baseUrl: null,
  structured: "none" as const,
  model: null,
  key: { provider: id, hasKey: false, storage: null, warning: null },
}));

/** The providers the backend knows, or the fallback list if it can't say. */
export async function loadProviders(): Promise<AiProviderInfo[]> {
  try {
    const list = await aiApi.listProviders();
    return list.length ? list : FALLBACK_PROVIDERS;
  } catch {
    return FALLBACK_PROVIDERS;
  }
}
