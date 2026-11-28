// Bindings for Settings > AI > Web (src-tauri/src/agents/tools/web_settings.rs):
// the optional OpenAlex / Semantic Scholar / Tavily / Brave keys, the SearXNG
// address, the web search choice, the optional Crossref contact e-mail and
// the paper sources the search may ask. Keys go into the OS
// credential store in Rust and never come back to the webview; the UI only
// sees whether one is set. Errors reject with the same `AiError` shape as the
// AI commands (`isAiError` in ./api).
import { invoke } from "@tauri-apps/api/core";

export type ServiceSecret = "openalex" | "semanticScholar" | "tavily" | "brave";
/** The paper sources, as the backend names them. */
export type PaperSource = "s2" | "crossref" | "arxiv" | "openalex";
/** Which paper sources the search may ask (all on by default). */
export type SourceSet = Record<PaperSource, boolean>;
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
  sources: SourceSet;
}

export interface WebToolsStatus {
  settings: WebSettings;
  /** One per secret: openalex, tavily, brave, semanticScholar. */
  keys: SecretStatus[];
  /** The search the agents use now, if any. */
  activeSearch: SearchProvider | null;
  /** Whether agents are offered the `web_search` tool. */
  webSearchAvailable: boolean;
  /** Whether OpenAlex joins the paper search (a key is saved and the source is on). */
  openalexEnabled: boolean;
  /** Whether a Semantic Scholar key is saved (never the key itself). */
  s2Key: boolean;
  /** The paper sources that are on. */
  sources: SourceSet;
}

/** Missing fields stay as they are; "" clears a text field; searchProvider "auto" goes back to automatic. */
export interface WebSettingsPatch {
  searchProvider?: SearchProvider | "auto";
  searxngUrl?: string;
  contactEmail?: string;
  /** Only the sources named change. */
  sources?: Partial<SourceSet>;
}

export const SERVICE_LABELS: Record<ServiceSecret, string> = {
  openalex: "OpenAlex",
  semanticScholar: "Semantic Scholar",
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
  semanticScholar: "https://www.semanticscholar.org/product/api#api-key-form",
  tavily: "https://app.tavily.com",
  brave: "https://api-dashboard.search.brave.com",
};

/** In the order the settings page lists them. */
export const PAPER_SOURCES: PaperSource[] = ["s2", "crossref", "arxiv", "openalex"];

export const SOURCE_LABELS: Record<PaperSource, string> = {
  s2: "Semantic Scholar",
  crossref: "Crossref",
  arxiv: "arXiv",
  openalex: "OpenAlex",
};

const ALL_ON: SourceSet = { s2: true, crossref: true, arxiv: true, openalex: true };

/** The sources the paper search asks now: switched on, and OpenAlex only with a key. */
export function activeSources(s: WebToolsStatus): PaperSource[] {
  const on = { ...ALL_ON, ...s.sources };
  return PAPER_SOURCES.filter((p) => on[p] && (p !== "openalex" || s.openalexEnabled));
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One plain sentence for the settings page. */
export function webToolsSummary(s: WebToolsStatus): string {
  const active = activeSources(s);
  // Listed in the order users know them from 1.2.
  const order: PaperSource[] = ["arxiv", "crossref", "s2", "openalex"];
  const names = order.filter((p) => active.includes(p)).map((p) => SOURCE_LABELS[p]);
  const papers =
    names.length === 0
      ? "Paper search is off: turn on at least one source."
      : `Paper search uses ${joinNames(names)}${active.includes("openalex") ? "" : " (no key needed)"}.`;
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
