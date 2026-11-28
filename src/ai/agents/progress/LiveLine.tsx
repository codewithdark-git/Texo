// What a run is doing this moment: the running tool in words ("Searching
// papers: …", with a gentle shimmer), its sources as chips, and the last line
// or two of the text the model streams. `compact` is one truncated line for
// the sidebar dock. Screen readers get the phase announcements instead (the
// Agents tab's live region), so nothing here is a live region.

import type { Activity } from "../../../lib/agentsApi";
import { plainSummary } from "../runsStore";
import { liveTail } from "./progressModel";
import { SourceChip } from "./SourceChip";

interface LiveLineProps {
  activity: Activity | null;
  /** The streamed text so far (its tail). */
  stream?: string;
  /** Said when nothing is running and nothing streams, such as "Waiting for a free slot". */
  idle?: string;
  compact?: boolean;
}

export function LiveLine({ activity, stream, idle, compact = false }: LiveLineProps) {
  const tail = liveTail(stream, compact ? 1 : 2).map(plainSummary);
  if (compact) {
    const text = activity?.label ?? tail[0] ?? idle;
    if (!text) return null;
    return <span className={`block truncate text-[11px] ${activity ? "texo-shimmer" : "text-muted"}`}>{text}</span>;
  }
  if (!activity && tail.length === 0 && !idle) return null;
  return (
    <div className="min-w-0 space-y-1">
      {activity ? (
        <div key={`${activity.tool}-${activity.startedAt}`} className="texo-fade-in min-w-0">
          <p className="flex min-w-0 items-center gap-1.5 text-[12px]">
            {activity.sub && <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] text-muted">{activity.sub}</span>}
            <span className="texo-shimmer truncate">{activity.label}</span>
          </p>
          {activity.detail && <p className="truncate text-[11px] text-muted">{activity.detail}</p>}
          {activity.sources && activity.sources.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {activity.sources.map((c) => (
                <SourceChip key={c.source} chip={c} />
              ))}
            </div>
          )}
        </div>
      ) : (
        tail.length === 0 && idle && <p className="text-[12px] text-muted">{idle}</p>
      )}
      {tail.length > 0 && (
        <div className="border-l-2 border-accent/30 pl-2 text-[11px] leading-snug text-muted">
          {tail.map((line, i) => (
            <p key={i} className={`truncate ${i === tail.length - 1 ? "text-text/80" : ""}`}>
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
