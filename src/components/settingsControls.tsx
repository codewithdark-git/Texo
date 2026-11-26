// The small building blocks of the Settings dialog, shared by its sections.
import type { ReactNode } from "react";

/** One labelled setting: the name and help on the left, the control on the right. */
export function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {help && <div className="mt-0.5 text-xs text-muted">{help}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition ${checked ? "bg-accent" : "bg-surface-2 ring-1 ring-border"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}

/** A small segmented control. */
export function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-border bg-surface-2/50 p-0.5">
      {options.map(([v, name]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-xs ${value === v ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{children}</h3>;
}
