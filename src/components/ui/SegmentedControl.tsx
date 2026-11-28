// A row of mutually exclusive choices (Code / Split / PDF) with a pill that
// slides to the chosen one. It is a radio group: arrow keys, Home and End
// move the choice, and Tab leaves the row.
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { nextIndex, useIndicator } from "./Tabs";
import { Tooltip } from "./Tooltip";

export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Shown in the tooltip, such as "Ctrl+1". */
  shortcut?: string;
}

interface SegmentedControlProps<T extends string> {
  /** What the choice is, for screen readers ("Layout"). */
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Show only icons, with the label in a tooltip. */
  iconOnly?: boolean;
  className?: string;
}

/** Up and Down move like Right and Left, as in a native radio group. */
const KEYS: Record<string, string> = { ArrowDown: "ArrowRight", ArrowUp: "ArrowLeft" };

export function SegmentedControl<T extends string>({ label, options, value, onChange, iconOnly = false, className = "" }: SegmentedControlProps<T>) {
  const row = useRef<HTMLDivElement>(null);
  const indicator = useIndicator(row, [value, iconOnly, options.length]);
  const selected = options.findIndex((o) => o.value === value);

  const onKeyDown = (e: KeyboardEvent) => {
    const to = nextIndex(KEYS[e.key] ?? e.key, Math.max(0, selected), options.length);
    if (to === null) return;
    e.preventDefault();
    onChange(options[to].value);
    row.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };

  return (
    <div
      ref={row}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`relative flex rounded-lg border border-border bg-surface-2/50 p-0.5 ${className}`}
    >
      <span
        aria-hidden="true"
        style={indicator}
        className="texo-indicator pointer-events-none absolute inset-y-0.5 left-0 rounded-md bg-surface shadow-sm"
      />
      {options.map((o, i) => {
        const checked = i === selected;
        const button = (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={iconOnly ? o.label : undefined}
            // The chosen option takes focus; with none chosen, the first does.
            tabIndex={checked || (selected < 0 && i === 0) ? 0 : -1}
            data-selected={checked ? "" : undefined}
            onClick={() => onChange(o.value)}
            className={`relative z-10 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
              checked ? "text-text" : "text-muted hover:text-text"
            }`}
          >
            {o.icon && <span className="shrink-0">{o.icon}</span>}
            {!iconOnly && o.label}
          </button>
        );
        return iconOnly || o.shortcut ? (
          <Tooltip key={o.value} content={o.label} shortcut={o.shortcut}>
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
