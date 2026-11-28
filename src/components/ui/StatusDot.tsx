// A small coloured dot for a state: green for done, amber for waiting on you,
// red for failed. `pulse` makes it breathe gently (it holds still under
// reduced motion).

export type StatusTone = "success" | "warning" | "danger" | "info" | "accent" | "muted";

const TONES: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  accent: "text-accent",
  muted: "text-muted",
};

interface StatusDotProps {
  tone: StatusTone;
  pulse?: boolean;
  /** Says what the dot means to screen readers; leave it out when text next to it already does. */
  label?: string;
  className?: string;
}

export function StatusDot({ tone, pulse = false, label, className = "" }: StatusDotProps) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`inline-block size-2 shrink-0 rounded-full bg-current ${TONES[tone]} ${pulse ? "texo-pulse-dot" : ""} ${className}`}
    />
  );
}
