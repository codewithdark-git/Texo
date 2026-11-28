// The Review view: a reviewer run's report. The area chair's summary and
// decision, the score table with the spread between reviewers, the automatic
// checks, then each reviewer's review. Weaknesses jump to their file:line and
// can be handed to the task agent. The report can be saved as Markdown or
// LaTeX, or added to the project as review.tex / review.md.

import { createContext, useContext, useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isOpenableLink } from "../chat/markdown";
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ClipboardCopy,
  ExternalLink,
  FileDown,
  FilePlus2,
  Gavel,
  HelpCircle,
  Loader2,
  MapPin,
  ThumbsDown,
  ThumbsUp,
  User,
  Wand2,
} from "lucide-react";
import { Button, Modal } from "../../components/Dialog";
import { api, errorText } from "../../lib/api";
import { agentsApi, type AgentRun } from "../../lib/agentsApi";
import { agentUiApi, type ReviewExportFormat } from "../../lib/agentUiApi";
import { isReviewReport, reviewApi, scoreText, type Review, type ReviewReport, type Rubric, type VenuePreset, type Weakness } from "../../lib/reviewApi";
import { toast } from "../../ui";
import { revealSource } from "../../workspace/EditorPane";
import { useWorkspace } from "../../workspace/store";
import { startRun } from "../agents/actions";
import { InlineConfirm } from "../settings/InlineConfirm";
import { ChecklistView } from "./ChecklistView";
import {
  confidenceText,
  decisionTone,
  exportFileName,
  findPreset,
  fixPrompt,
  fixTitle,
  locationText,
  reportCounts,
  reportNotes,
  scoreRows,
  sortedWeaknesses,
  spreadText,
} from "./reviewLogic";

export interface ReviewReportViewProps {
  /** The project folder the review belongs to (jumps, fixes and "add to project" use it). */
  project: string;
  report: ReviewReport;
  /** The rubric the run used (score names and labels); default: the venue preset's. */
  rubric?: Rubric | null;
  /** Called after a click jumped to a place in the editor (a dialog closes itself). */
  onJump?: () => void;
}

/** The rubric a reviewer run used, from its options (`extra.review.rubric`). */
export function runRubric(run: Pick<AgentRun, "options"> | null | undefined): Rubric | null {
  const extra = run?.options?.extra as { review?: { rubric?: Rubric }; rubric?: Rubric } | undefined;
  const r = extra?.review?.rubric ?? extra?.rubric;
  return r && Array.isArray(r.scores) && r.scores.length ? r : null;
}

let presetCache: Promise<VenuePreset[]> | null = null;
function loadPresets(): Promise<VenuePreset[]> {
  presetCache ??= reviewApi.presets().catch((err) => {
    presetCache = null;
    throw err;
  });
  return presetCache;
}

const JumpDone = createContext<(() => void) | undefined>(undefined);

/** Shows file:line in the editor, then tells the host (e.g. to close its dialog). */
function useJump() {
  const done = useContext(JumpDone);
  return (file: string, line: number) => {
    void revealSource(file, line);
    done?.();
  };
}

export function ReviewReportView({ onJump, ...props }: ReviewReportViewProps) {
  return (
    <JumpDone.Provider value={onJump}>
      <ReportBody {...props} />
    </JumpDone.Provider>
  );
}

function ReportBody({ project, report, rubric: given }: Omit<ReviewReportViewProps, "onJump">) {
  const jump = useJump();
  const [preset, setPreset] = useState<VenuePreset | undefined>();
  useEffect(() => {
    let live = true;
    loadPresets().then(
      (ps) => live && setPreset(findPreset(ps, report.venue)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [report.venue]);

  const rubric = given ?? preset?.rubric ?? null;
  const venueName = preset?.name ?? report.venue;
  const rows = scoreRows(report, rubric);
  const counts = reportCounts(report);
  const notes = reportNotes(report);
  const meta = report.meta;
  const tone = decisionTone(meta?.decision ?? "");
  const toneCls = { good: "bg-emerald-500/15 text-emerald-400", bad: "bg-danger/15 text-danger", mixed: "bg-amber-500/15 text-amber-400", none: "" }[tone];

  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">Review for {venueName}</div>
          <div className="text-xs text-muted">
            {counts.reviewers} reviewer{counts.reviewers === 1 ? "" : "s"} · {counts.major} major and {counts.minor} minor point
            {counts.major + counts.minor === 1 ? "" : "s"} · {counts.questions} question{counts.questions === 1 ? "" : "s"}
          </div>
        </div>
        <ExportMenu project={project} report={report} />
      </div>

      {notes.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          {notes.map((n) => (
            <p key={n} className="flex gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" /> {n}
            </p>
          ))}
        </div>
      )}

      {meta && (
        <section aria-label="Area chair summary" className="rounded-lg border border-border bg-bg p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Gavel size={15} className="text-accent" />
            <span className="font-medium">Area chair</span>
            {meta.decision && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${toneCls}`}>{meta.decision}</span>}
          </div>
          {meta.summary && <p className="whitespace-pre-wrap select-text">{meta.summary}</p>}
          <PointList title="Must fix" items={meta.mustFix} project={project} from="Area chair" venue={venueName} strong />
          <PointList title="Nice to fix" items={meta.niceToFix} project={project} from="Area chair" venue={venueName} />
          {meta.consensus.length > 0 && <Bullets title="The reviewers agree" items={meta.consensus} />}
          {meta.disagreements.length > 0 && <Bullets title="The reviewers disagree" items={meta.disagreements} warn />}
        </section>
      )}

      {rows.length > 0 && (
        <section aria-label="Scores">
          <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">Scores</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface-2/50 text-muted">
                <tr>
                  <th className="px-2 py-1.5 text-left font-normal">Score</th>
                  {report.reviews.map((r, i) => (
                    <th key={i} className="px-2 py-1.5 text-left font-normal">
                      {r.persona || `Reviewer ${i + 1}`}
                    </th>
                  ))}
                  <th className="px-2 py-1.5 text-left font-normal">Spread</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id} className={row.disagree ? "bg-amber-500/5" : ""}>
                    <td className="px-2 py-1.5" title={row.scale?.description}>
                      {row.name}
                      {row.scale && <span className="text-muted"> ({row.scale.min}–{row.scale.max})</span>}
                    </td>
                    {row.values.map((v, i) => (
                      <td key={i} className="px-2 py-1.5" title={v != null ? scoreText(row.scale, v) : undefined}>
                        {v ?? "–"}
                      </td>
                    ))}
                    <td className="px-2 py-1.5">
                      {spreadText(row.spread)}
                      {row.disagree && (
                        <span className="ml-1.5 inline-flex items-center gap-1 text-amber-400" title="The reviewers' scores are far apart.">
                          <AlertTriangle size={11} /> far apart
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(report.checklist ?? []).length > 0 && (
        <section aria-label="Automatic checks">
          <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">Automatic checks</h3>
          <ChecklistView checks={report.checklist ?? []} onJump={jump} />
        </section>
      )}

      <section aria-label="Reviews" className="space-y-3">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Reviews</h3>
        {report.reviews.map((r, i) => (
          <ReviewCard key={i} index={i} review={r} rubric={rubric} project={project} venue={venueName} />
        ))}
        {report.reviews.length === 0 && <p className="text-xs text-muted">No reviewer handed in a review.</p>}
      </section>

      {(report.references ?? []).length > 0 && (
        <section aria-label="Related papers">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
            <BookOpen size={12} /> Related papers the reviewers found
          </h3>
          <ul className="space-y-1.5 text-xs">
            {(report.references ?? []).map((ref, i) => {
              // The model wrote these: only web links open, and ids are encoded.
              const link = isOpenableLink(ref.url ?? null)
                ? ref.url
                : ref.doi
                  ? `https://doi.org/${encodeURI(ref.doi.trim())}`
                  : ref.arxivId
                    ? `https://arxiv.org/abs/${encodeURIComponent(ref.arxivId.trim())}`
                    : null;
              return (
                <li key={i} className="select-text">
                  <span className="font-medium">{ref.title}</span>
                  {[ref.authors, ref.venue, ref.year].filter(Boolean).length > 0 && (
                    <span className="text-muted"> · {[ref.authors, ref.venue, ref.year].filter(Boolean).join(", ")}</span>
                  )}
                  {link && (
                    <button type="button" className="ml-1.5 inline-flex items-center gap-0.5 text-accent hover:underline" onClick={() => void openUrl(link)}>
                      <ExternalLink size={11} /> open
                    </button>
                  )}
                  {ref.note && <div className="text-muted">{ref.note}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function Bullets({ title, items, warn }: { title: string; items: string[]; warn?: boolean }) {
  return (
    <div className="mt-3">
      <div className={`mb-1 text-xs font-medium ${warn ? "text-amber-400" : "text-muted"}`}>{title}</div>
      <ul className="list-disc space-y-0.5 pl-5 select-text">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function PointList({
  title,
  items,
  project,
  from,
  venue,
  strong,
}: {
  title: string;
  items: string[];
  project: string;
  from: string;
  venue: string;
  strong?: boolean;
}) {
  const clean = items.filter((t) => t.trim());
  if (!clean.length) return null;
  return (
    <div className="mt-3">
      <div className={`mb-1 text-xs font-medium ${strong ? "text-text" : "text-muted"}`}>{title}</div>
      <ul className="space-y-1">
        {clean.map((t, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-current opacity-60" />
            <span className="min-w-0 flex-1 select-text">{t}</span>
            <FixButton project={project} point={{ text: t }} from={from} venue={venue} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewCard({ index, review, rubric, project, venue }: { index: number; review: Review; rubric: Rubric | null; project: string; venue: string }) {
  const [open, setOpen] = useState(true);
  const name = review.persona || `Reviewer ${index + 1}`;
  const confidence = confidenceText(review, rubric);
  const scores = Object.entries(review.scores ?? {});
  return (
    <article className="rounded-lg border border-border">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <User size={14} className="text-muted" />
        <span className="font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {scores.map(([id, v]) => `${rubric?.scores.find((s) => s.id === id)?.name ?? id} ${v}`).join(" · ")}
          {confidence ? ` · confidence ${confidence}` : ""}
        </span>
        <ChevronDown size={14} className={`shrink-0 text-muted transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-2.5">
          {review.summary && <p className="whitespace-pre-wrap select-text">{review.summary}</p>}
          {review.strengths.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                <ThumbsUp size={12} /> Strengths
              </div>
              <ul className="list-disc space-y-0.5 pl-5 select-text">
                {review.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {review.weaknesses.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-400">
                <ThumbsDown size={12} /> Weaknesses
              </div>
              <ul className="space-y-1.5">
                {sortedWeaknesses(review.weaknesses).map((w, i) => (
                  <WeaknessRow key={i} w={w} project={project} from={name} venue={venue} />
                ))}
              </ul>
            </div>
          )}
          {review.questions.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
                <HelpCircle size={12} /> Questions for the authors
              </div>
              <ol className="list-decimal space-y-0.5 pl-5 select-text">
                {review.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </div>
          )}
          {scores.length > 0 && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              {scores.map(([id, v]) => {
                const scale = rubric?.scores.find((s) => s.id === id);
                return (
                  <span key={id} className="rounded-md bg-surface-2 px-2 py-0.5" title={scale?.description}>
                    {scale?.name ?? id}: {scoreText(scale, v)}
                  </span>
                );
              })}
              {confidence && <span className="rounded-md bg-surface-2 px-2 py-0.5">Confidence: {confidence}</span>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function WeaknessRow({ w, project, from, venue }: { w: Weakness; project: string; from: string; venue: string }) {
  const jump = useJump();
  const where = locationText(w.file, w.line);
  return (
    <li className="flex items-start gap-2">
      <span
        className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase ${
          w.severity === "major" ? "bg-danger/15 text-danger" : "bg-surface-2 text-muted"
        }`}
      >
        {w.severity}
      </span>
      <div className="min-w-0 flex-1">
        <p className="select-text">{w.text}</p>
        {where && (
          <button
            type="button"
            className="mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
            title="Show this place in the editor"
            onClick={() => jump(w.file!, w.line ?? 1)}
          >
            <MapPin size={11} /> {where}
          </button>
        )}
      </div>
      <FixButton project={project} point={w} from={from} venue={venue} />
    </li>
  );
}

/** "Fix this with the task agent": starts a task run; its changes wait for review. */
function FixButton({ project, point, from, venue }: { project: string; point: { text: string; file?: string | null; line?: number | null }; from: string; venue: string }) {
  const [state, setState] = useState<"idle" | "starting" | "started">("idle");
  const start = async () => {
    if (state !== "idle") return;
    setState("starting");
    // startRun sends the unsaved buffers, notes the run and opens its tab; it shows its own error.
    const runId = await startRun(project, {
      kind: "task",
      prompt: fixPrompt(point, from, venue),
      options: { title: fixTitle(point.text) },
    });
    if (!runId) {
      setState("idle");
      return;
    }
    setState("started");
    toast("The task agent is on it in its own tab. Its changes wait for your review.", "success");
  };
  return (
    <button
      type="button"
      disabled={state !== "idle"}
      onClick={() => void start()}
      title="Start a task agent run that changes the paper to address this point. You review the changes before anything is saved."
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-60"
    >
      {state === "starting" ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
      {state === "started" ? "Started" : "Fix this"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function ExportMenu({ project, report }: { project: string; report: ReviewReport }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<ReviewExportFormat | null>(null);
  const projectName = useWorkspace((s) => s.project?.name ?? null);
  const files = useWorkspace((s) => s.files);

  const saveAs = async (format: ReviewExportFormat) => {
    setOpen(false);
    const dest = await saveDialog({
      title: format === "md" ? "Save the review as Markdown" : "Save the review as LaTeX",
      defaultPath: exportFileName(projectName, format),
      filters: [format === "md" ? { name: "Markdown", extensions: ["md"] } : { name: "LaTeX", extensions: ["tex"] }],
    });
    if (!dest) return;
    try {
      await agentUiApi.saveReviewAs(report, format, dest);
      toast("Review saved.", "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  const copy = async () => {
    setOpen(false);
    try {
      await navigator.clipboard.writeText(await agentUiApi.renderReview(report, "md"));
      toast("The review is copied as Markdown.", "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  const addFile = async (format: ReviewExportFormat) => {
    const file = `review.${format}`;
    setAdding(null);
    const ws = useWorkspace.getState();
    if (ws.status[file]?.dirty) {
      toast(`${file} is open with unsaved changes. Save or close it first.`, "error");
      return;
    }
    try {
      await api.writeFile(project, file, await agentUiApi.renderReview(report, format));
      if (ws.project && ws.project.path === project) {
        await ws.refreshFiles();
        await ws.openFile(file);
      }
      toast(`${file} added to the project. Your history keeps the earlier version.`, "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  const item = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2";
  return (
    <div className="relative">
      <Button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <FileDown size={13} /> Export <ChevronDown size={12} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onMouseDown={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-border bg-surface p-1 shadow-xl">
            <button role="menuitem" type="button" className={item} onClick={() => void saveAs("md")}>
              <FileDown size={14} className="text-muted" /> Save as Markdown…
            </button>
            <button role="menuitem" type="button" className={item} onClick={() => void saveAs("tex")}>
              <FileDown size={14} className="text-muted" /> Save as LaTeX…
            </button>
            <button role="menuitem" type="button" className={item} onClick={() => void copy()}>
              <ClipboardCopy size={14} className="text-muted" /> Copy as Markdown
            </button>
            <div className="my-1 border-t border-border" />
            <button
              role="menuitem"
              type="button"
              className={item}
              onClick={() => {
                setOpen(false);
                setAdding("tex");
              }}
            >
              <FilePlus2 size={14} className="text-muted" /> Add review.tex to the project…
            </button>
            <button
              role="menuitem"
              type="button"
              className={item}
              onClick={() => {
                setOpen(false);
                setAdding("md");
              }}
            >
              <FilePlus2 size={14} className="text-muted" /> Add review.md to the project…
            </button>
          </div>
        </>
      )}
      {adding && (
        <div className="absolute right-0 z-20 mt-1 w-80 rounded-lg bg-surface shadow-xl">
          <InlineConfirm
            message={
              files.some((f) => f.path === `review.${adding}`) ? (
                <>
                  The project already has <span className="font-mono">review.{adding}</span>. Replace it with this review? The earlier version stays in
                  your history, so you can restore it.
                </>
              ) : (
                <>
                  Save the review as <span className="font-mono">review.{adding}</span> in the project folder?
                </>
              )
            }
            confirmLabel={files.some((f) => f.path === `review.${adding}`) ? "Replace" : "Add"}
            onConfirm={() => void addFile(adding)}
            onCancel={() => setAdding(null)}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

export interface ReviewReportDialogProps {
  project: string;
  runId: string;
  onClose: () => void;
}

/** Loads a reviewer run and shows its report in a dialog. */
export function ReviewReportDialog({ project, runId, onClose }: ReviewReportDialogProps) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    agentsApi.get(project, runId).then(
      (r) => live && setRun(r),
      (err) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [project, runId]);

  const report = run?.report;
  return (
    <Modal title={run?.title || "Review"} onClose={onClose} extraWide>
      {error ? (
        <p className="text-sm text-muted">The review couldn't be opened: {error}</p>
      ) : !run ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Opening the review…
        </p>
      ) : isReviewReport(report) ? (
        <ReviewReportView project={project} report={report} rubric={runRubric(run)} />
      ) : (
        <p className="text-sm text-muted">{run.error || "This run has no review report."}</p>
      )}
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
