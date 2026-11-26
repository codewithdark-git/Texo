// One file of one version: what that version changed (against the version
// before it) or how it differs from the file now. "Restore this file" puts
// that version back; the current text is saved in history first.

import { useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button, ConfirmDialog, Modal } from "../components/Dialog";
import { Choice } from "../components/settingsControls";
import { errorText } from "../lib/api";
import { HISTORY_DISK, historyApi, type HistoryDiff, type HistoryEntry } from "../lib/historyApi";
import { DiffView } from "../ai/agents/DiffEditors";
import { entryTitle } from "./historyLogic";
import { useHistory } from "./historyStore";

type Compare = "change" | "now";

export function HistoryDiffDialog({ entry, file, onClose }: { entry: HistoryEntry; file: string; onClose: () => void }) {
  const project = useHistory((s) => s.project);
  const busy = useHistory((s) => s.busy);
  const [compare, setCompare] = useState<Compare>("change");
  const [diff, setDiff] = useState<HistoryDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!project) return;
    let live = true;
    setDiff(null);
    setError(null);
    const req = compare === "change" ? historyApi.diff(project, null, entry.id, file) : historyApi.diff(project, entry.id, HISTORY_DISK, file);
    req.then(
      (d) => live && setDiff(d),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [project, entry.id, file, compare]);

  const when = new Date(entry.time * 1000).toLocaleString();
  const left = compare === "change" ? "Before this version" : `This version (${when})`;
  const right = compare === "change" ? `This version (${when})` : "The file now";
  // Restoring a version where the file was deleted would remove it; history covers that through "Restore project".
  const existsThere = compare === "change" ? diff?.newText != null : diff?.oldText != null;

  return (
    <Modal title={file} onClose={onClose} extraWide>
      <div className="-mt-2 mb-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span className="min-w-0 flex-1 truncate">
          {entryTitle(entry)} · {entry.authorName}
        </span>
        <Choice<Compare>
          label="Compare"
          value={compare}
          options={[
            ["change", "What changed"],
            ["now", "Compare with now"],
          ]}
          onChange={setCompare}
        />
      </div>
      <div className="mb-1 grid grid-cols-2 gap-2 text-[11px] text-muted">
        <span>{left}</span>
        <span>{right}</span>
      </div>
      <div className="h-[60vh] overflow-hidden rounded-lg border border-border">
        {error ? (
          <p className="p-3 text-sm text-danger">{error}</p>
        ) : !diff ? (
          <p className="flex items-center gap-2 p-3 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </p>
        ) : diff.binary ? (
          <p className="p-3 text-sm text-muted">This is a binary file (a picture or PDF, for example), so it can't be compared as text. You can still restore it.</p>
        ) : (
          <DiffView path={`history-${entry.id}-${compare}-${file}`} original={diff.oldText ?? ""} modified={diff.newText ?? ""} readOnly />
        )}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        {diff && !existsThere && <span className="mr-auto text-xs text-muted">The file didn't exist in this version.</span>}
        <Button disabled={busy || !diff || !existsThere} onClick={() => setConfirm(true)}>
          <RotateCcw size={14} /> Restore this file
        </Button>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Restore this file?"
          message={
            <>
              <span className="font-mono">{file}</span> goes back to how it was on {when}. Its current text is saved in history first, so you can come back to
              it.
            </>
          }
          confirmLabel="Restore file"
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void useHistory
              .getState()
              .restoreFile(entry.id, file)
              .then(onClose);
          }}
        />
      )}
    </Modal>
  );
}
