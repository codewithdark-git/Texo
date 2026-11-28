// A grey placeholder shaped like content that is still loading. It pulses
// softly (and holds still under reduced motion). Screen readers skip it, so
// say "Loading…" somewhere they can hear.

interface SkeletonProps {
  /** Size and shape, such as "h-4 w-32". One text line by default. */
  className?: string;
  /** Draws this many text lines, the last one shorter. */
  lines?: number;
}

export function Skeleton({ className = "h-3 w-full", lines = 1 }: SkeletonProps) {
  if (lines <= 1) return <span aria-hidden="true" className={`texo-skeleton block ${className}`} />;
  return (
    <span aria-hidden="true" className="flex flex-col gap-1.5">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className={`texo-skeleton block h-3 ${i === lines - 1 ? "w-3/5" : "w-full"}`} />
      ))}
    </span>
  );
}
