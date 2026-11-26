// A confirmation shown in place (inside dialogs, where a second dialog would
// also close the first one on Escape).

import type { ReactNode } from "react";
import { Button } from "../../components/Dialog";

export function InlineConfirm({
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={confirmLabel}
      className={`mt-2 rounded-lg border px-3 py-2 text-xs ${danger ? "border-danger/40 bg-danger/10" : "border-accent/30 bg-accent/10"}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="leading-relaxed">{message}</div>
      <div className="mt-2 flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button autoFocus variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
