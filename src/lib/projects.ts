import type { ProjectSummary } from "./api";

export type SortKey = "name" | "lastEdited" | "createdAt";
export type SortDir = "asc" | "desc";

export function filterProjects(projects: ProjectSummary[], query: string): ProjectSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter(
    (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortProjects(
  projects: ProjectSummary[],
  key: SortKey,
  dir: SortDir,
): ProjectSummary[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...projects].sort((a, b) => {
    const order =
      key === "name"
        ? collator.compare(a.name, b.name)
        : Date.parse(a[key]) - Date.parse(b[key]);
    return order * sign || collator.compare(a.name, b.name);
  });
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or a date. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.max(0, (now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, {
    year: then.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** `base`, or `base 2`, `base 3`… so a new project doesn't repeat an existing name. */
export function uniqueName(base: string, taken: string[]): string {
  const names = new Set(taken.map((n) => n.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}
