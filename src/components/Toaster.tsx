import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useUi, type ToastKind } from "../ui";

const ICONS: Record<ToastKind, { icon: typeof Info; className: string }> = {
  success: { icon: CheckCircle2, className: "text-success" },
  info: { icon: Info, className: "text-accent" },
  error: { icon: AlertCircle, className: "text-danger" },
};

export function Toaster() {
  const toasts = useUi((s) => s.toasts);
  const { dismissToast: dismiss, removeToast, pauseToast, resumeToast } = useUi.getState();
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const { icon: Icon, className } = ICONS[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            // The timer waits while the pointer or focus is on the toast.
            onMouseEnter={() => pauseToast(t.id, "hover")}
            onMouseLeave={() => resumeToast(t.id, "hover")}
            onFocus={() => pauseToast(t.id, "focus")}
            // Moving between its own buttons keeps the hold.
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && resumeToast(t.id, "focus")}
            onAnimationEnd={(e) => t.leaving && e.target === e.currentTarget && removeToast(t.id)}
            className={`${t.leaving ? "texo-toast-out" : "texo-toast"} pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm shadow-xl`}
          >
            <Icon size={16} className={`mt-0.5 shrink-0 ${className}`} />
            <span className="flex-1 break-words">{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
                className="-my-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-sm font-medium text-accent hover:bg-surface-2"
              >
                {t.action.label}
              </button>
            )}
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-muted hover:text-text">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
