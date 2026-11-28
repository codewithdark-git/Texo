// Settings > AI > Agents: the agent profiles (built-in ones you can change
// and reset, your own ones you can add, duplicate and delete) and the
// defaults: which model each role uses with its fallbacks, and how many runs
// work at the same time.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, Copy, Loader2, Plus, RefreshCw, RotateCcw, Save, Trash2, X } from "lucide-react";
import { Button } from "../../components/Dialog";
import { Choice, Heading, Row, Toggle } from "../../components/settingsControls";
import { aiApi, errorText, type AiModel, type AiProviderInfo } from "../../lib/api";
import {
  duplicateProfile,
  newProfile,
  profilesApi,
  type AgentDefaults,
  type AgentKindId,
  type AgentProfile,
  type ProfileScope,
  type ProfilesView,
  type RoleModels,
} from "../../lib/agentsApi";
import { agentUiApi } from "../../lib/agentUiApi";
import { toast } from "../../ui";
import { useWorkspace } from "../../workspace/store";
import {
  addFallback,
  checkedTools,
  defaultScope,
  defaultSteps,
  kindLabel,
  KIND_LABELS,
  MAX_INSTRUCTIONS_CHARS,
  modelChoices,
  moveUp,
  profileChanged,
  profileProblems,
  removeAt,
  roleOf,
  ROLE_LABELS,
  ROLES,
  sourceLabel,
  toggleTool,
  toolLabel,
  withRole,
  type Role,
} from "./agentSettingsLogic";
import { InlineConfirm } from "./InlineConfirm";

const INPUT = "h-8 w-full rounded-lg border border-border bg-bg px-2.5 text-sm outline-none focus:border-accent";
const SELECT = "h-8 w-full rounded-lg border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

/** The provider's live model list (null: not loaded or can't be listed). */
function useLiveModels(provider: AiProviderInfo) {
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canList = provider.key.hasKey || !provider.keyRequired;
  const load = useCallback(async () => {
    if (!canList) return;
    setLoading(true);
    setError(null);
    try {
      setModels(await aiApi.listModels(provider.id));
    } catch (err) {
      setModels(null);
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [provider.id, canList]);
  useEffect(() => {
    void load();
  }, [load]);
  return { models, loading, error, canList, reload: load };
}

export function AgentsSettings({ provider }: { provider: AiProviderInfo }) {
  const project = useWorkspace((s) => s.project?.path ?? null);
  const [view, setView] = useState<ProfilesView | null>(null);
  const [kindTools, setKindTools] = useState<Record<string, string[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<AgentProfile | null>(null);
  const live = useLiveModels(provider);

  useEffect(() => {
    let alive = true;
    Promise.all([profilesApi.list(project), agentUiApi.kindTools()]).then(
      ([v, tools]) => {
        if (!alive) return;
        setView(v);
        setKindTools(tools);
      },
      (err) => alive && setLoadError(errorText(err)),
    );
    return () => {
      alive = false;
    };
  }, [project]);

  if (loadError) return <p className="py-2 text-sm text-muted">The agent settings couldn't be loaded: {loadError}</p>;
  if (!view)
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" /> Loading the agents…
      </p>
    );

  const editing = creating ?? view.profiles.find((p) => p.id === selected) ?? null;

  return (
    <>
      {view.warnings.length > 0 && (
        <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          {view.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

      <Heading>Profiles</Heading>
      <p className="mb-2 text-xs text-muted">
        A profile is an agent set up your way: its instructions, model and tools. Built-in profiles can be changed and reset. Your own profiles
        show in the AI Chat bar (+, then Agents, or type /) and in the Agents tab's New task menu.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {view.profiles.map((p) => (
          <li key={`${p.source}-${p.id}`}>
            <button
              type="button"
              aria-current={editing && !creating && editing.id === p.id ? "true" : undefined}
              onClick={() => {
                setCreating(null);
                setSelected(selected === p.id && !creating ? null : p.id);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2/60 ${
                editing && !creating && editing.id === p.id ? "bg-surface-2" : ""
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="shrink-0 text-xs text-muted">{kindLabel(p.kind)}</span>
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted">{sourceLabel(p)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2">
        <NewProfileButton
          onCreate={(kind) => {
            setSelected(null);
            setCreating(newProfile(kind));
          }}
        />
      </div>

      {editing && (
        <ProfileEditor
          key={creating ? "new" : `${editing.source}-${editing.id}`}
          profile={editing}
          isNew={!!creating}
          project={project}
          tools={kindTools[editing.kind] ?? []}
          live={live}
          onView={(v, focusId) => {
            setView(v);
            setCreating(null);
            setSelected(focusId);
          }}
          onDuplicate={(p) => {
            setSelected(null);
            setCreating(duplicateProfile(p));
          }}
          onClose={() => {
            setCreating(null);
            setSelected(null);
          }}
        />
      )}

      <div className="mt-5">
        <DefaultsEditor provider={provider} defaults={view.defaults} project={project} live={live} onView={setView} />
      </div>
    </>
  );
}

function NewProfileButton({ onCreate }: { onCreate: (kind: AgentKindId) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <Button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <Plus size={13} /> New profile
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onMouseDown={() => setOpen(false)} />
          <div role="menu" className="absolute left-0 z-20 mt-1 w-56 rounded-lg border border-border bg-surface p-1 shadow-xl">
            {Object.entries(KIND_LABELS).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                className="w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
                onClick={() => {
                  setOpen(false);
                  onCreate(kind);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type Live = ReturnType<typeof useLiveModels>;

function ProfileEditor({
  profile,
  isNew,
  project,
  tools,
  live,
  onView,
  onDuplicate,
  onClose,
}: {
  profile: AgentProfile;
  isNew: boolean;
  project: string | null;
  tools: string[];
  live: Live;
  onView: (v: ProfilesView, focusId: string | null) => void;
  onDuplicate: (p: AgentProfile) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AgentProfile>(profile);
  const [scope, setScope] = useState<ProfileScope>(defaultScope(profile, !!project));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "reset" | null>(null);
  const problems = useMemo(() => profileProblems(draft), [draft]);
  const changed = isNew || profileChanged(draft, profile);
  const builtin = profile.source === "builtin" || profile.overridesBuiltin;
  const patch = (p: Partial<AgentProfile>) => setDraft((d) => ({ ...d, ...p }));
  const on = checkedTools(tools, draft.tools);

  const save = async () => {
    if (problems.length || busy) return;
    setBusy(true);
    try {
      const before = new Set((await profilesApi.list(project)).profiles.map((p) => p.id));
      const v = await profilesApi.save(scope, draft, project);
      const id = isNew ? (v.profiles.find((p) => !before.has(p.id))?.id ?? null) : draft.id;
      toast(`Saved “${draft.name.trim()}”.`, "success");
      onView(v, id);
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirm(null);
    setBusy(true);
    try {
      const v =
        confirm === "reset"
          ? await profilesApi.reset(profile.id, project)
          : await profilesApi.remove(profile.source === "project" ? "project" : "global", profile.id, project);
      toast(confirm === "reset" ? `“${profile.name}” is back to Texo's default.` : `Deleted “${profile.name}”.`, "success");
      onView(v, confirm === "reset" ? profile.id : null);
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const modelList = modelChoices(live.models, [draft.model, ...draft.fallbackModels]);
  const instructionsLeft = MAX_INSTRUCTIONS_CHARS - [...draft.instructions].length;

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-bg p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{isNew ? `New ${kindLabel(draft.kind).toLowerCase()} profile` : profile.name}</span>
        <span className="text-xs text-muted">{kindLabel(draft.kind)}</span>
        <span className="flex-1" />
        <button type="button" aria-label="Close the editor" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <label className="block text-xs text-muted">
        Name
        <input className={`${INPUT} mt-1 text-text`} maxLength={80} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <label className="block text-xs text-muted">
        One line for the New task menu (optional)
        <input className={`${INPUT} mt-1 text-text`} maxLength={200} value={draft.description} onChange={(e) => patch({ description: e.target.value })} />
      </label>
      <label className="block text-xs text-muted">
        Instructions
        <textarea
          className="mt-1 w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
          rows={5}
          value={draft.instructions}
          placeholder="Added to the agent's own instructions, e.g. “Use British spelling.” or “Never change the abstract.”"
          onChange={(e) => patch({ instructions: e.target.value })}
        />
        <span className={`mt-0.5 block text-right text-[11px] ${instructionsLeft < 0 ? "text-amber-400" : ""}`}>{instructionsLeft} characters left</span>
      </label>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted">
          <span>Model</span>
          <Button variant="ghost" onClick={() => void live.reload()} disabled={live.loading || !live.canList}>
            <RefreshCw size={12} className={live.loading ? "animate-spin" : ""} /> Refresh list
          </Button>
        </div>
        <ModelSelect
          label="Profile model"
          value={draft.model ?? ""}
          choices={modelList}
          emptyLabel="Use the default for this kind (below)"
          onChange={(model) => patch({ model: model || null })}
        />
        <FallbackList
          fallbacks={draft.fallbackModels}
          main={draft.model}
          choices={modelList}
          onChange={(fallbackModels) => patch({ fallbackModels })}
        />
        <LiveNote live={live} />
      </div>

      {tools.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted">Tools this agent may use{draft.tools.length === 0 ? " (all)" : ""}</div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            {tools.map((t) => {
              const { label, help } = toolLabel(t);
              return (
                <label key={t} className="flex items-start gap-2 text-sm" title={help}>
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={on.has(t)}
                    disabled={on.has(t) && on.size <= 1}
                    onChange={() => patch({ tools: toggleTool(tools, draft.tools, t) })}
                  />
                  <span>
                    {label}
                    {help && <span className="block text-[11px] text-muted">{help}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          Steps at most
          <input
            type="number"
            min={1}
            max={200}
            aria-label="Steps at most"
            className="h-8 w-20 rounded-lg border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
            placeholder={String(defaultSteps(draft.kind))}
            value={draft.maxSteps ?? ""}
            onChange={(e) => {
              const v = e.target.value.trim();
              patch({ maxSteps: v === "" ? null : Number(v) });
            }}
          />
        </label>
        <span className="flex items-center gap-2 text-sm">
          Apply changes automatically
          <Toggle label="Apply changes automatically" checked={draft.autoApply} onChange={(autoApply) => patch({ autoApply })} />
        </span>
      </div>
      <p className="-mt-1 text-xs text-muted">
        {draft.autoApply
          ? "Changes are written when the run finishes, except anything flagged for your attention. Your history can undo them."
          : "You review every change before it is written."}
      </p>

      {draft.kind === "reviewer" && (
        <p className="text-xs text-muted">
          To change the venue, reviewers and strictness, open Review paper… from the Agents tab or type /review in the AI Chat bar, adjust the setup and save it as a profile.
        </p>
      )}

      {problems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-400">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {project && (
          <Choice<ProfileScope>
            label="Where to save"
            value={scope}
            options={[
              ["global", "All projects"],
              ["project", "This project"],
            ]}
            onChange={setScope}
          />
        )}
        <span className="flex-1" />
        {!isNew && (
          <Button variant="ghost" onClick={() => onDuplicate(draft)}>
            <Copy size={13} /> Duplicate
          </Button>
        )}
        {!isNew && profile.overridesBuiltin && (
          <Button variant="ghost" onClick={() => setConfirm("reset")} disabled={busy}>
            <RotateCcw size={13} /> Reset
          </Button>
        )}
        {!isNew && !builtin && (
          <Button variant="ghost" onClick={() => setConfirm("delete")} disabled={busy}>
            <Trash2 size={13} /> Delete
          </Button>
        )}
        <Button variant="primary" onClick={() => void save()} disabled={busy || !changed || problems.length > 0}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
        </Button>
      </div>

      {confirm && (
        <InlineConfirm
          message={
            confirm === "reset"
              ? `Reset “${profile.name}”? Your changes to this built-in profile are removed, for all projects and this one, and Texo's own setup comes back.`
              : `Delete “${profile.name}”? The profile is removed. Runs that already used it keep their history.`
          }
          confirmLabel={confirm === "reset" ? "Reset" : "Delete"}
          danger={confirm === "delete"}
          onConfirm={() => void remove()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function ModelSelect({
  label,
  value,
  choices,
  emptyLabel,
  onChange,
}: {
  label: string;
  value: string;
  choices: { id: string; label: string }[];
  emptyLabel: string;
  onChange: (id: string) => void;
}) {
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  if (!choices.length) {
    return (
      <input
        aria-label={label}
        className={INPUT}
        spellCheck={false}
        placeholder={emptyLabel}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={() => typed.trim() !== value && onChange(typed.trim())}
        onKeyDown={(e) => e.key === "Enter" && typed.trim() !== value && onChange(typed.trim())}
      />
    );
  }
  return (
    <select aria-label={label} className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {choices.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

/** Fallback models in the order they're tried, with add / remove / move up. */
function FallbackList({
  fallbacks,
  main,
  choices,
  onChange,
}: {
  fallbacks: string[];
  main: string | null;
  choices: { id: string; label: string }[];
  onChange: (next: string[]) => void;
}) {
  const [typed, setTyped] = useState("");
  const add = (id: string) => {
    const next = addFallback(fallbacks, id, main);
    if (next !== fallbacks) onChange(next);
    setTyped("");
  };
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-muted">If it is busy or fails, try these in order</div>
      {fallbacks.length > 0 && (
        <ol className="mb-1.5 space-y-1">
          {fallbacks.map((m, i) => (
            <li key={m} className="flex items-center gap-1.5 rounded-md bg-surface-2/60 px-2 py-0.5 text-xs">
              <span className="text-muted">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate font-mono">{m}</span>
              <button type="button" aria-label={`Try ${m} earlier`} disabled={i === 0} className="rounded p-0.5 text-muted hover:text-text disabled:opacity-30" onClick={() => onChange(moveUp(fallbacks, i))}>
                <ArrowUp size={12} />
              </button>
              <button type="button" aria-label={`Remove ${m}`} className="rounded p-0.5 text-muted hover:text-text" onClick={() => onChange(removeAt(fallbacks, i))}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ol>
      )}
      {fallbacks.length < 8 &&
        (choices.length ? (
          <select aria-label="Add a fallback model" className={SELECT} value="" onChange={(e) => e.target.value && add(e.target.value)}>
            <option value="">Add a fallback model…</option>
            {choices
              .filter((c) => c.id !== main && !fallbacks.includes(c.id))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
          </select>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add(typed);
            }}
          >
            <input aria-label="Fallback model name" className={INPUT} spellCheck={false} placeholder="Model name" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button type="submit" disabled={!typed.trim()}>
              Add
            </Button>
          </form>
        ))}
    </div>
  );
}

function LiveNote({ live }: { live: Live }) {
  if (!live.canList) return <p className="mt-1 text-xs text-muted">Save a key under Provider to pick from the provider's models.</p>;
  if (live.error) return <p className="mt-1 text-xs text-amber-400">Couldn't load the list of models: {live.error} You can type model names instead.</p>;
  if (live.loading) return <p className="mt-1 text-xs text-muted">Loading the provider's models…</p>;
  return null;
}

/** Model per role for the current provider, and how many runs work at once. */
function DefaultsEditor({
  provider,
  defaults,
  project,
  live,
  onView,
}: {
  provider: AiProviderInfo;
  defaults: AgentDefaults;
  project: string | null;
  live: Live;
  onView: (v: ProfilesView) => void;
}) {
  const [draft, setDraft] = useState<AgentDefaults>(defaults);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(defaults), [defaults]);
  const changed = JSON.stringify(draft) !== JSON.stringify(defaults);

  const save = async () => {
    setBusy(true);
    try {
      onView(await profilesApi.saveDefaults(draft, project));
      toast("Agent defaults saved.", "success");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const setRole = (role: Role, next: RoleModels) => setDraft((d) => withRole(d, provider.id, role, next));

  return (
    <>
      <Heading>Default models for {provider.label}</Heading>
      <p className="mb-2 text-xs text-muted">
        Used by every profile that doesn't pick its own model. Leave a role empty to use {provider.label}'s model chosen under Provider.
      </p>
      <div className="space-y-3">
        {ROLES.map((role) => {
          const r = roleOf(draft, provider.id, role);
          const choices = modelChoices(live.models, [r.model, ...r.fallbacks]);
          return (
            <div key={role} className="rounded-lg border border-border p-2.5">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-sm">{ROLE_LABELS[role].label}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{ROLE_LABELS[role].help}</span>
                {role !== "vision" && (
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted" title="Let the model think before it answers: better results, slower.">
                    <input type="checkbox" checked={r.thinking ?? false} onChange={(e) => setRole(role, { ...r, thinking: e.target.checked })} /> Think first
                  </label>
                )}
              </div>
              <ModelSelect
                label={`${ROLE_LABELS[role].label} model`}
                value={r.model}
                choices={choices}
                emptyLabel="The model chosen under Provider"
                onChange={(model) => setRole(role, { ...r, model })}
              />
              {r.model && <FallbackList fallbacks={r.fallbacks} main={r.model} choices={choices} onChange={(fallbacks) => setRole(role, { ...r, fallbacks })} />}
            </div>
          );
        })}
      </div>
      <LiveNote live={live} />

      <Row label="Agents working at the same time" help="More runs wait in a queue and start in order.">
        <Choice
          label="Agents working at the same time"
          value={String(draft.maxParallel)}
          options={[1, 2, 3, 4, 5].map((n) => [String(n), String(n)] as [string, string])}
          onChange={(v) => setDraft((d) => ({ ...d, maxParallel: Number(v) }))}
        />
      </Row>
      {draft.maxParallel !== 3 && <p className="-mt-1 mb-1 text-xs text-amber-400">This version of Texo still runs up to 3 agents at once; your choice is saved for later.</p>}

      <div className="mt-2 flex justify-end gap-2">
        <Button onClick={() => setDraft(defaults)} disabled={!changed || busy}>
          Undo changes
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={!changed || busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save defaults
        </Button>
      </div>
    </>
  );
}
