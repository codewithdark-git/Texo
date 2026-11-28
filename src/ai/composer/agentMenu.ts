// The agents the AI Chat bar can start, kept apart from React so the rules
// are tested: the list (the built-ins and the user's own profiles), each
// one's "/slug", the "/" menu as you type, and what Enter does in agent
// mode: start the run straight away, or open the agent's setup dialog when
// it needs more than the typed words.

import type { AgentProfile, Attachment, StartRequest } from "../../lib/agentsApi";
import type { AgentDialog } from "../agents/dialogStore";
import { base64Of, MAX_RUN_ATTACHMENTS } from "../agents/runAttachments";
import type { DraftAttachment } from "../chat/chatStore";
import type { ReadyAttachment } from "../chat/readAttachment";

export type AgentIcon = "fix" | "review" | "respond" | "task" | "custom";

/** One agent in the "+" menu and the "/" menu. */
export interface AgentEntry {
  /** Stable key: "fix", "review", "respond", "task", or "profile:<id>". */
  id: string;
  /** What follows the "/" (lowercase letters, digits and dashes). */
  slug: string;
  label: string;
  hint: string;
  icon: AgentIcon;
  /** The run kind it starts. */
  kind: string;
  /** A custom agent from Settings ▸ AI ▸ Agents. */
  profile?: AgentProfile;
}

export const BUILT_IN_AGENTS: readonly AgentEntry[] = [
  { id: "fix", slug: "fix", label: "Fix compile errors", hint: "Compiles, fixes and checks again", icon: "fix", kind: "fixer" },
  { id: "review", slug: "review", label: "Review paper", hint: "Reviews it like a venue's reviewers", icon: "review", kind: "reviewer" },
  { id: "respond", slug: "respond", label: "Respond to reviewers", hint: "Plans and drafts your response letter", icon: "respond", kind: "rebuttal" },
  { id: "task", slug: "task", label: "Custom task", hint: "Tell it what to do, attach files", icon: "task", kind: "task" },
];

/** A name as a "/" command: "My Proof Checker!" → "my-proof-checker". */
export function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "agent";
}

/** The user's own profiles (not the built-ins, not chat), as the Agents tab's New task menu lists them. */
export function customProfiles(profiles: AgentProfile[]): AgentProfile[] {
  return profiles.filter((p) => p.source !== "builtin" && p.kind !== "chat");
}

/** Every agent the bar offers: the built-ins, then the custom ones, each with a slug of its own. */
export function agentEntries(profiles: AgentProfile[]): AgentEntry[] {
  const out: AgentEntry[] = [...BUILT_IN_AGENTS];
  const taken = new Set(out.map((a) => a.slug));
  for (const p of customProfiles(profiles)) {
    const base = slugOf(p.name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    out.push({ id: `profile:${p.id}`, slug, label: p.name, hint: p.description || "Your agent", icon: "custom", kind: String(p.kind), profile: p });
  }
  return out;
}

/**
 * The "/" command being typed: the box starts with "/" and the caret is in
 * the word after it (no space yet). Returns what follows the "/", or null.
 */
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith("/")) return null;
  const word = /^\/([\w-]*)/.exec(text)?.[1] ?? "";
  if (caret < 1 || caret > word.length + 1) return null;
  // "/fix" with more after it on the same word (e.g. "/fix.") isn't a command.
  const next = text.charAt(word.length + 1);
  if (next && !/\s/.test(next)) return null;
  return word.toLowerCase();
}

/** Agents for a "/" query: slugs that start with it first, then names or slugs that contain it. */
export function filterAgents(entries: AgentEntry[], query: string): AgentEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const starts = entries.filter((a) => a.slug.startsWith(q) || a.label.toLowerCase().startsWith(q));
  const contains = entries.filter((a) => !starts.includes(a) && (a.slug.includes(q) || a.label.toLowerCase().includes(q)));
  return [...starts, ...contains];
}

/** The text once a "/" command is picked: the command goes (it becomes the chip), the rest stays. */
export function dropSlash(text: string): string {
  return text.replace(/^\/[\w-]*\s?/, "");
}

/** An agent typed out in full ("/review " with the space), so the bar can switch to it. */
export function typedAgent(entries: AgentEntry[], text: string): AgentEntry | null {
  const m = /^\/([\w-]+)\s/.exec(text);
  if (!m) return null;
  return entries.find((a) => a.slug === m[1].toLowerCase()) ?? null;
}

/** A chat attachment as an agent run takes it (only ones that have been read). */
export function toRunAttachment(a: DraftAttachment): Attachment {
  if (a.kind === "image" && a.dataUrl) return { name: a.name, mime: a.mime ?? "image/jpeg", dataBase64: base64Of(a.dataUrl) };
  return { name: a.name, mime: a.mime ?? "text/plain", text: a.text ?? "" };
}

/** A chat attachment as the New task dialog lists it (only ones that have been read). */
export function toReadyAttachment(a: DraftAttachment): ReadyAttachment {
  const kind = a.kind ?? (a.dataUrl ? "image" : "text");
  const out: ReadyAttachment = { name: a.name, mime: a.mime ?? (kind === "image" ? "image/jpeg" : "text/plain"), kind, note: a.note ?? "" };
  if (kind === "image" && a.dataUrl) out.dataUrl = a.dataUrl;
  else out.text = a.text ?? "";
  return out;
}

/** Why the bar's attachments can't go with a run, or null when they can. */
export function runAttachmentsProblem(attachments: DraftAttachment[]): string | null {
  return attachments.length > MAX_RUN_ATTACHMENTS ? `You can attach up to ${MAX_RUN_ATTACHMENTS} files to one task. Remove some first.` : null;
}

/** What Enter does in agent mode. */
export type AgentAction = { type: "start"; request: StartRequest } | { type: "dialog"; dialog: AgentDialog };

/**
 * What starting an agent from the bar does, the same way the Agents tab's
 * New task menu and dialogs would:
 * - Fix compile errors (and custom fixers) start at once; the words, if any, go along as instructions.
 * - Review paper (and custom reviewers) open the review setup: a venue and reviewers must be picked.
 *   The words go into its Focus field.
 * - Respond to reviewers (and custom ones) open their dialog with the words and attachments, so an
 *   earlier Texo review and the model can still be picked.
 * - Custom task and other custom agents start at once with the words and attachments; with neither
 *   they open their dialog, which asks for them.
 */
export function agentAction(agent: AgentEntry, text: string, attachments: DraftAttachment[]): AgentAction {
  const prompt = text.trim();
  const readyDrafts = attachments.filter((a) => a.status === "ready");
  const ready = readyDrafts.map(toRunAttachment);
  const p = agent.profile;
  const withFiles = ready.length ? { attachments: ready } : {};
  const named = p && p.name ? { profileName: p.name } : {};
  const withPrompt = prompt ? { prompt } : {};

  if (agent.kind === "fixer") {
    return { type: "start", request: { kind: "fixer", profileId: p?.id ?? "fixer", prompt, ...withFiles, options: { title: p?.name || "Fix compile errors" } } };
  }
  if (agent.kind === "reviewer") {
    return { type: "dialog", dialog: { type: "review", profile: p ?? null, ...withPrompt } };
  }
  const kind = agent.kind === "rebuttal" ? "rebuttal" : "task";
  if (kind === "rebuttal" || (!prompt && !ready.length)) {
    const seeded = readyDrafts.length ? { attachments: readyDrafts.map(toReadyAttachment) } : {};
    return { type: "dialog", dialog: { type: "new", kind, profile: p ?? null, ...withPrompt, ...seeded } };
  }
  // A custom agent of a kind the bar doesn't know: the profile fills in the kind.
  const own = agent.kind !== "task" && p ? "" : "task";
  return { type: "start", request: { kind: own, profileId: p?.id ?? null, prompt, ...withFiles, options: { ...named } } };
}

/**
 * What the bar's agent button says: "Set up" when Enter would only open the
 * agent's setup dialog (reviewers, Respond to reviewers, a task with nothing
 * to go on), "Start" when it starts the run.
 */
export function agentStartLabel(agent: AgentEntry, text: string, attachments: DraftAttachment[]): { setup: boolean; short: string; full: string } {
  const setup = agentAction(agent, text, attachments).type === "dialog";
  const short = setup ? "Set up" : "Start";
  return { setup, short, full: `${short} ${agent.label}` };
}

/** The grey hint text in agent mode. */
export function agentPlaceholder(agent: AgentEntry): string {
  switch (agent.kind) {
    case "fixer":
      return "Anything the fixer should know (optional). Enter starts it.";
    case "reviewer":
      return "What the reviewers should look at (optional). Enter opens the setup.";
    case "rebuttal":
      return "Paste the reviews or attach them. Enter opens the setup.";
    default:
      return "What should the agent do? Enter starts it.";
  }
}
