// Editing a simple tabular as a grid. Row and column changes and cell edits
// are spliced into the source with tabular.apply, so the table's spacing and
// rules stay as they were; Apply hands back the new source in one go.

import { useMemo, useState } from "react";
import { create } from "zustand";
import { Minus, Plus } from "lucide-react";
import { Button, Modal } from "../../components/Dialog";
import { tabular, type TabularOp } from "../core";

interface GridRequest {
  src: string;
  onApply(src: string): void;
}

export const useGridDialog = create<{ req: GridRequest | null; open(r: GridRequest): void; close(): void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  close: () => set({ req: null }),
}));

/** Applies tabular ops in order. */
function applyOps(src: string, ops: TabularOp[]): string {
  return ops.reduce((s, op) => tabular.apply(s, op), src);
}

export function GridDialog() {
  const req = useGridDialog((s) => s.req);
  const close = useGridDialog((s) => s.close);
  if (!req) return null;
  return <Grid key={req.src} req={req} close={close} />;
}

function Grid({ req, close }: { req: GridRequest; close(): void }) {
  const [src, setSrc] = useState(req.src);
  // Cell edits not yet spliced in, keyed "r,c" against the current src.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [caption, setCaption] = useState<string | null>(null);
  const model = useMemo(() => tabular.parse(src), [src]);
  if (!model) {
    return (
      <Modal title="Edit table" onClose={close}>
        <p className="text-sm text-muted">This table can't be edited as a grid. Use Edit as code instead.</p>
      </Modal>
    );
  }
  const cols = Math.max(1, ...model.rows.map((r) => r.cells.length));

  /** Splices pending cell edits into the source. */
  const flush = (s: string): string => {
    const ops: TabularOp[] = Object.entries(edits).map(([k, text]) => {
      const [r, c] = k.split(",").map(Number);
      return { kind: "setCell", r, c, text };
    });
    return applyOps(s, ops);
  };
  const structural = (op: TabularOp) => {
    setSrc(tabular.apply(flush(src), op));
    setEdits({});
  };
  const apply = () => {
    let out = flush(src);
    if (caption !== null && caption !== model.caption) out = tabular.apply(out, { kind: "setCaption", text: caption });
    if (out !== req.src) req.onApply(out);
    close();
  };

  return (
    <Modal title="Edit table" onClose={close} wide>
      <div className="max-h-[55vh] overflow-auto">
        <table className="border-separate border-spacing-1">
          <tbody>
            {model.rows.map((row, r) => (
              <tr key={r}>
                {Array.from({ length: cols }, (_, c) => {
                  const cell = row.cells[c];
                  const key = `${r},${c}`;
                  return (
                    <td key={c}>
                      <input
                        value={edits[key] ?? cell?.text ?? ""}
                        disabled={!cell}
                        onChange={(e) => setEdits((x) => ({ ...x, [key]: e.target.value }))}
                        className="h-8 w-32 rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-40"
                        aria-label={`Row ${r + 1}, column ${c + 1}`}
                      />
                    </td>
                  );
                })}
                <td>
                  <button
                    type="button"
                    title="Remove this row"
                    disabled={model.rows.length <= 1}
                    onClick={() => structural({ kind: "deleteRow", r })}
                    className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30"
                  >
                    <Minus size={14} />
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c} className="text-center">
                  <button
                    type="button"
                    title="Remove this column"
                    disabled={cols <= 1}
                    onClick={() => structural({ kind: "deleteCol", c })}
                    className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30"
                  >
                    <Minus size={14} />
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => structural({ kind: "insertRow", at: model.rows.length })}>
          <Plus size={14} /> Row
        </Button>
        <Button onClick={() => structural({ kind: "insertCol", at: cols })}>
          <Plus size={14} /> Column
        </Button>
        {model.caption !== null && (
          <label className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-muted">Caption</span>
            <input
              value={caption ?? model.caption}
              onChange={(e) => setCaption(e.target.value)}
              className="h-8 w-56 rounded-md border border-border bg-bg px-2 outline-none focus:border-accent"
            />
          </label>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={apply}>
          Apply
        </Button>
      </div>
    </Modal>
  );
}
