// Settings > AI: turn the helper on or off, pick a provider, paste a key (it
// goes straight to the backend's secure store and is never shown again),
// pick a model, and test the connection.

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, PlugZap, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "../components/Dialog";
import { Choice, Heading, Row, Toggle } from "../components/settingsControls";
import { aiApi, type AiKeyStatus, type AiModel, type AiProviderId, type AiProviderInfo, type AiSettings } from "../lib/api";
import { toast } from "../ui";
import { badBaseUrl, FALLBACK_PROVIDERS, loadProviders, useAiSettings } from "./aiPrefs";
import { toAiError } from "./fixModel";
import { AgentsSettings } from "./settings/AgentsSettings";
import { MemorySettings } from "./settings/MemorySettings";
import { WebSettings } from "./settings/WebSettings";

const INPUT = "h-8 w-full rounded-lg border border-border bg-bg px-2.5 text-sm outline-none focus:border-accent";

/** The AI section's pages (the last one shown is remembered for this computer). */
type AiPage = "provider" | "agents" | "web" | "memory";
const PAGE_KEY = "texo.aiSettingsPage";
function loadPage(): AiPage {
  try {
    const v = localStorage.getItem(PAGE_KEY);
    return v === "agents" || v === "web" || v === "memory" ? v : "provider";
  } catch {
    return "provider";
  }
}
function savePage(p: AiPage) {
  try {
    localStorage.setItem(PAGE_KEY, p);
  } catch {
    // Remembered for this session only.
  }
}

/** Saves a settings change, telling the user when the backend refuses it. */
async function update(patch: Parameters<ReturnType<typeof useAiSettings.getState>["update"]>[0]) {
  try {
    await useAiSettings.getState().update(patch);
    return true;
  } catch (err) {
    toast(toAiError(err).message, "error");
    return false;
  }
}

export function AiSettingsSection() {
  const settings = useAiSettings((s) => s.settings);
  const [providers, setProviders] = useState<AiProviderInfo[]>(FALLBACK_PROVIDERS);

  const refreshProviders = useCallback(async () => setProviders(await loadProviders()), []);
  useEffect(() => {
    void useAiSettings.getState().load();
    void refreshProviders();
  }, [refreshProviders]);

  const provider = providers.find((p) => p.id === settings.provider) ?? providers[0];
  const [page, setPage] = useState<AiPage>(loadPage);
  const choosePage = (p: AiPage) => {
    setPage(p);
    savePage(p);
  };

  return (
    <>
      <Heading>AI helper</Heading>
      <Row
        label="Use the AI helper"
        help="Explain & fix, the AI chat and the agents. Nothing is sent until you press Explain & fix, send a chat message or start an agent, and you review every change before it is written."
      >
        <Toggle label="Use the AI helper" checked={settings.enabled} onChange={(enabled) => void update({ enabled })} />
      </Row>
      {settings.enabled && (
        <div className="mt-1 mb-2">
          <Choice<AiPage>
            label="AI settings page"
            value={page}
            options={[
              ["provider", "Provider"],
              ["agents", "Agents"],
              ["web", "Web"],
              ["memory", "Memory"],
            ]}
            onChange={choosePage}
          />
        </div>
      )}
      {settings.enabled && page === "agents" && <AgentsSettings key={`agents-${provider.id}`} provider={provider} />}
      {settings.enabled && page === "web" && <WebSettings />}
      {settings.enabled && page === "memory" && <MemorySettings />}
      {settings.enabled && page !== "provider" && <Privacy settings={settings} />}
      {settings.enabled && page === "provider" && (
        <>
          <Row label="Provider" help="The service that answers. You bring your own key; NVIDIA's is free.">
            <select
              aria-label="Provider"
              value={provider.id}
              onChange={(e) => void update({ provider: e.target.value as AiProviderId }).then(refreshProviders)}
              className="h-8 rounded-lg border border-border bg-bg px-2 text-sm"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.key.hasKey ? " (key saved)" : ""}
                </option>
              ))}
            </select>
          </Row>
          {provider.id === "custom" && <CustomServer key="custom" settings={settings} onSaved={() => void refreshProviders()} />}
          <KeyField key={`key-${provider.id}`} provider={provider} onChanged={() => void refreshProviders()} />
          <ModelField key={`model-${provider.id}`} provider={provider} settings={settings} />
          <TestConnection key={`test-${provider.id}`} provider={provider} />
          <Privacy settings={settings} />
        </>
      )}
    </>
  );
}

function CustomServer({ settings, onSaved }: { settings: AiSettings; onSaved: () => void }) {
  const [url, setUrl] = useState(settings.customBaseUrl ?? "");
  const problem = url.trim() ? badBaseUrl(url) : null;
  const save = async () => {
    const next = url.trim();
    if ((next && badBaseUrl(next)) || next === (settings.customBaseUrl ?? "")) return;
    if (await update({ customBaseUrl: next })) onSaved();
  };
  return (
    <div className="py-2">
      <label className="mb-1 block text-sm" htmlFor="ai-base-url">
        Server address
      </label>
      <p className="mb-1.5 text-xs text-muted">
        Any server that speaks the OpenAI chat API. For Ollama on this computer use http://localhost:11434/v1; for LM Studio,
        http://localhost:1234/v1. A local server needs no key, and nothing leaves your computer. Other servers must use https://.
      </p>
      <input
        id="ai-base-url"
        className={INPUT}
        value={url}
        spellCheck={false}
        placeholder="http://localhost:11434/v1"
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => e.key === "Enter" && void save()}
      />
      {problem && <p className="mt-1 text-xs text-amber-400">{problem}</p>}
    </div>
  );
}

/** The key field. A saved key is never read back; the field only replaces or removes it. */
function KeyField({ provider, onChanged }: { provider: AiProviderInfo; onChanged: () => void }) {
  const [status, setStatus] = useState<AiKeyStatus>(provider.key);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => setStatus(provider.key), [provider.key]);
  useEffect(() => {
    let live = true;
    aiApi.keyStatus(provider.id).then(
      (s) => live && setStatus(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [provider.id]);

  const save = async () => {
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    try {
      setStatus(await aiApi.setKey(provider.id, key));
      setReplacing(false);
      toast(`${provider.label} key saved.`);
      onChanged();
    } catch (err) {
      toast(toAiError(err).message, "error");
    } finally {
      // Drop the key from the page either way.
      setValue("");
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      setStatus(await aiApi.clearKey(provider.id));
      setConfirmRemove(false);
      toast(`${provider.label} key removed.`);
      onChanged();
    } catch (err) {
      toast(toAiError(err).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const optional = !provider.keyRequired;

  return (
    <div className="py-2">
      <div className="mb-1 flex items-center gap-1.5 text-sm">
        <KeyRound size={14} className="text-muted" /> API key{optional ? " (optional)" : ""}
      </div>
      {!status.hasKey && provider.id === "nvidia" && (
        <div className="mb-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs">
          <p className="font-medium">Get a free NVIDIA key</p>
          <ol className="mt-1 list-decimal pl-4 text-muted">
            <li>Go to build.nvidia.com and sign in (or create a free account).</li>
            <li>Open “API Keys” and generate a key. It starts with “nvapi-”.</li>
            <li>Copy it and paste it below.</li>
          </ol>
        </div>
      )}
      {!status.hasKey && provider.id !== "nvidia" && provider.id !== "custom" && provider.howTo && <p className="mb-2 text-xs text-muted">{provider.howTo}</p>}
      {status.hasKey && !replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <CheckCircle2 size={14} className="text-emerald-400" /> A key is saved.
          </span>
          <span className="ml-auto" />
          {confirmRemove ? (
            <>
              <span className="text-xs">Remove the saved key?</span>
              <Button onClick={() => setConfirmRemove(false)}>Cancel</Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                Remove
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setReplacing(true)}>Replace…</Button>
              <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
                <Trash2 size={13} /> Remove
              </Button>
            </>
          )}
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            type="password"
            aria-label={`${provider.label} API key`}
            placeholder={optional ? "Only if your server needs one" : "Paste your key here"}
            autoComplete="off"
            spellCheck={false}
            className={INPUT}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={busy || !value.trim()}>
            Save
          </Button>
          {replacing && (
            <Button
              onClick={() => {
                setReplacing(false);
                setValue("");
              }}
            >
              Cancel
            </Button>
          )}
        </form>
      )}
      {status.hasKey && status.storage === "file" ? (
        <p className="mt-1 flex gap-1.5 text-xs text-amber-400">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          {status.warning ??
            "This computer has no password store Texo can use, so the key is saved in a file only your user account can read. That is less secure."}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted">
          {status.hasKey
            ? "Kept in your system's secure password store."
            : "Texo keeps the key in your system's secure password store and never shows it again."}
        </p>
      )}
      {provider.keyUrl && (
        <button
          type="button"
          className="mt-1.5 inline-flex items-center gap-1 text-xs text-accent hover:underline"
          onClick={() => void openUrl(provider.keyUrl!)}
        >
          <ExternalLink size={12} /> Get your {provider.label} key
        </button>
      )}
    </div>
  );
}

function ModelField({ provider, settings }: { provider: AiProviderInfo; settings: AiSettings }) {
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = settings.models[provider.id] ?? "";
  const [typed, setTyped] = useState(chosen);
  useEffect(() => setTyped(chosen), [chosen]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setModels(await aiApi.listModels(provider.id));
    } catch (err) {
      setModels(null);
      setError(toAiError(err).message);
    } finally {
      setLoading(false);
    }
  }, [provider.id]);

  // Listing models needs a key (except for a custom server); don't ask without one.
  const canList = provider.key.hasKey || !provider.keyRequired;
  useEffect(() => {
    if (canList) void load();
  }, [load, canList]);

  const choose = (id: string) => {
    const model = id.trim() || null;
    if (model === (settings.models[provider.id] ?? null)) return;
    void update({ model: { provider: provider.id, model } });
  };

  const recommended = models?.find((m) => m.recommended);
  return (
    <div className="py-2">
      <div className="mb-1 flex items-center justify-between text-sm">
        <label htmlFor="ai-model">Model</label>
        <Button variant="ghost" onClick={() => void load()} disabled={loading || !canList}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh list
        </Button>
      </div>
      {models && models.length > 0 ? (
        <select id="ai-model" className={INPUT} value={chosen} onChange={(e) => choose(e.target.value)}>
          <option value="">Let Texo choose{recommended ? ` (${recommended.label || recommended.id})` : ""}</option>
          {chosen && !models.some((m) => m.id === chosen) && <option value={chosen}>{chosen} (not in the list)</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id}
              {m.free ? " · free" : ""}
              {m.recommended ? " · suggested" : ""}
            </option>
          ))}
        </select>
      ) : (
        <input
          id="ai-model"
          className={INPUT}
          spellCheck={false}
          placeholder={provider.model ?? "Leave empty to let Texo choose"}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => choose(typed)}
          onKeyDown={(e) => e.key === "Enter" && choose(typed)}
        />
      )}
      <p className="mt-1 text-xs text-muted">
        {!canList
          ? "Save a key to see this provider's models."
          : error
            ? `Couldn't load the list of models: ${error} You can type a model name instead.`
            : loading
              ? "Loading the provider's models…"
              : "If you're unsure, let Texo choose."}
      </p>
    </div>
  );
}

function TestConnection({ provider }: { provider: AiProviderInfo }) {
  const [state, setState] = useState<{ kind: "idle" | "running" | "ok" | "fail"; text?: string }>({ kind: "idle" });
  const test = async () => {
    setState({ kind: "running" });
    try {
      const result = await aiApi.testConnection(provider.id);
      setState({ kind: result.ok ? "ok" : "fail", text: result.message });
    } catch (err) {
      setState({ kind: "fail", text: toAiError(err).message });
    }
  };
  return (
    <Row label="Test connection" help="Checks the key and the address. Sends nothing from your project.">
      <div className="flex max-w-64 flex-col items-end gap-1">
        <Button onClick={() => void test()} disabled={state.kind === "running"}>
          {state.kind === "running" ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />} Test
        </Button>
        {state.text && (
          <span role="status" className={`text-right text-xs ${state.kind === "ok" ? "text-emerald-400" : "text-amber-400"}`}>
            {state.text}
          </span>
        )}
      </div>
    </Row>
  );
}

function Privacy({ settings }: { settings: AiSettings }) {
  return (
    <div className="mt-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">
      <p className="mb-1 font-medium text-text">What gets sent, and to whom</p>
      <p className="mb-1.5">Nothing is sent until you start something yourself. Then:</p>
      <ul className="mb-1.5 list-disc space-y-1 pl-4">
        <li>
          <span className="text-text">“Explain &amp; fix”</span> sends your AI provider the error messages, a short part of the compile log, the lines
          around each error, the start of your main file, files the error names and the bibliography entries it mentions.
        </li>
        <li>
          <span className="text-text">Agents and chat</span> (fixer, reviewer, response to reviewers, task agent) send your AI provider your
          request, the files and pictures you attach, the project memory, and the parts of project files (including unsaved editor text) the
          agent decides to read while it works. An agent can read any file in the project folder, but nothing outside it. Every step is listed in the run.
        </li>
        <li>
          <span className="text-text">Paper and citation lookups</span> send only search words, titles, DOIs or arXiv ids to arXiv, Crossref,
          Semantic Scholar and doi.org (and OpenAlex when you add its key). Never your files.
        </li>
        <li>
          <span className="text-text">Web search and web pages</span>: search words go to the search service you set up under Web (Tavily, Brave
          or your SearXNG server). Pages an agent opens are fetched from their own sites. Private and local network addresses are never fetched.
        </li>
      </ul>
      <p>
        Keys stay in your system's password store and are only sent to their own service. Changes from agents are kept in the project history
        and, unless you turned on “Apply changes automatically”, wait for your review. Each service handles what it receives under its own
        privacy terms.
      </p>
      {settings.noticeAccepted.length > 0 && (
        <button type="button" className="mt-1 text-accent hover:underline" onClick={() => void update({ resetNotices: true })}>
          Show the privacy notice again before the next request
        </button>
      )}
    </div>
  );
}
