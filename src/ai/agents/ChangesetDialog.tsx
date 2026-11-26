// The changeset review: the files a run changed (added / modified /
// deleted, with conflict and "needs your attention" flags and the agent's
// reasons), a Monaco diff per file with a checkbox per hunk, editing in
// place (the right side, or the merged text of a conflict), and Accept all /
// Apply selected / Discard. A reason typed for a rejected change is offered
// as a project memory note afterwards.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileMinus, FilePen, FilePlus, GitMerge, Loader2, TriangleAlert, Undo2, X } from "lucide-react";
import { agentsApi, memoryApi, type ApplyResult, type Changeset, type ChangesetFile, type Decision } from "../../lib/agentsApi";
import { Button, ConfirmDialog } from "../../components/Dialog";
import { toast } from "../../ui";
import { useWorkspace } from "../../workspace/store";
import { applyDecisions, errorText } from "./actions";
import { DiffView, MergeEditor } from "./DiffEditors";
import {
  carryPicks,
  changesetStale,
  decisionFor,
  hunkLabel,
  hunkPicking,
  hunkRevealLine,
  initialPick,
  isOpen,
  lineCounts,
  pickedText,
  pickProblem,
  reasonNotes,
  selectedDecisions,
  type FilePick,
} from "./hunks";
import { useRuns } from "./runsStore";

const STATUS_ICON = { added: FilePlus, modified: FilePen, deleted: FileMinus } as const;
const STATUS_WORD = { added: "New file", modified: "Changed", deleted: "Deleted" } as const;


function FileRow({ f, pick, selected, onSelect, onToggle }: { f: ChangesetFile; pick: FilePick; selected: boolean; onSelect: () => void; onToggle: (on: boolean) => void }) {
  const Icon = STATUS_ICON[f.status];
  const { added, removed } = lineCounts(f);
  const open = isOpen(f);
  const partial = hunkPicking(f) && pick.edited === null && pick.hunks.length > 0 && pick.hunks.length < f.hunks.length;
  return (
    <li>
      <div className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${selected ? "bg-surface-2" : "hover:bg-surface-2/60"}`}>
        <input
          type="checkbox"
          aria-label={`Include ${f.file}`}
          className="mt-1"
          disabled={!open}
          checked={open ? pick.include : f.state === "applied"}
          ref={(el) => {
            if (el) el.indeterminate = open && pick.include && partial;
          }}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-1.5 text-[13px]">
            <Icon size={13} className={f.status === "added" ? "text-emerald-400" : f.status === "deleted" ? "text-danger" : "text-accent"} />
            <span className={`truncate font-mono text-[12px] ${open ? "" : "text-muted line-through decoration-transparent"}`}>{f.file}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted">
            <span>{STATUS_WORD[f.status]}</span>
            {f.status === "modified" && (
              <span>
                <span className="text-emerald-400">+{added}</span> <span className="text-danger">−{removed}</span>
              </span>
            )}
            {f.state === "applied" && <span className="text-emerald-400">Applied</span>}
            {f.state === "rejected" && <span>Rejected</span>}
            {f.conflict && open && (
              <span className="inline-flex items-center gap-0.5 text-amber-400">
                <GitMerge size={11} /> {f.state === "conflict" ? "Needs a manual pick" : "Changed since"}
              </span>
            )}
            {f.attention?.length ? (
              <span className="inline-flex items-center gap-0.5 text-amber-400">
                <TriangleAlert size={11} /> Needs your attention
              </span>
            ) : null}
          </span>
        </button>
      </div>
    </li>
  );
}

function FileDetail({ f, pick, onPick }: { f: ChangesetFile; pick: FilePick; onPick: (p: Partial<FilePick>) => void }) {
  const [reveal, setReveal] = useState<{ line: number; n: number } | null>(null);
  const dirty = useWorkspace((s) => s.status[f.file]?.dirty ?? false);
  const open = isOpen(f);
  const picking = hunkPicking(f) && pick.edited === null;
  const problem = pickProblem(f, pick);
  const rejecting = open && (!pick.include || (hunkPicking(f) && pick.edited === null && pick.hunks.length < f.hunks.length));
  const inConflict = f.state === "conflict";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-border px-3 py-2 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px]">{f.file}</span>
          <span className="text-xs text-muted">{STATUS_WORD[f.status]}</span>
        </div>
        {f.reason && <p className="leading-relaxed text-text/85">{f.reason}</p>}
        {f.attention?.map((a) => (
          <p key={a} className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[12px]">
            <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber-400" /> {a}
          </p>
        ))}
        {open && f.changedOnDisk && !inConflict && (
          <p className="text-[12px] text-muted">
            {f.conflict
              ? "This file changed since the agent read it, and the changes overlap. Applying will ask you to pick what to keep."
              : "This file changed since the agent read it. Your changes and the agent's are merged when you apply."}
          </p>
        )}
        {open && dirty && <p className="text-[12px] text-muted">You have unsaved edits in this file. They're saved first, then merged.</p>}
        {inConflict && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className="text-amber-400">Your file and the agent's change overlap. Edit the text below (remove the {"<<<<<<< ======= >>>>>>>"} lines), or:</span>
            <Button className="!h-7 !text-xs" onClick={() => onPick({ include: false, edited: null })}>
              Keep my version
            </Button>
            {f.newText !== null && (
              <Button className="!h-7 !text-xs" onClick={() => onPick({ include: true, edited: f.newText })}>
                Use the agent's version
              </Button>
            )}
          </div>
        )}
        {picking && open && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
            {f.hunks.map((h, i) => (
              <li key={h.index} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  aria-label={`Change ${i + 1}: ${hunkLabel(h)}`}
                  checked={pick.include && pick.hunks.includes(h.index)}
                  onChange={(e) => {
                    const hunks = e.target.checked ? [...new Set([...pick.hunks, h.index])] : pick.hunks.filter((x) => x !== h.index);
                    onPick({ hunks, include: hunks.length > 0 || pick.include });
                  }}
                />
                <button type="button" className="text-muted hover:text-text" onClick={() => setReveal({ line: hunkRevealLine(h, f.hunks, pick.include ? pick.hunks : []), n: Date.now() })}>
                  {i + 1}. {hunkLabel(h)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {pick.edited !== null && !inConflict && open && (
          <p className="flex items-center gap-2 text-[12px] text-muted">
            You edited the agent's version; your text is what gets written.
            <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => onPick({ edited: null })}>
              <Undo2 size={12} /> Undo my edits
            </button>
          </p>
        )}
        {rejecting && (
          <label className="flex items-center gap-2 text-[12px] text-muted">
            Why not? (optional)
            <input
              value={pick.reason}
              onChange={(e) => onPick({ reason: e.target.value })}
              placeholder="e.g. Keep British spelling"
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-text outline-none focus:border-accent"
            />
          </label>
        )}
        {problem && <p className="text-[12px] text-danger">{problem}</p>}
      </div>
      <div className="min-h-0 flex-1">
        {inConflict && f.mergedText != null ? (
          <MergeEditor path={f.file} text={pick.edited ?? f.mergedText} onEdit={(t) => onPick({ edited: t, include: true })} />
        ) : (
          <DiffView
            path={f.file}
            original={f.baseText ?? ""}
            modified={open ? (pickedText(f, pick) ?? "") : (f.newText ?? "")}
            readOnly={!open || f.status === "deleted" || inConflict}
            onEdit={(t) => onPick({ edited: t, include: true })}
            reveal={reveal}
          />
        )}
      </div>
    </div>
  );
}

function MemoryOffer({ project, notes, onDone }: { project: string; notes: string[]; onDone: () => void }) {
  const [items, setItems] = useState(notes.map((text) => ({ text, on: true })));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      for (const n of items) if (n.on && n.text.trim()) await memoryApi.add(project, n.text.trim());
      toast("Saved to the project memory. Agents read it next time.");
      onDone();
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-t border-border bg-surface-2/50 px-4 py-3 text-sm">
      <p className="font-medium">Remember this for next time?</p>
      <p className="text-xs text-muted">Agents read the project memory before they start. You can view or edit it in Settings ▸ AI ▸ Memory.</p>
      {items.map((n, i) => (
        <label key={i} className="flex items-center gap-2">
          <input type="checkbox" checked={n.on} onChange={(e) => setItems((xs) => xs.map((x, k) => (k === i ? { ...x, on: e.target.checked } : x)))} />
          <input
            value={n.text}
            onChange={(e) => setItems((xs) => xs.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-[13px] outline-none focus:border-accent"
          />
        </label>
      ))}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>No thanks</Button>
        <Button variant="primary" disabled={busy || !items.some((n) => n.on && n.text.trim())} onClick={() => void save()}>
          Remember
        </Button>
      </div>
    </div>
  );
}

type Confirm = { kind: "attention"; decisions: Decision[]; files: string[] } | { kind: "discard"; count: number };

export function ChangesetDialog({ project, runId, onClose }: { project: string; runId: string; onClose: () => void }) {
  const run = useRuns((s) => s.runs[runId]);
  const [cs, setCs] = useState<Changeset | null>(null);
  const [picks, setPicks] = useState<Record<string, FilePick>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);

  const shown = useRef<Changeset | null>(null);
  const loadSeq = useRef(0);
  // While a refetch is out, Apply waits: the picks may be about to change.
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setRefreshing(true);
    try {
      const next = await agentsApi.changeset(project, runId);
      // An older answer must not replace a newer one.
      if (seq !== loadSeq.current) return;
      const prev = shown.current;
      shown.current = next;
      setPicks((before) => carryPicks(next, before, prev));
      setCs(next);
      setCurrent((c) => (c && next.files.some((f) => f.file === c) ? c : (next.files.find(isOpen) ?? next.files[0])?.file ?? null));
      setError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(errorText(e));
    } finally {
      if (seq === loadSeq.current) setRefreshing(false);
    }
  }, [project, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The agent may still be writing while this is open: refetch whenever the
  // run moves on (a step, a file, finishing), so what you apply is what you saw (FE-1).
  const seenRun = useRef(run);
  useEffect(() => {
    const before = seenRun.current;
    seenRun.current = run;
    if (changesetStale(before, run)) void load();
  }, [run, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !confirm) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirm]);

  const files = cs?.files ?? [];
  const openFiles = files.filter(isOpen);
  const file = files.find((f) => f.file === current) ?? null;
  const decisions = useMemo(() => (cs ? selectedDecisions(cs.files, picks) : []), [cs, picks]);
  const accepting = decisions.filter((d) => d.accept).length;
  const unresolved = openFiles.filter((f) => picks[f.file] && !decisionFor(f, picks[f.file])).length;
  const live = run ? run.status === "running" || run.status === "queued" || run.status === "awaiting_input" : false;

  const report = (r: ApplyResult, sent: Decision[]) => {
    const parts: string[] = [];
    const changed = r.written.length + r.deleted.length;
    if (changed) parts.push(`Applied ${changed} file${changed === 1 ? "" : "s"}`);
    if (r.rejected.length) parts.push(`left out ${r.rejected.length}`);
    if (r.conflicts.length) parts.push(`${r.conflicts.length} need${r.conflicts.length === 1 ? "s" : ""} a manual pick`);
    if (parts.length) toast(`${parts.join(", ")}.`, r.conflicts.length ? "info" : "success");
    if (r.historyError) toast(`The files were written, but History couldn't record it: ${r.historyError}`, "error");
    const memo = reasonNotes(files, sent);
    const remaining = r.conflicts.length > 0 || r.run.pendingFiles > 0 || r.run.conflictFiles > 0;
    if (memo.length) setNotes(memo);
    else if (!remaining) onClose();
  };

  const apply = async (sent: Decision[], checkAttention = true) => {
    if (!sent.length) return;
    const flagged = sent.filter((d) => d.accept && files.find((f) => f.file === d.file)?.attention?.length).map((d) => d.file);
    if (checkAttention && flagged.length) {
      setConfirm({ kind: "attention", decisions: sent, files: flagged });
      return;
    }
    setBusy(true);
    try {
      const r = await applyDecisions(project, runId, sent);
      await load();
      report(r, sent);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const acceptAllDecisions = (): Decision[] =>
    openFiles.flatMap((f) => {
      const p = picks[f.file] ?? initialPick(f);
      // Resolved conflicts keep their resolution; unresolved ones stay for a manual pick.
      if (f.state === "conflict") return p.edited !== null && !pickProblem(f, { ...p, include: true }) ? [{ file: f.file, accept: true, editedText: p.edited }] : [];
      return [{ file: f.file, accept: true }];
    });

  const discard = async () => {
    setBusy(true);
    try {
      const summary = await agentsApi.discard(project, runId);
      useRuns.getState().noteRun(summary);
      toast("The agent's changes were discarded.");
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  };

  const setPick = (name: string, p: Partial<FilePick>) => setPicks((all) => ({ ...all, [name]: { ...(all[name] ?? initialPick(files.find((f) => f.file === name)!)), ...p } }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div role="dialog" aria-modal="true" aria-label="Review changes" className="texo-pop flex h-full max-h-[56rem] w-full max-w-[90rem] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">Review changes{run?.title ? `: ${run.title}` : ""}</h2>
            <p className="text-xs text-muted">
              {cs ? `${openFiles.length} of ${files.length} file${files.length === 1 ? "" : "s"} to decide` : "Loading…"}
              {run?.profileName || run?.model ? ` · ${[run?.profileName, run?.model].filter(Boolean).join(" · ")}` : ""}
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text">
            <X size={16} />
          </button>
        </header>

        {error ? (
          <p className="m-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">{error}</p>
        ) : !cs ? (
          <p className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" /> Loading the changes…
          </p>
        ) : files.length === 0 ? (
          <p className="flex flex-1 items-center justify-center text-sm text-muted">This run didn't change any files.</p>
        ) : (
          <div className="flex min-h-0 flex-1">
            <ul className="w-72 shrink-0 overflow-y-auto border-r border-border p-1.5">
              {files.map((f) => (
                <FileRow
                  key={f.file}
                  f={f}
                  pick={picks[f.file] ?? initialPick(f)}
                  selected={f.file === current}
                  onSelect={() => setCurrent(f.file)}
                  onToggle={(on) => {
                    setCurrent(f.file);
                    setPick(f.file, on ? { include: true, hunks: (picks[f.file]?.hunks.length ? picks[f.file].hunks : f.hunks.map((h) => h.index)) } : { include: false });
                  }}
                />
              ))}
            </ul>
            {file ? <FileDetail key={file.file} f={file} pick={picks[file.file] ?? initialPick(file)} onPick={(p) => setPick(file.file, p)} /> : <div className="flex-1" />}
          </div>
        )}

        {notes ? (
          <MemoryOffer
            project={project}
            notes={notes}
            onDone={() => {
              setNotes(null);
              if (!openFiles.length) onClose();
            }}
          />
        ) : (
          <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
            <p className="mr-auto text-xs text-muted">
              {live
                ? "The agent is still working. You can apply its changes once it finishes."
                : unresolved
                  ? `${unresolved} file${unresolved === 1 ? "" : "s"} still need${unresolved === 1 ? "s" : ""} a pick and will wait.`
                  : "Applied changes are recorded in History, so you can undo them."}
            </p>
            <Button variant="ghost" disabled={busy || live || refreshing || !openFiles.length} onClick={() => setConfirm({ kind: "discard", count: openFiles.length })}>
              Discard
            </Button>
            <Button disabled={busy || live || refreshing || !openFiles.length} onClick={() => void apply(acceptAllDecisions())}>
              Accept all
            </Button>
            <Button variant="primary" disabled={busy || live || refreshing || decisions.length === 0} onClick={() => void apply(decisions)}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              {accepting === decisions.length ? "Apply selected" : `Apply selected (${accepting} in, ${decisions.length - accepting} out)`}
            </Button>
          </footer>
        )}
      </div>

      {confirm?.kind === "discard" && (
        <ConfirmDialog
          title="Discard these changes?"
          danger
          confirmLabel="Discard"
          message={`The agent's changes to ${confirm.count} file${confirm.count === 1 ? "" : "s"} won't be applied, and you can't get them back from this run. Your files stay as they are.`}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void discard();
          }}
        />
      )}
      {confirm?.kind === "attention" && (
        <ConfirmDialog
          title="Apply changes that need your attention?"
          confirmLabel="Apply anyway"
          message={
            <>
              <p>Texo flagged changes that may hide a problem instead of fixing it:</p>
              <ul className="mt-2 space-y-1">
                {confirm.files.map((name) => (
                  <li key={name}>
                    <span className="font-mono text-[12px] text-text">{name}</span>: {files.find((f) => f.file === name)?.attention?.join(" ")}
                  </li>
                ))}
              </ul>
            </>
          }
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const d = confirm.decisions;
            setConfirm(null);
            void apply(d, false);
          }}
        />
      )}
    </div>
  );
}
