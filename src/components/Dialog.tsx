import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}

export function Modal({ title, children, onClose, wide }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`texo-pop w-full rounded-xl border border-border bg-surface p-5 shadow-2xl ${wide ? "max-w-2xl" : "max-w-md"}`}
      >
        <h2 className="mb-4 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const styles = {
    primary: "bg-accent text-accent-ink hover:bg-accent-strong font-medium",
    secondary: "bg-surface-2 text-text hover:brightness-110 border border-border",
    danger: "bg-danger text-white hover:brightness-110 font-medium",
    ghost: "text-muted hover:text-text hover:bg-surface-2",
  }[variant];
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm transition disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

interface PromptProps {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
  children?: ReactNode;
}

/** A small form dialog with one text field. */
export function PromptDialog({
  title,
  label,
  initial = "",
  confirmLabel,
  onSubmit,
  onClose,
  children,
}: PromptProps) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);

  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <label className="mb-1.5 block text-xs text-muted">{label}</label>
        <input
          ref={input}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-9 w-full rounded-lg border border-border bg-bg px-3 outline-none focus:border-accent"
        />
        {children}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: ConfirmProps) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm leading-relaxed text-muted">{message}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button autoFocus variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
