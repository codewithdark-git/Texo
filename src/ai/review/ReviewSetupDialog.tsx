// "Review paper…": set up a reviewer run (venue, reviewers and their points
// of view, strictness, novelty search, automatic checks, focus), optionally
// save it as a profile, and start it in the background.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ListChecks, Loader2, Play, Save, Users } from "lucide-react";
import { Button, Modal } from "../../components/Dialog";
import { Choice, Toggle } from "../../components/settingsControls";
import { errorText } from "../../lib/api";
import { agentsApi, newProfile, profilesApi, type AgentProfile, type ProfileScope, type RunSummary } from "../../lib/agentsApi";
import { reviewApi, type Check, type ReviewSetup, type Strictness, type VenuePreset } from "../../lib/reviewApi";
import { toast } from "../../ui";
import { revealSource } from "../../workspace/EditorPane";
import { dirtyBuffers } from "../chat/composerActions";
import { useAiPanel } from "../panel/aiPanelStore";
import { ProfileModelPicker } from "../agents/NewTaskDialog";
import { ChecklistView } from "./ChecklistView";
import {
  cleanSetup,
  completeSetup,
  effectiveRules,
  findPreset,
  MAX_FOCUS_CHARS,
  MAX_REVIEWERS,
  reviewRequest,
  setupProblems,
  STRICTNESS_HELP,
  withPersona,
  withReviewers,
  withVenue,
  type ExportChoice,
} from "./reviewLogic";

const INPUT = "h-8 w-full rounded-lg border border-border bg-bg px-2.5 text-sm outline-none focus:border-accent";
const AREA = "w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent";

export interface ReviewSetupDialogProps {
  /** The open project's folder. */
  project: string;
  /** Start from this reviewer profile (default: the built-in "Reviewer (generic)"). */
  initialProfileId?: string | null;
  /** Words for the Focus field (e.g. typed in the AI Chat bar); the profile's own focus is kept when empty. */
  initialFocus?: string;
  onClose: () => void;
  /** Called after the run was started (the dialog closes itself). */
  onStarted?: (run: RunSummary) => void;
}

export function ReviewSetupDialog({ project, initialProfileId, initialFocus, onClose, onStarted }: ReviewSetupDialogProps) {
  const [presets, setPresets] = useState<VenuePreset[] | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profileId, setProfileId] = useState<string>(initialProfileId || "reviewer");
  const [setup, setSetup] = useState<ReviewSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exports, setExports] = useState<ExportChoice>({ md: false, tex: false });
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
  const [model, setModel] = useState("");

  useEffect(() => {
    let live = true;
    Promise.all([reviewApi.presets(), profilesApi.list(project)]).then(
      ([ps, view]) => {
        if (!live) return;
        const reviewers = view.profiles.filter((p) => p.kind === "reviewer");
        const start = reviewers.find((p) => p.id === (initialProfileId || "reviewer")) ?? reviewers[0];
        setPresets(ps);
        setProfiles(reviewers);
        setProfileId(start?.id ?? "");
        const base = completeSetup(start?.review, ps);
        const words = initialFocus?.trim();
        setSetup(words ? { ...base, focus: words } : base);
      },
      (err) => live && setLoadError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [project, initialProfileId, initialFocus]);

  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const preset = presets && setup ? findPreset(presets, setup.venue) : undefined;
  const problems = useMemo(() => (setup ? setupProblems(setup) : []), [setup]);

  const pickProfile = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    setProfileId(id);
    if (presets) setSetup(completeSetup(p?.review, presets));
    setChecks(null);
  };

  const change = (next: ReviewSetup) => {
    setSetup(next);
    setChecks(null);
  };

  const runChecks = async () => {
    if (!setup) return;
    setChecking(true);
    try {
      setChecks(await reviewApi.checklist(project, cleanSetup(setup)));
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setChecking(false);
    }
  };

  const start = async () => {
    if (!setup || problems.length || starting) return;
    setStarting(true);
    try {
      const run = await agentsApi.start(project, reviewRequest(setup, preset, { profile, exports, dirtyBuffers: dirtyBuffers(), model }));
      toast("The review started. It runs in the background; the report shows in the Agents tab.", "success");
      useAiPanel.getState().show("agents");
      onStarted?.(run);
      onClose();
    } catch (err) {
      toast(errorText(err), "error");
      setStarting(false);
    }
  };

  const updateProfile = async () => {
    if (!profile || !setup || profile.source === "builtin") return;
    try {
      const view = await profilesApi.save(profile.source, { ...profile, review: cleanSetup(setup) }, project);
      setProfiles(view.profiles.filter((p) => p.kind === "reviewer"));
      toast(`Saved the changes to “${profile.name}”.`, "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  if (loadError) {
    return (
      <Modal title="Review paper" onClose={onClose}>
        <p className="text-sm text-muted">The reviewer setup couldn't be loaded: {loadError}</p>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </Modal>
    );
  }
  if (!presets || !setup) {
    return (
      <Modal title="Review paper" onClose={onClose}>
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading the venues…
        </p>
      </Modal>
    );
  }

  const rules = effectiveRules(setup, preset);

  return (
    <Modal title="Review paper" onClose={onClose} wide>
      <p className="-mt-2 mb-3 text-xs text-muted">
        AI reviewers read your paper and write reviews like a venue's reviewers would, each pointing to the file and line. An area chair then
        sums them up. Nothing in your paper changes.
      </p>

      <div className="space-y-4">
        {profiles.length > 0 && (
          <div>
            <ProfileModelPicker profiles={profiles} profileId={profileId} onProfile={pickProfile} model={model} onModel={setModel} />
            {profile?.description && <p className="mt-1 text-xs text-muted">{profile.description}</p>}
          </div>
        )}

        <Field label="Venue" htmlFor="review-venue">
          <select
            id="review-venue"
            className={INPUT}
            value={setup.venue}
            onChange={(e) => {
              const p = findPreset(presets, e.target.value);
              if (p) change(withVenue(setup, p));
            }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {preset && (
            <p className="mt-1 text-xs text-muted">
              {[
                preset.pageLimit ? `${preset.pageLimit} pages` : null,
                preset.anonymous ? "anonymous review" : null,
                preset.rubric.scores.length ? `scores: ${preset.rubric.scores.map((s) => s.name).join(", ")}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {preset.pageLimitNote ? ` (${preset.pageLimitNote})` : ""}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <label className="flex items-center gap-2">
              Page limit
              <input
                type="number"
                min={1}
                max={999}
                aria-label="Page limit"
                className="h-7 w-16 rounded-md border border-border bg-bg px-2 text-xs outline-none focus:border-accent"
                placeholder={preset?.pageLimit ? String(preset.pageLimit) : "none"}
                value={setup.pageLimit ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  change({ ...setup, pageLimit: v === "" ? null : Number(v) });
                }}
              />
            </label>
            <span className="flex items-center gap-2">
              Anonymous review
              <Toggle label="Anonymous review" checked={rules.anonymous} onChange={(anonymous) => change({ ...setup, anonymous })} />
            </span>
          </div>
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-sm">
              <Users size={14} className="text-muted" /> Reviewers
            </span>
            <Choice
              label="Number of reviewers"
              value={String(setup.reviewers)}
              options={Array.from({ length: MAX_REVIEWERS }, (_, i) => [String(i + 1), String(i + 1)] as [string, string])}
              onChange={(v) => change(withReviewers(setup, Number(v)))}
            />
          </div>
          <p className="mb-2 text-xs text-muted">Each reviewer looks at the paper from its own point of view. Change the names and what they look at as you like.</p>
          <ul className="space-y-2">
            {setup.personas.map((p, i) => (
              <li key={i} className="rounded-lg border border-border p-2">
                <input
                  aria-label={`Reviewer ${i + 1} name`}
                  className={`${INPUT} mb-1.5 font-medium`}
                  value={p.name}
                  maxLength={60}
                  placeholder={`Reviewer ${i + 1}`}
                  onChange={(e) => change(withPersona(setup, i, { name: e.target.value }))}
                />
                <textarea
                  aria-label={`What reviewer ${i + 1} looks at`}
                  className={AREA}
                  rows={2}
                  value={p.focus}
                  maxLength={600}
                  placeholder="What this reviewer looks at"
                  onChange={(e) => change(withPersona(setup, i, { focus: e.target.value }))}
                />
              </li>
            ))}
          </ul>
        </div>

        <Field label="Strictness" help={STRICTNESS_HELP[setup.strictness]}>
          <Choice<Strictness>
            label="Strictness"
            value={setup.strictness}
            options={[
              ["lenient", "Lenient"],
              ["balanced", "Balanced"],
              ["harsh", "Harsh"],
            ]}
            onChange={(strictness) => change({ ...setup, strictness })}
          />
        </Field>

        <ToggleRow
          label="Check novelty against published papers"
          help="Reviewers search arXiv, Crossref and Semantic Scholar (and OpenAlex if you added a key) for similar work. Only search words go to those services, never your files."
          checked={setup.groundNovelty}
          onChange={(groundNovelty) => change({ ...setup, groundNovelty })}
        />
        <div>
          <ToggleRow
            label="Run the automatic checks first"
            help="Page count, anonymity, undefined references and citations, missing figures, overfull lines and bibliography fields. Runs on this computer, without the AI."
            checked={setup.checklist}
            onChange={(checklist) => change({ ...setup, checklist })}
          />
          <div className="mt-1">
            <Button variant="ghost" onClick={() => void runChecks()} disabled={checking}>
              {checking ? <Loader2 size={13} className="animate-spin" /> : <ListChecks size={13} />} Run the checks now
            </Button>
          </div>
          {checks && (
            <div className="mt-2">
              <ChecklistView checks={checks} onJump={(f, l) => void revealSource(f, l)} />
            </div>
          )}
        </div>

        <Field label="Focus (optional)" htmlFor="review-focus" help="Anything the reviewers should look at closely, e.g. “the proof of Theorem 2” or “is the related work complete?”.">
          <textarea
            id="review-focus"
            className={AREA}
            rows={2}
            maxLength={MAX_FOCUS_CHARS}
            value={setup.focus}
            onChange={(e) => change({ ...setup, focus: e.target.value })}
          />
        </Field>

        <div>
          <div className="mb-1 text-sm">Also save the review in the project</div>
          <p className="mb-1.5 text-xs text-muted">The file is added as a change you review and accept, like any other change.</p>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={exports.md} onChange={(e) => setExports({ ...exports, md: e.target.checked })} /> review.md
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={exports.tex} onChange={(e) => setExports({ ...exports, tex: e.target.checked })} /> review.tex
            </label>
          </div>
        </div>
      </div>

      {problems.length > 0 && (
        <ul className="mt-4 list-disc pl-5 text-xs text-amber-400">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {savingAs ? (
        <SaveProfileForm
          project={project}
          setup={setup}
          venueName={preset?.name ?? setup.venue}
          onClose={() => setSavingAs(false)}
          onSaved={(list, id) => {
            setProfiles(list);
            setProfileId(id);
            setSavingAs(false);
          }}
        />
      ) : (
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => setSavingAs(true)} disabled={problems.length > 0}>
          <Save size={13} /> Save as profile…
        </Button>
        {profile && profile.source !== "builtin" && (
          <Button variant="ghost" onClick={() => void updateProfile()} disabled={problems.length > 0}>
            Save changes to “{profile.name}”
          </Button>
        )}
        <span className="flex-1" />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void start()} disabled={starting || problems.length > 0}>
          {starting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Start review
        </Button>
      </div>
      )}
    </Modal>
  );
}

function Field({ label, help, htmlFor, children }: { label: string; help?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help && <p className="mt-1 text-xs text-muted">{help}</p>}
    </div>
  );
}

function ToggleRow({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <div className="mt-0.5 text-xs text-muted">{help}</div>
      </div>
      <div className="shrink-0 pt-0.5">
        <Toggle label={label} checked={checked} onChange={onChange} />
      </div>
    </div>
  );
}

/** Names the setup and saves it as a reviewer profile, for all projects or this one (inline, in the footer). */
function SaveProfileForm({
  project,
  setup,
  venueName,
  onClose,
  onSaved,
}: {
  project: string;
  setup: ReviewSetup;
  venueName: string;
  onClose: () => void;
  onSaved: (reviewers: AgentProfile[], id: string) => void;
}) {
  const [name, setName] = useState(`${venueName} reviewer`);
  const [scope, setScope] = useState<ProfileScope>("global");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      const profile = { ...newProfile("reviewer", clean), description: `Reviews the paper for ${venueName}.`, review: cleanSetup(setup), source: scope };
      const before = new Set((await profilesApi.list(project)).profiles.map((p) => p.id));
      const view = await profilesApi.save(scope, profile, project);
      const reviewers = view.profiles.filter((p) => p.kind === "reviewer");
      const created = reviewers.find((p) => !before.has(p.id)) ?? reviewers.find((p) => p.name === clean);
      toast(`Saved the profile “${clean}”. It shows in the New task menu and in Settings.`, "success");
      onSaved(reviewers, created?.id ?? "");
    } catch (err) {
      toast(errorText(err), "error");
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-5 rounded-lg border border-border bg-bg p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="mb-2 text-sm font-medium">Save as profile</div>
      <label className="mb-1 block text-xs text-muted" htmlFor="review-profile-name">
        Name
      </label>
      <input id="review-profile-name" autoFocus maxLength={80} className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Use it in</span>
        <Choice<ProfileScope>
          label="Where to save the profile"
          value={scope}
          options={[
            ["global", "All projects"],
            ["project", "This project only"],
          ]}
          onChange={setScope}
        />
        <span className="flex-1" />
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
          Save profile
        </Button>
      </div>
    </form>
  );
}
