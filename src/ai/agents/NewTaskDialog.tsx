// The New task dialog for the task agent ("Custom task…") and the response
// to reviewers: a multiline prompt (it may hold several tasks), attachments
// with previews (pictures, PDFs as text, text files) and "Also save into
// project", and the profile and model to use. Reading files is shared with
// the chat (src/ai/chat/readAttachment.ts).

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { aiApi, type AiModel } from "../../lib/api";
import type { AgentProfile, RebuttalExtra, StartRequest } from "../../lib/agentsApi";
import { Button, Modal } from "../../components/Dialog";
import { toast } from "../../ui";
import { useAiSettings } from "../aiPrefs";
import { AttachmentError, readDroppedPath, readFileObject, type ReadyAttachment } from "../chat/readAttachment";
import { PATH_DROP_ATTR, registerPathDrop } from "../pathDrop";
import { startRun } from "./actions";
import type { NewTaskKind } from "./dialogStore";
import {
  attachmentsProblem,
  canSaveIntoProject,
  defaultSaveAs,
  runAttachLimit,
  saveAsProblem,
  saveUnavailableReason,
  toStartAttachment,
  type RunAttachment,
} from "./runAttachments";
import { runsForProject, useRuns } from "./runsStore";

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/bmp,.pdf,.tex,.ltx,.bib,.sty,.cls,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.log";

let nextId = 1;

/** The provider's live model list (empty when it can't be loaded). */
export function useModels(): { models: AiModel[] | null; failed: boolean } {
  const provider = useAiSettings((s) => s.settings.provider);
  const [state, setState] = useState<{ models: AiModel[] | null; failed: boolean }>({ models: null, failed: false });
  useEffect(() => {
    let live = true;
    if (!useAiSettings.getState().loaded) void useAiSettings.getState().load();
    setState({ models: null, failed: false });
    aiApi.listModels(provider).then(
      (models) => live && setState({ models, failed: false }),
      () => live && setState({ models: [], failed: true }),
    );
    return () => {
      live = false;
    };
  }, [provider]);
  return state;
}

/** Profile and model pickers shared by the start dialogs. */
export function ProfileModelPicker({
  profiles,
  profileId,
  onProfile,
  model,
  onModel,
}: {
  profiles: AgentProfile[];
  profileId: string;
  onProfile: (id: string) => void;
  model: string;
  onModel: (m: string) => void;
}) {
  const { models, failed } = useModels();
  const profile = profiles.find((p) => p.id === profileId);
  const known = models ?? [];
  const extra = model && !known.some((m) => m.id === model) ? [model] : [];
  const select = "h-8 w-full rounded-lg border border-border bg-bg px-2 text-sm outline-none focus:border-accent";
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="block text-xs text-muted">
        Agent
        <select className={`${select} mt-1`} value={profileId} onChange={(e) => onProfile(e.target.value)} disabled={profiles.length < 2}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-muted">
        Model
        <select
          className={`${select} mt-1`}
          value={model}
          onChange={(e) => onModel(e.target.value)}
          title={failed ? "Texo couldn't load the model list, so the default model is used." : undefined}
        >
          <option value="">{profile?.model ? `The agent's model (${profile.model})` : "Default for this agent"}</option>
          {extra.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          {models === null && <option disabled>Loading models…</option>}
          {known.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label || m.id}
              {m.recommended ? " (suggested)" : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

type Item = RunAttachment | { id: string; name: string; reading: true };
const isReady = (a: Item): a is RunAttachment => !("reading" in a);

function Preview({ a }: { a: RunAttachment }) {
  if (a.kind === "image" && a.dataUrl) return <img src={a.dataUrl} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />;
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-bg">
      <FileText size={18} className="text-muted" />
    </span>
  );
}

function AttachmentRow({ a, onChange, onRemove }: { a: Item; onChange: (patch: Partial<RunAttachment>) => void; onRemove: () => void }) {
  if (!isReady(a)) {
    return (
      <li className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 p-1.5 text-xs">
        <span className="flex h-12 w-12 items-center justify-center">
          <Loader2 size={16} className="animate-spin text-muted" />
        </span>
        <span className="flex-1 truncate">Reading {a.name}…</span>
      </li>
    );
  }
  const savable = canSaveIntoProject(a);
  const pathProblem = a.save && savable ? saveAsProblem(a.saveAs) : null;
  const firstLines = a.kind === "text" && a.text ? a.text.split("\n").slice(0, 2).join(" ").slice(0, 140) : "";
  return (
    <li className="flex gap-2 rounded-lg border border-border bg-surface-2 p-1.5 text-xs">
      <Preview a={a} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{a.name}</span>
          <span className="shrink-0 text-muted">{a.note}</span>
        </div>
        {firstLines && <p className="truncate font-mono text-[11px] text-muted">{firstLines}</p>}
        <label className={`mt-1 flex items-center gap-1.5 ${savable ? "" : "opacity-60"}`} title={saveUnavailableReason(a) ?? undefined}>
          <input type="checkbox" disabled={!savable} checked={a.save && savable} onChange={(e) => onChange({ save: e.target.checked })} />
          Also save into project
          {a.save && savable && (
            <input
              aria-label={`Save ${a.name} as`}
              value={a.saveAs}
              onChange={(e) => onChange({ saveAs: e.target.value })}
              className={`ml-1 h-6 min-w-0 flex-1 rounded border bg-bg px-1.5 font-mono text-[11px] outline-none focus:border-accent ${pathProblem ? "border-danger" : "border-border"}`}
            />
          )}
        </label>
        {pathProblem && <p className="mt-0.5 text-danger">{pathProblem}</p>}
        {a.save && savable && !pathProblem && <p className="mt-0.5 text-muted">It's added through the changes you review.</p>}
      </div>
      <button type="button" aria-label={`Remove ${a.name}`} onClick={onRemove} className="self-start rounded p-1 text-muted hover:bg-surface hover:text-text">
        <X size={13} />
      </button>
    </li>
  );
}

export function NewTaskDialog({
  project,
  kind,
  profile,
  profiles,
  onClose,
}: {
  project: string;
  kind: NewTaskKind;
  profile: AgentProfile | null;
  profiles: AgentProfile[];
  onClose: () => void;
}) {
  const choices = useMemo(() => {
    const own = profiles.filter((p) => p.kind === kind);
    return own.length ? own : [{ id: kind, name: kind === "task" ? "Task agent" : "Response to reviewers", kind, model: null } as AgentProfile];
  }, [profiles, kind]);
  const [profileId, setProfileId] = useState(profile?.id ?? choices[0]?.id ?? kind);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [reviewRunId, setReviewRunId] = useState("");
  const [starting, setStarting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const runs = useRuns((s) => s.runs);
  const reviews = kind === "rebuttal" ? runsForProject(runs, project).filter((r) => r.kind === "reviewer" && r.hasReport) : [];

  const ready = items.filter(isReady);
  const reading = items.length > ready.length;
  const problem = attachmentsProblem(ready);
  const hasInput = prompt.trim() !== "" || ready.length > 0 || (kind === "rebuttal" && reviewRunId !== "");

  // The count as of the last render, plus files added since (a drop handler outlives renders).
  const count = useRef(0);
  count.current = items.length;
  const addReads = (reads: Iterable<{ name: string; read: () => Promise<ReadyAttachment> }>) => {
    for (const { name, read } of reads) {
      const refused = runAttachLimit(count.current);
      if (refused) {
        toast(refused, "info");
        return;
      }
      count.current++;
      const id = `a${nextId++}`;
      setItems((cur) => [...cur, { id, name, reading: true }]);
      read().then(
        (r) =>
          setItems((cur) =>
            cur.map((x) => (x.id === id ? { ...r, id, save: false, saveAs: defaultSaveAs(r) } : x)),
          ),
        (err) => {
          setItems((cur) => cur.filter((x) => x.id !== id));
          toast(err instanceof AttachmentError ? err.message : `Texo couldn't read “${name}”.`, "error");
        },
      );
    }
  };
  const addFiles = (files: Iterable<File>) => addReads([...files].map((f) => ({ name: f.name || "pasted picture", read: () => readFileObject(f) })));

  // Files dropped from the file manager arrive through the workspace (Tauri
  // takes OS drops; the onDrop below only sees drops from inside the page).
  const dropId = useMemo(() => `task-${nextId++}`, []);
  const addPathsRef = useRef((paths: string[]) => addReads(paths.map((p) => ({ name: p.split(/[\\/]/).pop() || "file", read: () => readDroppedPath(p) }))));
  useEffect(() => registerPathDrop(dropId, (paths) => addPathsRef.current(paths)), [dropId]);

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  };

  const start = async () => {
    if (!hasInput || reading || problem) return;
    setStarting(true);
    const chosen = choices.find((p) => p.id === profileId);
    const extra: RebuttalExtra | undefined = kind === "rebuttal" && reviewRunId ? { reviewRunId } : undefined;
    const request: StartRequest = {
      kind,
      // A placeholder profile (no profiles loaded) isn't sent.
      profileId: profiles.some((p) => p.id === profileId) ? profileId : null,
      prompt: prompt.trim(),
      attachments: ready.map(toStartAttachment),
      options: {
        ...(model ? { model } : {}),
        ...(kind === "rebuttal" ? { title: "Response to reviewers" } : {}),
        ...(chosen && chosen.source !== "builtin" && chosen.name ? { profileName: chosen.name } : {}),
        ...(extra ? { extra } : {}),
      },
    };
    const id = await startRun(project, request);
    setStarting(false);
    if (id) onClose();
  };

  const title = kind === "rebuttal" ? "Respond to reviewers" : profile ? profile.name : "Custom task";
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="space-y-4" {...{ [PATH_DROP_ATTR]: dropId }} onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}>
        <label className="block text-xs text-muted">
          {kind === "rebuttal" ? "Paste the reviews, or attach them below." : "What should the agent do? You can list several tasks, one per line."}
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void start();
              }
            }}
            rows={kind === "rebuttal" ? 10 : 6}
            placeholder={
              kind === "rebuttal"
                ? "Reviewer 1: The evaluation lacks a comparison with…"
                : "1. Shorten the abstract to 150 words\n2. Add the attached plot as a figure in Results\n3. Check that every table has a caption"
            }
            className="mt-1 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>

        {kind === "rebuttal" && reviews.length > 0 && (
          <label className="block text-xs text-muted">
            Also answer an earlier Texo review
            <select
              value={reviewRunId}
              onChange={(e) => setReviewRunId(e.target.value)}
              className="mt-1 h-8 w-full rounded-lg border border-border bg-bg px-2 text-sm text-text outline-none focus:border-accent"
            >
              <option value="">No</option>
              {reviews.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} ({new Date(r.startedAt * 1000).toLocaleDateString()})
                </option>
              ))}
            </select>
          </label>
        )}

        <div>
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
            <span>Attachments: pictures, PDFs and text files. You can also paste or drop them here.</span>
            <Button className="ml-auto" onClick={() => fileInput.current?.click()}>
              <Paperclip size={14} /> Attach
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          {items.length > 0 && (
            <ul className="space-y-1.5">
              {items.map((a) => (
                <AttachmentRow
                  key={a.id}
                  a={a}
                  onRemove={() => setItems((cur) => cur.filter((x) => x.id !== a.id))}
                  onChange={(patch) => setItems((cur) => cur.map((x) => (x.id === a.id && isReady(x) ? { ...x, ...patch } : x)))}
                />
              ))}
            </ul>
          )}
        </div>

        <ProfileModelPicker profiles={choices} profileId={profileId} onProfile={setProfileId} model={model} onModel={setModel} />

        <p className="text-xs leading-relaxed text-muted">
          The agent works on a private copy in the background and may look things up on the web. Nothing in your files changes until you review
          and accept its changes.
        </p>
        {problem && <p className="text-xs text-danger">{problem}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!hasInput || reading || !!problem || starting} onClick={() => void start()}>
            {starting && <Loader2 size={14} className="animate-spin" />} Start
          </Button>
        </div>
      </div>
    </Modal>
  );
}
