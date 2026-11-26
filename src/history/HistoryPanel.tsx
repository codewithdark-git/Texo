// The "History" tab in the left sidebar: every saved version of the project,
// grouped by day, with AI runs folded into one group each. Opening a version
// lists its files; a file opens a diff. Restoring and undoing always make a
// new version, so nothing in history is ever lost.

import { useEffect, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FileClock,
  History as HistoryIcon,
  Loader2,
  MoreHorizontal,
  Power,
  RotateCcw,
  Save,
  Tag,
  TriangleAlert,
  Undo2,
  User,
  X,
} from "lucide-react";
import { Button, ConfirmDialog, Modal, PromptDialog } from "../components/Dialog";
import { Menu } from "../components/Menu";
import { Choice } from "../components/settingsControls";
import { historyStatusText as statusText, type HistoryAuthorFilter, type HistoryEntry } from "../lib/historyApi";
import { HistoryDiffDialog } from "./HistoryDiffDialog";
import { useWorkspace } from "../workspace/store";
import { baseName, canUndoRun, entryTitle, groupTimeline, reasonText, timeText, undoOutcome, type RunGroup, type UndoOutcome } from "./historyLogic";
import { useHistory } from "./historyStore";

type Ask =
  | { type: "restoreAll"; entry: HistoryEntry }
  | { type: "undo"; group: RunGroup }
  | { type: "label"; entry: HistoryEntry }
  | { type: "off" };

export function HistoryPanel() {
  const { project, status, entries, more, author, path, loading, error, busy } = useHistory();
  const activeFile = useWorkspace((s) => s.active);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [ask, setAsk] = useState<Ask | null>(null);
  const [undone, setUndone] = useState<UndoOutcome | null>(null);
  const [diff, setDiff] = useState<{ entry: HistoryEntry; file: string } | null>(null);
  const count = status?.count ?? 0;

  // Reload when the panel opens and whenever a new version appears.
  useEffect(() => {
    if (project) void useHistory.getState().load();
  }, [project, count]);

  const days = groupTimeline(entries);
  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const st = useHistory.getState();

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[13px]">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Choice<HistoryAuthorFilter>
          label="Show versions by"
          value={author}
          options={[
            ["all", "All"],
            ["you", "You"],
            ["ai", "AI"],
          ]}
          onChange={(v) => st.setAuthor(v)}
        />
        <span className="flex-1" />
        <button
          type="button"
          title="Save a version now"
          aria-label="Save a version now"
          disabled={!status?.active}
          onClick={() => void st.snapshot()}
          className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
        >
          <Save size={14} />
        </button>
        <Menu
          trigger={({ toggle }) => (
            <button type="button" aria-label="More history actions" onClick={toggle} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text">
              <MoreHorizontal size={14} />
            </button>
          )}
          items={[
            status?.enabled
              ? { label: "Turn history off for this project", icon: <Power size={14} />, onSelect: () => setAsk({ type: "off" }) }
              : { label: "Turn history on for this project", icon: <Power size={14} />, onSelect: () => void st.setEnabled(true) },
          ]}
        />
      </div>

      <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-[11px]">
        {path ? (
          <span className="flex min-w-0 flex-1 items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-accent" title={path}>
            <FileClock size={11} className="shrink-0" />
            <span className="min-w-0 truncate">History of {baseName(path)}</span>
            <button type="button" aria-label="Show the whole project's history" title="Show the whole project's history" onClick={() => st.setPath(null)} className="ml-auto shrink-0 rounded hover:bg-accent/20">
              <X size={11} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            disabled={!activeFile}
            title={activeFile ? `Only versions that changed ${activeFile}` : "Open a file to see its history"}
            onClick={() => activeFile && st.setPath(activeFile)}
            className="inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            <FileClock size={11} className="shrink-0" />
            <span className="truncate">History of this file{activeFile ? ` (${baseName(activeFile)})` : ""}</span>
          </button>
        )}
      </div>

      <Banners onTurnOn={() => void st.setEnabled(true)} />

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {error && <p className="px-2 py-2 text-xs text-danger">{error}</p>}
        {!error && entries.length === 0 && (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted">
            {loading ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> Loading history…
              </span>
            ) : status?.active ? (
              path ? (
                `No saved versions changed ${baseName(path)}${author === "all" ? "" : author === "ai" ? " by the AI" : " by you"}.`
              ) : author === "all" ? (
                "No versions yet. Texo saves one shortly after you edit, before each compile and before each AI run."
              ) : author === "ai" ? (
                "No changes by the AI yet."
              ) : (
                "No versions of your own edits yet."
              )
            ) : null}
          </p>
        )}
        {days.map((day) => (
          <section key={day.key} className="mb-2">
            <h3 className="sticky top-0 z-10 bg-surface px-1.5 py-1 text-[11px] font-medium tracking-wide text-muted uppercase">{day.label}</h3>
            <ul>
              {day.items.map((item) =>
                item.type === "entry" ? (
                  <EntryRow
                    key={item.entry.id}
                    entry={item.entry}
                    open={!!open[item.entry.id]}
                    onToggle={() => toggle(item.entry.id)}
                    onFile={(file) => setDiff({ entry: item.entry, file })}
                    onRestoreAll={() => setAsk({ type: "restoreAll", entry: item.entry })}
                    onLabel={() => setAsk({ type: "label", entry: item.entry })}
                    busy={busy}
                  />
                ) : (
                  <li key={`run-${item.runId}-${item.entries[0].id}`} className="my-0.5 rounded-md border border-border/60">
                    <button
                      type="button"
                      onClick={() => toggle(`run-${item.runId}`)}
                      aria-expanded={!!open[`run-${item.runId}`]}
                      className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
                    >
                      {open[`run-${item.runId}`] ? <ChevronDown size={13} className="mt-0.5 shrink-0" /> : <ChevronRight size={13} className="mt-0.5 shrink-0" />}
                      <Bot size={13} className="mt-0.5 shrink-0 text-accent" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{item.agent}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {timeText(item.entries[item.entries.length - 1].time)}
                          {item.model ? ` · ${item.model}` : ""}
                          {` · ${item.entries.length} ${item.entries.length === 1 ? "change" : "changes"}`}
                          {item.steps ? ` · ${item.steps} ${item.steps === 1 ? "step" : "steps"}` : ""}
                        </span>
                      </span>
                    </button>
                    {open[`run-${item.runId}`] && (
                      <div className="pb-1 pl-3">
                        {canUndoRun(item, entries) && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setAsk({ type: "undo", group: item })}
                            className="mb-0.5 ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50"
                          >
                            <Undo2 size={11} /> Undo this AI run
                          </button>
                        )}
                        <ul>
                          {item.entries.map((e) => (
                            <EntryRow
                              key={e.id}
                              entry={e}
                              open={!!open[e.id]}
                              onToggle={() => toggle(e.id)}
                              onFile={(file) => setDiff({ entry: e, file })}
                              onRestoreAll={() => setAsk({ type: "restoreAll", entry: e })}
                              onLabel={() => setAsk({ type: "label", entry: e })}
                              busy={busy}
                            />
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}
        {more && (
          <div className="px-1.5 py-2">
            <Button className="w-full justify-center" disabled={loading} onClick={() => void st.loadMore()}>
              {loading ? <Loader2 size={13} className="animate-spin" /> : null} Show older versions
            </Button>
          </div>
        )}
      </div>

      {diff && <HistoryDiffDialog entry={diff.entry} file={diff.file} onClose={() => setDiff(null)} />}
      {ask?.type === "restoreAll" && (
        <ConfirmDialog
          title="Restore the project to this version?"
          message={
            <>
              Every file goes back to how it was on {new Date(ask.entry.time * 1000).toLocaleString()}. Files added since then are removed from the
              folder. Your current files are saved in history first, so you can come back to them.
            </>
          }
          confirmLabel="Restore project"
          danger
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const id = ask.entry.id;
            setAsk(null);
            void st.restoreAll(id);
          }}
        />
      )}
      {ask?.type === "undo" && (
        <ConfirmDialog
          title="Undo this AI run?"
          message={
            <>
              Texo takes back the changes made by {ask.group.agent}. Files you changed yourself after the AI did are left as they are. This is saved as a
              new version, so it can be undone too.
            </>
          }
          confirmLabel="Undo the run"
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const id = ask.group.runId;
            setAsk(null);
            void st.undoRun(id).then((r) => {
              const outcome = r && undoOutcome(r);
              if (outcome && outcome.tone === "partial") setUndone(outcome);
            });
          }}
        />
      )}
      {undone && <UndoResultDialog outcome={undone} onClose={() => setUndone(null)} />}
      {ask?.type === "label" && (
        <PromptDialog
          title="Add a label"
          label="Name this version, e.g. “Submitted to NeurIPS”"
          confirmLabel="Add label"
          onClose={() => setAsk(null)}
          onSubmit={(name) => {
            const id = ask.entry.id;
            setAsk(null);
            void st.label(id, name);
          }}
        />
      )}
      {ask?.type === "off" && (
        <ConfirmDialog
          title="Turn history off?"
          message="Texo stops saving versions of this project, so AI changes can't be undone from History. The versions saved so far are kept and come back when you turn it on again."
          confirmLabel="Turn off"
          danger
          onClose={() => setAsk(null)}
          onConfirm={() => {
            setAsk(null);
            void st.setEnabled(false);
          }}
        />
      )}
    </div>
  );
}

/** After a partial undo: which files were left alone (you edited them later) and which couldn't be written. */
function UndoResultDialog({ outcome, onClose }: { outcome: UndoOutcome; onClose: () => void }) {
  const list = (files: string[]) => (
    <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-surface-2/50 px-2 py-1">
      {files.map((f) => (
        <li key={f} className="truncate font-mono text-xs" title={f}>
          {f}
        </li>
      ))}
    </ul>
  );
  return (
    <Modal title="Some changes weren't undone" onClose={onClose}>
      <p className="text-sm leading-relaxed">{outcome.text}</p>
      {outcome.conflicts.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium">
            <TriangleAlert size={14} className="text-amber-400" /> Left as they are (you edited them after the AI did)
          </p>
          {list(outcome.conflicts)}
          <p className="mt-1 text-xs text-muted">To take back the AI's part in these, open the AI's version in History, compare it with now, and restore or edit each file.</p>
        </div>
      )}
      {outcome.failed.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="font-medium text-danger">Left as they are (open in another app, read-only, or too big for history)</p>
          {list(outcome.failed)}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="primary" autoFocus onClick={onClose}>
          OK
        </Button>
      </div>
    </Modal>
  );
}

function Banners({ onTurnOn }: { onTurnOn: () => void }) {
  const status = useHistory((s) => s.status);
  const answer = useHistory((s) => s.answerGitExclude);
  if (!status) return null;
  const box = "mx-2 mt-2 rounded-lg border px-2.5 py-2 text-xs leading-relaxed";
  return (
    <>
      {status.readOnly ? (
        <div role="status" className={`${box} border-amber-500/40 bg-amber-500/10`}>
          <TriangleAlert size={12} className="mr-1 inline text-amber-400" />
          This folder can't be written to, so Texo can't keep its history. Move the project to a folder you can edit to turn it on.
        </div>
      ) : !status.enabled ? (
        <div role="status" className={`${box} border-border bg-surface-2/60`}>
          History is off for this project. AI changes can't be undone from here.
          <div className="mt-1.5">
            <Button onClick={onTurnOn}>Turn history on</Button>
          </div>
        </div>
      ) : status.error ? (
        <div role="alert" className={`${box} border-danger/40 bg-danger/10`}>
          {status.error}
        </div>
      ) : null}
      {status.offerGitExclude && status.active && (
        <div role="status" className={`${box} border-accent/40 bg-accent/10`}>
          This project is also a git repository. Texo keeps its own history in the <code className="font-mono">.texo</code> folder; should git ignore that
          folder? (Texo adds it to <code className="font-mono">.git/info/exclude</code>, which isn't shared.)
          <div className="mt-1.5 flex gap-2">
            <Button variant="primary" onClick={() => void answer(true)}>
              Ignore .texo in git
            </Button>
            <Button onClick={() => void answer(false)}>No thanks</Button>
          </div>
        </div>
      )}
    </>
  );
}

function EntryRow({
  entry,
  open,
  onToggle,
  onFile,
  onRestoreAll,
  onLabel,
  busy,
}: {
  entry: HistoryEntry;
  open: boolean;
  onToggle: () => void;
  onFile: (file: string) => void;
  onRestoreAll: () => void;
  onLabel: () => void;
  busy: boolean;
}) {
  const changes = useHistory((s) => s.changes[entry.id]);
  useEffect(() => {
    if (open) void useHistory.getState().loadChanges(entry.id);
  }, [open, entry.id]);
  const why = reasonText(entry.reason);
  const Icon = entry.author === "ai" ? Bot : User;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={why ?? undefined}
        className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
      >
        <Icon size={13} className={`mt-0.5 shrink-0 ${entry.author === "ai" ? "text-accent" : "text-muted"}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{entryTitle(entry)}</span>
          <span className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
            {timeText(entry.time)}
            {entry.labels.map((l) => (
              <span
                key={l.name}
                className={`inline-flex items-center gap-0.5 rounded px-1 ${l.auto ? "bg-emerald-500/15 text-emerald-400" : "bg-accent/15 text-accent"}`}
              >
                <Tag size={9} /> {l.name}
              </span>
            ))}
          </span>
        </span>
      </button>
      {open && (
        <div className="mb-1 ml-5 border-l border-border pl-2">
          {changes === undefined || changes === "loading" ? (
            <p className="flex items-center gap-1 py-1 text-[11px] text-muted">
              <Loader2 size={11} className="animate-spin" /> Loading files…
            </p>
          ) : "error" in changes ? (
            <p className="py-1 text-[11px] text-danger">{changes.error}</p>
          ) : changes.length === 0 ? (
            <p className="py-1 text-[11px] text-muted">No files changed in this version.</p>
          ) : (
            <ul className="py-0.5">
              {changes.map((c) => (
                <li key={c.file}>
                  <button
                    type="button"
                    onClick={() => onFile(c.file)}
                    title={c.binary ? "A binary file: it can be restored, but not compared" : "Show the changes"}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-surface-2"
                  >
                    <span
                      className={`w-3 shrink-0 font-mono text-[10px] ${c.status === "added" ? "text-emerald-400" : c.status === "deleted" ? "text-danger" : "text-amber-400"}`}
                      aria-label={c.status}
                    >
                      {c.status === "added" ? "A" : c.status === "deleted" ? "D" : "M"}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{c.file}</span>
                    {!c.binary && (
                      <span className="shrink-0 font-mono text-[10px] text-muted">
                        <span className="text-emerald-400">+{c.additions}</span> <span className="text-danger">−{c.deletions}</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-1 py-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={onRestoreAll}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50"
            >
              <RotateCcw size={11} /> Restore project to here
            </button>
            <button type="button" onClick={onLabel} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-text">
              <Tag size={11} /> Add label
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** "History on · 42 versions" in the status bar; a click opens the History tab. */
export function HistoryStatusItem({ onOpen }: { onOpen: () => void }) {
  const status = useHistory((s) => s.status);
  const text = useHistory((s) => (s.status ? statusText(s.status) : ""));
  if (!status) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={status.offerGitExclude ? "Texo has a question about this project's git repository. Click to open History." : "Every saved version of this project. Click to open History."}
      className={`flex shrink-0 items-center gap-1 rounded px-1 hover:bg-surface-2 hover:text-text ${status.active ? "" : "text-amber-400"}`}
    >
      <HistoryIcon size={11} /> {text}
      {status.offerGitExclude && status.active && <span aria-label="A question is waiting" className="h-1.5 w-1.5 rounded-full bg-accent" />}
    </button>
  );
}
