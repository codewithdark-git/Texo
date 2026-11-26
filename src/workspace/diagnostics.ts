// Pure helpers for the Issues panel's fatal-error diagnostics: the backend
// (texlog::diagnose) puts the error that stopped TeX first and flags the
// citations/references that are only undefined because of it. The panel
// shows those flagged ones in a collapsed group under the real problems.
import type { Issue } from "../lib/api";

export interface IssueGroups {
  /** The issues to show normally, in order. */
  main: Issue[];
  /** Undefined only because the compile stopped early; shown collapsed. */
  consequences: Issue[];
}

export function groupIssues(issues: Issue[]): IssueGroups {
  const main: Issue[] = [];
  const consequences: Issue[] = [];
  for (const issue of issues) (issue.consequence ? consequences : main).push(issue);
  return { main, consequences };
}

/** "Reference `fig:one' on page 1 undefined" → "fig:one" (as texlog::undefined_reference). */
function undefinedReference(message: string): string | null {
  if (!message.includes("undefined")) return null;
  const m = /Reference [`'](.*?)'/.exec(message);
  return m ? m[1] : null;
}

/** The heading of the collapsed group, e.g. "23 undefined citations and 1 undefined cross-reference are only here because the compile stopped early". Citations count once per key and cross-references once per label, as the backend's hint does. */
export function consequenceSummary(consequences: Issue[]): string {
  const citations = new Set(consequences.filter((i) => i.citation).map((i) => i.citation)).size;
  const labels = new Set<string>();
  let others = 0;
  for (const i of consequences) {
    if (i.citation) continue;
    const label = undefinedReference(i.message);
    if (label !== null) labels.add(label);
    else others += 1;
  }
  const references = labels.size;
  const parts: string[] = [];
  if (citations) parts.push(`${citations} undefined ${citations === 1 ? "citation" : "citations"}`);
  if (references) parts.push(`${references} undefined ${references === 1 ? "cross-reference" : "cross-references"}`);
  if (others) parts.push(`${others} ${citations || references ? "other " : ""}${others === 1 ? "warning" : "warnings"}`);
  if (!parts.length) return "";
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const verb = citations + references + others === 1 ? "is" : "are";
  return `${list} ${verb} only here because the compile stopped early`;
}
