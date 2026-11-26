// Bindings for Settings > AI > Web (src-tauri/src/agents/tools/web_settings.rs):
// the optional OpenAlex / Tavily / Brave keys, the SearXNG address, the web
// search choice and the optional Crossref contact e-mail. Keys go into the OS
// credential store in Rust and never come back to the webview; the UI only
// sees whether one is set. Errors reject with the same `AiError` shape as the
// AI commands (`isAiError` in ./api).
import { invoke } from "@tauri-apps/api/core";

export type ServiceSecret = "openalex" | "tavily" | "brave";
export type SearchProvider = "tavily" | "brave" | "searxng";

export interface SecretStatus {
  secret: ServiceSecret;
  hasKey: boolean;
  /** "file": no OS credential store was available; `warning` explains it is less secure. */
  storage: "keychain" | "file" | null;
  warning: string | null;
}

export interface WebSettings {
  /** null: the first one set up (Tavily, then Brave, then SearXNG). */
  searchProvider: SearchProvider | null;
  searxngUrl: string | null;
  /** Sent to Crossref as `mailto` only when set. */
  contactEmail: string | null;
}

export interface WebToolsStatus {
  settings: WebSettings;
  /** One per secret: openalex, tavily, brave. */
  keys: SecretStatus[];
  /** The search the agents use now, if any. */
  activeSearch: SearchProvider | null;
  /** Whether agents are offered the `web_search` tool. */
  webSearchAvailable: boolean;
  /** Whether OpenAlex joins the paper search. */
  openalexEnabled: boolean;
}

/** Missing fields stay as they are; "" clears a text field; searchProvider "auto" goes back to automatic. */
export interface WebSettingsPatch {
  searchProvider?: SearchProvider | "auto";
  searxngUrl?: string;
  contactEmail?: string;
}

export const SERVICE_LABELS: Record<ServiceSecret, string> = {
  openalex: "OpenAlex",
  tavily: "Tavily",
  brave: "Brave Search",
};

export const SEARCH_LABELS: Record<SearchProvider, string> = {
  tavily: "Tavily",
  brave: "Brave Search",
  searxng: "SearXNG",
};

/** Where users get each key (free tiers). */
export const SERVICE_KEY_URLS: Record<ServiceSecret, string> = {
  openalex: "https://openalex.org/settings/api",
  tavily: "https://app.tavily.com",
  brave: "https://api-dashboard.search.brave.com",
};

/** One plain sentence for the settings page. */
export function webToolsSummary(s: WebToolsStatus): string {
  const papers = s.openalexEnabled
    ? "Paper search uses arXiv, Crossref, Semantic Scholar and OpenAlex."
    : "Paper search uses arXiv, Crossref and Semantic Scholar (no key needed).";
  const web = s.activeSearch
    ? `Web search uses ${SEARCH_LABELS[s.activeSearch]}.`
    : "Web search is off: add a Tavily or Brave key, or a SearXNG address, to turn it on.";
  return `${papers} ${web}`;
}

export const webToolsApi = {
  status: () => invoke<WebToolsStatus>("web_tools_status"),
  setKey: (secret: ServiceSecret, key: string) => invoke<WebToolsStatus>("web_tools_set_key", { secret, key }),
  clearKey: (secret: ServiceSecret) => invoke<WebToolsStatus>("web_tools_clear_key", { secret }),
  update: (patch: WebSettingsPatch) => invoke<WebToolsStatus>("web_tools_update_settings", { patch }),
};
