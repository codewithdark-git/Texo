// Settings > AI > Web: optional keys for OpenAlex (paper search) and Tavily
// or Brave (web search), a SearXNG address, which search to use, and an
// optional contact e-mail for Crossref. Keys go straight to the system's
// password store in Rust; this page only learns whether one is saved.

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, ExternalLink, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "../../components/Dialog";
import { Heading } from "../../components/settingsControls";
import { errorText } from "../../lib/api";
import {
  SEARCH_LABELS,
  SERVICE_KEY_URLS,
  SERVICE_LABELS,
  webToolsApi,
  webToolsSummary,
  type SearchProvider,
  type SecretStatus,
  type ServiceSecret,
  type WebToolsStatus,
} from "../../lib/webToolsApi";
import { toast } from "../../ui";
import { searxngProblem } from "./agentSettingsLogic";

const INPUT = "h-8 w-full rounded-lg border border-border bg-bg px-2.5 text-sm outline-none focus:border-accent";

const KEY_HELP: Record<ServiceSecret, string> = {
  openalex: "Adds OpenAlex to the paper search. Free key; paper search works without it.",
  tavily: "Lets agents search the web. Free tier available.",
  brave: "Lets agents search the web. Free tier available.",
};

export function WebSettings() {
  const [status, setStatus] = useState<WebToolsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    webToolsApi.status().then(
      (s) => live && setStatus(s),
      (err) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, []);

  if (error) return <p className="py-2 text-sm text-muted">The web settings couldn't be loaded: {error}</p>;
  if (!status)
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </p>
    );

  const keyOf = (s: ServiceSecret) => status.keys.find((k) => k.secret === s) ?? { secret: s, hasKey: false, storage: null, warning: null };
  const configured: SearchProvider[] = [
    ...(keyOf("tavily").hasKey ? (["tavily"] as const) : []),
    ...(keyOf("brave").hasKey ? (["brave"] as const) : []),
    ...(status.settings.searxngUrl ? (["searxng"] as const) : []),
  ];

  return (
    <>
      <Heading>Web and literature</Heading>
      <p className="mb-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{webToolsSummary(status)}</p>

      <ServiceKey status={keyOf("openalex")} onStatus={setStatus} />
      <ServiceKey status={keyOf("tavily")} onStatus={setStatus} />
      <ServiceKey status={keyOf("brave")} onStatus={setStatus} />
      <TextSetting
        id="web-searxng"
        label="SearXNG address (optional)"
        help="Your own SearXNG search server, for web search without a key."
        placeholder="https://search.example.org"
        value={status.settings.searxngUrl ?? ""}
        problem={searxngProblem}
        onSave={async (searxngUrl) => setStatus(await webToolsApi.update({ searxngUrl }))}
      />

      {configured.length > 1 && (
        <div className="py-2">
          <label className="mb-1 block text-sm" htmlFor="web-search-provider">
            Web search uses
          </label>
          <select
            id="web-search-provider"
            className={INPUT}
            value={status.settings.searchProvider ?? "auto"}
            onChange={async (e) => {
              try {
                setStatus(await webToolsApi.update({ searchProvider: e.target.value as SearchProvider | "auto" }));
              } catch (err) {
                toast(errorText(err), "error");
              }
            }}
          >
            <option value="auto">Automatic (the first one set up)</option>
            {configured.map((p) => (
              <option key={p} value={p}>
                {SEARCH_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
      )}

      <TextSetting
        id="web-contact"
        label="Contact e-mail for Crossref (optional)"
        help="Crossref answers faster for requests that include a contact address. Only sent to Crossref."
        placeholder="you@example.org"
        value={status.settings.contactEmail ?? ""}
        problem={(v) => (v.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? "That doesn't look like an e-mail address." : null)}
        onSave={async (contactEmail) => setStatus(await webToolsApi.update({ contactEmail }))}
      />
    </>
  );
}

/** A key field: saves or removes, never shows a saved key. */
function ServiceKey({ status, onStatus }: { status: SecretStatus; onStatus: (s: WebToolsStatus) => void }) {
  const name = SERVICE_LABELS[status.secret];
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const save = async () => {
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    try {
      onStatus(await webToolsApi.setKey(status.secret, key));
      setReplacing(false);
      toast(`${name} key saved.`, "success");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setValue("");
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      onStatus(await webToolsApi.clearKey(status.secret));
      setConfirmRemove(false);
      toast(`${name} key removed.`, "success");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="py-2">
      <div className="mb-0.5 text-sm">{name} key (optional)</div>
      <p className="mb-1.5 text-xs text-muted">{KEY_HELP[status.secret]}</p>
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
            aria-label={`${name} key`}
            placeholder="Paste your key here"
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
      {status.hasKey && status.storage === "file" && (
        <p className="mt-1 flex gap-1.5 text-xs text-amber-400">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          {status.warning ?? "This computer has no password store Texo can use, so the key is saved in a file only your user account can read."}
        </p>
      )}
      <button
        type="button"
        className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline"
        onClick={() => void openUrl(SERVICE_KEY_URLS[status.secret])}
      >
        <ExternalLink size={12} /> Get your {name} key
      </button>
    </div>
  );
}

function TextSetting({
  id,
  label,
  help,
  placeholder,
  value,
  problem,
  onSave,
}: {
  id: string;
  label: string;
  help: string;
  placeholder: string;
  value: string;
  problem: (v: string) => string | null;
  onSave: (v: string) => Promise<void>;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const issue = problem(text);
  const save = async () => {
    const v = text.trim();
    if (issue || v === value) return;
    try {
      await onSave(v);
      toast(v ? "Saved." : "Removed.", "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  };
  return (
    <div className="py-2">
      <label className="mb-0.5 block text-sm" htmlFor={id}>
        {label}
      </label>
      <p className="mb-1.5 text-xs text-muted">{help}</p>
      <input
        id={id}
        className={INPUT}
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => e.key === "Enter" && void save()}
      />
      {issue && <p className="mt-1 text-xs text-amber-400">{issue}</p>}
    </div>
  );
}
