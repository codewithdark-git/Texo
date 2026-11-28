// A thin progress bar. With `value` it fills to `value / max` (say, 3 of 12
// citations checked); without one it shows a sliding segment.
import { clamp01 } from "./ProgressRing";

interface ProgressBarProps {
  value?: number;
  /** What `value` counts up to; 1 by default, so `value` can be a fraction. */
  max?: number;
  /** What is in progress, for screen readers. */
  label?: string;
  /** Colour of the fill, as a bg-* class. */
  tone?: string;
  className?: string;
}

export function ProgressBar({ value, max = 1, label = "Progress", tone = "bg-accent", className = "" }: ProgressBarProps) {
  const known = value !== undefined && !Number.isNaN(value) && max > 0;
  const fraction = known ? clamp01(value / max) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? Math.round(fraction * 100) : undefined}
      aria-valuetext={known && max !== 1 ? `${value} of ${max}` : undefined}
      className={`h-1 w-full overflow-hidden rounded-full bg-surface-2 ${className}`}
    >
      {known ? (
        <div className={`texo-bar-value h-full rounded-full ${tone}`} style={{ width: `${Math.round(fraction * 1000) / 10}%` }} />
      ) : (
        <div className={`texo-bar-indeterminate h-full rounded-full ${tone}`} />
      )}
    </div>
  );
}
