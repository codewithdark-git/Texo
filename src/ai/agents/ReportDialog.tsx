// A run's report: the fixer's result (what's left, missing packages with
// the one-click install), the task agent's per-task outcome, the response
// letter's plan and placeholders, or a venue-style review (checklist,
// reviews with weaknesses that jump to their line, and the meta-review).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleCheck, CircleX, Copy, Loader2, TriangleAlert } from "lucide-react";
import {
  agentsApi,
  isFixReport,
  isRebuttalReport,
  isTaskReport,
  taskStatusText,
  type AgentRun,
  type FixReport,
  type RebuttalReport,
  type TaskReport,
} from "../../lib/agentsApi";
import { isReviewReport } from "../../lib/reviewApi";
import { ReviewReportView, runRubric } from "../review/ReviewReportView";
import { Button, Modal } from "../../components/Dialog";
import { toast } from "../../ui";
import { revealSource } from "../../workspace/EditorPane";
import { InstallPackageFix } from "../../workspace/InstallPackageFix";
import { errorText } from "./actions";

function Where({ file, line, onJump }: { file: string | null; line: number | null; onJump: () => void }) {
  if (!file) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void revealSource(file, line ?? 1);
        onJump();
      }}
      className="font-mono text-[11px] text-accent hover:underline"
    >
      {file}
      {line ? `:${line}` : ""}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1.5 text-[13px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return <p className="text-[13px] text-muted">None.</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

function FixView({ r, onJump }: { r: FixReport; onJump: () => void }) {
  return (
    <>
      <p className="flex items-center gap-2 text-sm">
        {r.fixed ? <CircleCheck size={16} className="text-emerald-400" /> : <TriangleAlert size={16} className="text-amber-400" />}
        {r.fixed ? "The project compiles with these changes." : r.compiled ? "Couldn't fully fix it." : "The fix couldn't be checked with a compile."}
        <span className="text-xs text-muted">
          {r.rounds} compile round{r.rounds === 1 ? "" : "s"}
        </span>
      </p>
      {r.summary && <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap">{r.summary}</p>}
      {r.missingPackages.length > 0 && (
        <Section title="Missing packages">
          <p className="mb-1 text-[13px] text-muted">These need installing rather than editing around:</p>
          {r.missingPackages.map((p) => (
            <InstallPackageFix key={p} pkg={p} />
          ))}
        </Section>
      )}
      {r.remaining.length > 0 && (
        <Section title="Still failing">
          <ul className="space-y-1 text-[13px]">
            {r.remaining.map((x, i) => (
              <li key={i}>
                {x.message} <Where file={x.file} line={x.line} onJump={onJump} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.explanation && (
        <Section title="What it means">
          <p className="text-[13px] leading-relaxed">{r.explanation}</p>
        </Section>
      )}
    </>
  );
}

function TaskView({ r }: { r: TaskReport }) {
  return (
    <>
      {r.summary && <p className="text-sm">{r.summary}</p>}
      <ol className="mt-3 space-y-2">
        {r.tasks.map((t) => (
          <li key={t.n} className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px]">
            <div className="flex items-center gap-2">
              {t.status === "done" ? <CircleCheck size={14} className="text-emerald-400" /> : t.status === "notDone" ? <CircleX size={14} className="text-danger" /> : <TriangleAlert size={14} className="text-amber-400" />}
              <span className="font-medium">
                {t.n}. {t.task}
              </span>
              <span className="ml-auto text-xs text-muted">{taskStatusText(t.status)}</span>
            </div>
            {t.note && <p className="mt-1 text-text/85">{t.note}</p>}
          </li>
        ))}
      </ol>
    </>
  );
}

function RebuttalView({ r, onJump }: { r: RebuttalReport; onJump: () => void }) {
  return (
    <>
      {r.summary && <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{r.summary}</p>}
      {r.letter && (
        <p className="mt-2 text-[13px]">
          Letter: <Where file={r.letter} line={1} onJump={onJump} /> <span className="text-muted">(in the changes to review until you apply them)</span>
        </p>
      )}
      {r.tbd.length > 0 && (
        <Section title="Still to do ([TBD] in the letter)">
          <Bullets items={r.tbd} />
        </Section>
      )}
      {r.warnings.length > 0 && (
        <Section title="Warnings">
          <Bullets items={r.warnings} />
        </Section>
      )}
      <Section title="Concerns">
        <ul className="space-y-1.5 text-[13px]">
          {r.concerns.map((c) => (
            <li key={c.id}>
              <span className="mr-1.5 rounded bg-surface-2 px-1.5 font-mono text-[11px]">{c.id}</span>
              {c.summary}
              {c.status && <span className="ml-1.5 text-xs text-muted">({c.status})</span>}
              {c.changes && <span className="block text-xs text-muted">Changes: {c.changes}</span>}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

export function ReportDialog({ project, runId, onClose }: { project: string; runId: string; onClose: () => void }) {
  const [run, setRun] = useState<AgentRun | null>(null);
  // Loaded once per run: a new onClose from the parent must not fetch the whole journal again (FE-5).
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    let live = true;
    agentsApi.get(project, runId).then(
      (r) => live && setRun(r),
      (e) => {
        if (!live) return;
        toast(errorText(e), "error");
        closeRef.current();
      },
    );
    return () => {
      live = false;
    };
  }, [project, runId]);

  const r = run?.report ?? null;
  const copy = () => {
    const text = run ? [run.title, "", run.finalMessage ?? "", "", r ? "```json\n" + JSON.stringify(r, null, 2) + "\n```" : ""].join("\n").trim() : "";
    navigator.clipboard.writeText(text).then(
      () => toast("Report copied."),
      () => toast("Texo couldn't copy to the clipboard.", "error"),
    );
  };

  return (
    <Modal title={run?.title || "Report"} onClose={onClose} extraWide>
      {!run ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading the report…
        </p>
      ) : (
        <div>
          {isFixReport(r) ? (
            <FixView r={r} onJump={onClose} />
          ) : isTaskReport(r) ? (
            <TaskView r={r} />
          ) : isRebuttalReport(r) ? (
            <RebuttalView r={r} onJump={onClose} />
          ) : isReviewReport(r) ? (
            <ReviewReportView project={project} report={r} rubric={runRubric(run)} onJump={onClose} />
          ) : r ? (
            <pre className="max-h-[60vh] overflow-auto rounded bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap select-text">{JSON.stringify(r, null, 2)}</pre>
          ) : null}
          {run.finalMessage && !isTaskReport(r) && !isFixReport(r) && (
            <Section title="The agent's last message">
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap select-text">{run.finalMessage}</p>
            </Section>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={copy}>
              <Copy size={14} /> Copy
            </Button>
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
