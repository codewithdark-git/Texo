import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useUi, type ToastKind } from "../ui";

const ICONS: Record<ToastKind, { icon: typeof Info; className: string }> = {
  success: { icon: CheckCircle2, className: "text-emerald-400" },
  info: { icon: Info, className: "text-accent" },
  error: { icon: AlertCircle, className: "text-danger" },
};

export function Toaster() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const { icon: Icon, className } = ICONS[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className="texo-toast pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm shadow-xl"
          >
            <Icon size={16} className={`mt-0.5 shrink-0 ${className}`} />
            <span className="flex-1 break-words">{t.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-muted hover:text-text">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
