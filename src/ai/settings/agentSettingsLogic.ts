// Pure helpers for Settings > AI > Agents, Web and Memory. No React, no
// Tauri: tested in agentSettingsLogic.test.ts.

import type { AiModel } from "../../lib/api";
import type { AgentDefaults, AgentKindId, AgentProfile, ProfileScope, RoleModels, RoleSet } from "../../lib/agentsApi";

export const MAX_NAME_CHARS = 80;
export const MAX_INSTRUCTIONS_CHARS = 8000;
export const MAX_FALLBACKS = 8;
export const MAX_STEPS_LIMIT = 200;

export type Role = keyof RoleSet & ("agent" | "chat" | "vision" | "review");
export const ROLES: Role[] = ["agent", "chat", "vision", "review"];

export const ROLE_LABELS: Record<Role, { label: string; help: string }> = {
  agent: { label: "Agents", help: "Fixing errors, tasks and responses to reviewers: needs a model that is good with tools." },
  chat: { label: "Chat", help: "Quick answers in the chat. A fast model works best." },
  vision: { label: "Pictures", help: "Reads attached pictures when the main model can't see them." },
  review: { label: "Reviews", help: "Reviewing the paper: long reading, so a strong model with a big context." },
};

export const KIND_LABELS: Record<string, string> = {
  fixer: "Fix compile errors",
  reviewer: "Reviewer",
  rebuttal: "Response to reviewers",
  task: "Task agent",
  chat: "Chat",
};

export function kindLabel(kind: AgentKindId): string {
  return KIND_LABELS[kind] ?? kind;
}

/** The kind's own step limit (agents/kinds). */
export function defaultSteps(kind: AgentKindId): number {
  if (kind === "fixer") return 16;
  if (kind === "reviewer") return 40;
  return 24;
}

export const TOOL_LABELS: Record<string, { label: string; help: string }> = {
  list_files: { label: "List files", help: "See which files the project has." },
  read_file: { label: "Read files", help: "Read the project's files." },
  search: { label: "Search the project", help: "Find text in the project's files." },
  edit_file: { label: "Edit files", help: "Change parts of a file (you review every change)." },
  write_file: { label: "Write files", help: "Create or replace files (you review every change)." },
  delete_file: { label: "Delete files", help: "Suggest deleting a file (you review it)." },
  compile_check: { label: "Test compile", help: "Compile a private copy to check a fix. Your PDF isn't touched." },
  explain_log: { label: "Explain the log", help: "Texo's own plain-words explanation of compile errors." },
  search_papers: { label: "Search papers", help: "Search arXiv, Crossref and Semantic Scholar (and OpenAlex with a key)." },
  get_bibtex: { label: "Get BibTeX", help: "Fetch a citation's BibTeX by DOI or arXiv id." },
  verify_citation: { label: "Check citations", help: "Check that a .bib entry matches a real paper." },
  fetch_url: { label: "Open web pages", help: "Read a public web page or PDF." },
  web_search: { label: "Web search", help: "Search the web (only when set up under Web)." },
  read_memory: { label: "Read memory", help: "Read the project's notes for the agents." },
  remember: { label: "Remember", help: "Add a note to the project's memory." },
  submit_report: { label: "Hand in a report", help: "Finish with a structured report (reviews, response plans)." },
  propose_task: { label: "Suggest a task", help: "Suggest a task you can start with one click." },
};

export function toolLabel(name: string): { label: string; help: string } {
  return TOOL_LABELS[name] ?? { label: name.replace(/_/g, " "), help: "" };
}

/** The tools that count as checked: an empty list means all of the kind's tools. */
export function checkedTools(all: string[], selected: string[]): Set<string> {
  return new Set(selected.length ? selected.filter((t) => all.includes(t)) : all);
}

/** Toggles a tool. All checked again is stored as [] (all, including tools added later); the last tool can't be unchecked. */
export function toggleTool(all: string[], selected: string[], name: string): string[] {
  const on = checkedTools(all, selected);
  if (on.has(name)) {
    if (on.size <= 1) return selected;
    on.delete(name);
  } else on.add(name);
  const next = all.filter((t) => on.has(t));
  return next.length === all.length ? [] : next;
}

/** Model ids for a picker: the live list, plus any chosen ids it lacks (so a choice never vanishes). */
export function modelChoices(live: AiModel[] | null, chosen: (string | null | undefined)[]): { id: string; label: string; missing: boolean }[] {
  const out: { id: string; label: string; missing: boolean }[] = [];
  const seen = new Set<string>();
  for (const id of chosen) {
    const v = id?.trim();
    if (v && !seen.has(v.toLowerCase()) && !(live ?? []).some((m) => m.id.toLowerCase() === v.toLowerCase())) {
      out.push({ id: v, label: live ? `${v} (not in the list)` : v, missing: !!live });
      seen.add(v.toLowerCase());
    }
  }
  for (const m of live ?? []) {
    if (seen.has(m.id.toLowerCase())) continue;
    seen.add(m.id.toLowerCase());
    out.push({ id: m.id, label: m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id, missing: false });
  }
  return out;
}

/** Adds a fallback model (trimmed, no duplicates, not the main model, at most 8). */
export function addFallback(list: string[], id: string, main?: string | null): string[] {
  const v = id.trim();
  if (!v || list.includes(v) || v === (main ?? "").trim() || list.length >= MAX_FALLBACKS) return list;
  return [...list, v];
}

export function removeAt<T>(list: T[], i: number): T[] {
  return list.filter((_, k) => k !== i);
}

/** Moves item i one place up (towards the front: tried earlier). */
export function moveUp<T>(list: T[], i: number): T[] {
  if (i <= 0 || i >= list.length) return list;
  const next = [...list];
  [next[i - 1], next[i]] = [next[i], next[i - 1]];
  return next;
}

/** The role models for one provider, as the editor shows them. */
export function roleOf(defaults: AgentDefaults | null | undefined, provider: string, role: Role): RoleModels {
  const r = defaults?.roles?.[provider]?.[role];
  return { model: r?.model ?? "", fallbacks: r?.fallbacks ?? [], ...(r?.thinking != null ? { thinking: r.thinking } : {}) };
}

/** Defaults with one role of one provider replaced (an empty model removes it: the built-in default applies). */
export function withRole(defaults: AgentDefaults, provider: string, role: Role, next: RoleModels): AgentDefaults {
  const set: RoleSet = { ...(defaults.roles[provider] ?? {}) };
  if (next.model.trim()) set[role] = { model: next.model.trim(), fallbacks: next.fallbacks, ...(next.thinking != null ? { thinking: next.thinking } : {}) };
  else delete set[role];
  return { ...defaults, roles: { ...defaults.roles, [provider]: set } };
}

/** Plain-words problems that stop a profile from being saved (empty: fine). */
export function profileProblems(p: AgentProfile): string[] {
  const out: string[] = [];
  const name = p.name.trim();
  if (!name) out.push("Give the profile a name.");
  else if ([...name].length > MAX_NAME_CHARS) out.push(`The name can be at most ${MAX_NAME_CHARS} characters.`);
  if ([...p.instructions].length > MAX_INSTRUCTIONS_CHARS) out.push(`The instructions can be at most ${MAX_INSTRUCTIONS_CHARS} characters.`);
  if (p.maxSteps != null && (!Number.isInteger(p.maxSteps) || p.maxSteps < 1 || p.maxSteps > MAX_STEPS_LIMIT))
    out.push(`Steps must be a whole number between 1 and ${MAX_STEPS_LIMIT}.`);
  if (p.fallbackModels.length > MAX_FALLBACKS) out.push(`At most ${MAX_FALLBACKS} fallback models can be listed.`);
  return out;
}

/** Only the fields the backend stores, for comparing an edit with the saved profile. */
function stored(p: AgentProfile) {
  return {
    id: p.id,
    name: p.name.trim(),
    kind: p.kind,
    description: p.description.trim(),
    instructions: p.instructions.trim(),
    model: p.model?.trim() || null,
    fallbackModels: p.fallbackModels,
    tools: p.tools,
    autoApply: p.autoApply,
    maxSteps: p.maxSteps ?? null,
    thinking: p.thinking ?? null,
    vision: p.vision ?? null,
    review: p.review ?? null,
  };
}

export function profileChanged(a: AgentProfile, b: AgentProfile): boolean {
  return JSON.stringify(stored(a)) !== JSON.stringify(stored(b));
}

/** Where a save goes by default: the profile's own file; built-ins and new ones: all projects. */
export function defaultScope(p: AgentProfile, hasProject: boolean): ProfileScope {
  return p.source === "project" && hasProject ? "project" : "global";
}

/** The badge next to a profile's name. */
export function sourceLabel(p: AgentProfile): string {
  if (p.source === "builtin") return "Built-in";
  if (p.overridesBuiltin) return p.source === "project" ? "Built-in, changed for this project" : "Built-in, changed";
  return p.source === "project" ? "This project" : "All projects";
}

// ---------------------------------------------------------------------------
// Web and memory
// ---------------------------------------------------------------------------

/** A problem with a SearXNG address, or null. */
export function searxngProblem(url: string): string | null {
  const v = url.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "That doesn't look like a web address. It should start with https://";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "The address must start with https:// (or http:// for a server on this computer).";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "http:" && !local) return "Use https:// for a server on the internet. Plain http:// is only for a server on this computer.";
  if (u.username || u.password) return "Leave the user name and password out of the address.";
  return null;
}

export interface MemoryUsage {
  bytes: number;
  max: number;
  percent: number;
  over: boolean;
}

export function memoryUsage(bytes: number, max: number): MemoryUsage {
  const m = max > 0 ? max : 8192;
  return { bytes, max: m, percent: Math.min(100, Math.round((bytes / m) * 100)), over: bytes > m };
}

/** "3.2 KB of 8 KB" */
export function memorySizeText(u: MemoryUsage): string {
  const kb = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0).replace(/\.0$/, "")} KB`);
  return `${kb(u.bytes)} of ${kb(u.max)}`;
}
