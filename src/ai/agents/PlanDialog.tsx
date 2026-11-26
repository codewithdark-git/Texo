// The response-to-reviewers plan, shown while the run waits in
// awaiting_input: one row per reviewer concern with what the agent plans
// (answer, change the manuscript, or a new experiment marked [TBD]). Edit
// it, then approve to start drafting (agent_respond).

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { agentsApi, approvePlan, isRebuttalPlan, type RebuttalAction, type RebuttalConcern } from "../../lib/agentsApi";
import { Button, ConfirmDialog, Modal } from "../../components/Dialog";
import { toast } from "../../ui";
import { errorText } from "./actions";
import { useRuns } from "./runsStore";

const ACTIONS: [RebuttalAction, string][] = [
  ["answer", "Answer in the letter"],
  ["change", "Change the manuscript"],
  ["experiment", "Needs a new experiment ([TBD])"],
];

export function PlanDialog({ project, runId, onClose }: { project: string; runId: string; onClose: () => void }) {
  const summary = useRuns((s) => s.runs[runId]);
  const [concerns, setConcerns] = useState<RebuttalConcern[] | null>(null);
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  useEffect(() => {
    let live = true;
    const fromSummary = summary?.awaiting;
    if (isRebuttalPlan(fromSummary)) {
      setConcerns(fromSummary.concerns.map((c) => ({ ...c })));
      setMessage(fromSummary.message);
      return;
    }
    agentsApi.get(project, runId).then(
      (run) => {
        if (!live) return;
        if (isRebuttalPlan(run.awaiting)) {
          setConcerns(run.awaiting.concerns.map((c) => ({ ...c })));
          setMessage(run.awaiting.message);
        } else setConcerns([]);
      },
      (e) => live && (toast(errorText(e), "error"), onClose()),
    );
    return () => {
      live = false;
    };
    // Load once per run; later summary updates don't reset the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, runId]);

  const stillWaiting = summary ? summary.status === "awaiting_input" : true;
  const patch = (i: number, p: Partial<RebuttalConcern>) => setConcerns((cs) => cs && cs.map((c, k) => (k === i ? { ...c, ...p } : c)));

  const answer = async (value: unknown) => {
    setBusy(true);
    try {
      await agentsApi.respond(runId, value);
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-text outline-none focus:border-accent";
  return (
    <Modal title="Plan for your response" onClose={onClose} extraWide>
      {!concerns ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading the plan…
        </p>
      ) : (
        <div className="space-y-3">
          {message && <p className="text-sm leading-relaxed text-text/85">{message}</p>}
          {!stillWaiting && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">This run isn't waiting for the plan any more.</p>}
          {concerns.length === 0 && <p className="text-sm text-muted">The agent found no reviewer concerns to plan for.</p>}
          <ol className="space-y-2">
            {concerns.map((c, i) => (
              <li key={`${c.id}-${i}`} className="rounded-lg border border-border bg-surface-2 p-2.5">
                <div className="mb-1.5 flex items-center gap-2 text-xs">
                  <span className="rounded bg-bg px-1.5 py-0.5 font-mono">{c.id}</span>
                  {c.reviewer && <span className="text-muted">{c.reviewer}</span>}
                  <select
                    aria-label={`What to do about ${c.id}`}
                    value={c.action}
                    onChange={(e) => patch(i, { action: e.target.value as RebuttalAction })}
                    className="ml-auto h-7 rounded-md border border-border bg-bg px-1.5 text-xs outline-none focus:border-accent"
                  >
                    {ACTIONS.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={`Leave out ${c.id}`}
                    title="Leave this concern out"
                    onClick={() => setConcerns((cs) => cs && cs.filter((_, k) => k !== i))}
                    className="rounded p-1 text-muted hover:bg-surface hover:text-text"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {c.quote && <blockquote className="mb-1.5 border-l-2 border-border pl-2 text-[12px] text-muted italic">{c.quote}</blockquote>}
                <label className="block text-[11px] text-muted">
                  The concern
                  <input className={`${field} mt-0.5`} value={c.summary} onChange={(e) => patch(i, { summary: e.target.value })} />
                </label>
                <label className="mt-1.5 block text-[11px] text-muted">
                  Plan
                  <textarea rows={2} className={`${field} mt-0.5 resize-y`} value={c.plan} onChange={(e) => patch(i, { plan: e.target.value })} />
                </label>
                {c.action === "change" && (
                  <label className="mt-1.5 block text-[11px] text-muted">
                    File to change (optional)
                    <input className={`${field} mt-0.5 font-mono`} value={c.file ?? ""} onChange={(e) => patch(i, { file: e.target.value || undefined })} />
                  </label>
                )}
              </li>
            ))}
          </ol>
          <label className="block text-xs text-muted">
            A note for the drafting step (optional)
            <textarea rows={2} className={`${field} mt-1 resize-y`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Keep the tone short and polite." />
          </label>
          <p className="text-xs text-muted">Experiments you haven't run are left as [TBD: …] in the letter; the agent never invents results.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy || !stillWaiting} onClick={() => setConfirmStop(true)}>
              Stop here
            </Button>
            <Button onClick={onClose}>Later</Button>
            <Button variant="primary" disabled={busy || !stillWaiting || concerns.length === 0} onClick={() => void answer(approvePlan(concerns, note))}>
              {busy && <Loader2 size={14} className="animate-spin" />} Approve and draft
            </Button>
          </div>
        </div>
      )}
      {confirmStop && (
        <ConfirmDialog
          title="Stop without drafting?"
          message="The agent stops here and won't write the response letter. You can start a new response later."
          confirmLabel="Stop"
          danger
          onClose={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false);
            void answer({ approved: false });
          }}
        />
      )}
    </Modal>
  );
}
