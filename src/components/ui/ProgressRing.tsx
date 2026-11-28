// A small circular progress indicator. With a `value` (0 to 1) the arc fills
// to match; without one it spins, for work whose length isn't known.

/** Clamps to 0..1, treating anything that isn't a number as 0. */
export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** A number short enough for markup. */
const short = (n: number) => Math.round(n * 1000) / 1000;

/** The circle's radius, circumference and dash offset for `value` (a quarter arc when there is none). */
export function ringGeometry(size: number, stroke: number, value?: number) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = value === undefined ? c * 0.75 : c * (1 - clamp01(value));
  return { r: short(r), c: short(c), offset: short(offset) };
}

interface ProgressRingProps {
  /** How far along, from 0 to 1. Leave it out when that isn't known. */
  value?: number;
  /** Diameter in px. */
  size?: number;
  stroke?: number;
  /** What is in progress, for screen readers. */
  label?: string;
  /** Colour of the arc, as a text-* class. */
  tone?: string;
  className?: string;
}

export function ProgressRing({ value, size = 16, stroke = 2, label = "Progress", tone = "text-accent", className = "" }: ProgressRingProps) {
  const known = value !== undefined && value !== null && !Number.isNaN(value);
  const { r, c, offset } = ringGeometry(size, stroke, known ? value : undefined);
  const mid = size / 2;
  return (
    <svg
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? Math.round(clamp01(value) * 100) : undefined}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`shrink-0 ${tone} ${known ? "" : "texo-ring-indeterminate"} ${className}`}
    >
      <circle className="texo-ring-track" cx={mid} cy={mid} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
      <circle
        className="texo-ring-value"
        cx={mid}
        cy={mid}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        // Start at twelve o'clock.
        transform={`rotate(-90 ${mid} ${mid})`}
      />
    </svg>
  );
}
