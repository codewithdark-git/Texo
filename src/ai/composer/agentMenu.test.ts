import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../../lib/agentsApi";
import type { DraftAttachment } from "../chat/chatStore";
import {
  agentAction,
  agentEntries,
  agentStartLabel,
  BUILT_IN_AGENTS,
  customProfiles,
  dropSlash,
  filterAgents,
  runAttachmentsProblem,
  slashQuery,
  slugOf,
  toRunAttachment,
  typedAgent,
  type AgentEntry,
} from "./agentMenu";

function profile(over: Partial<AgentProfile>): AgentProfile {
  return {
    id: "x",
    name: "X",
    kind: "task",
    description: "",
    instructions: "",
    model: null,
    fallbackModels: [],
    tools: [],
    autoApply: false,
    maxSteps: null,
    source: "global",
    overridesBuiltin: false,
    ...over,
  };
}

const profiles: AgentProfile[] = [
  profile({ id: "fixer", name: "Fixer", kind: "fixer", source: "builtin" }),
  profile({ id: "chat", name: "Chat", kind: "chat", source: "global" }),
  profile({ id: "proof", name: "Proof Checker!", kind: "task", description: "Checks every proof" }),
  profile({ id: "strict", name: "Strict reviewer", kind: "reviewer", source: "project" }),
  profile({ id: "fix2", name: "Fix", kind: "fixer" }),
  profile({ id: "café", name: "Café", kind: "rebuttal" }),
];

const entries = agentEntries(profiles);
const by = (slug: string) => entries.find((a) => a.slug === slug) as AgentEntry;

const image: DraftAttachment = { id: "1", name: "plot.jpg", status: "ready", kind: "image", mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,AAAA" };
const text: DraftAttachment = { id: "2", name: "notes.txt", status: "ready", kind: "text", mime: "text/plain", text: "hello" };
const reading: DraftAttachment = { id: "3", name: "big.pdf", status: "reading" };

describe("agent list", () => {
  it("lists the built-ins first, then every custom agent but not chat or built-in profiles", () => {
    expect(entries.slice(0, 4).map((a) => a.label)).toEqual(["Fix compile errors", "Review paper", "Respond to reviewers", "Custom task"]);
    expect(entries.slice(4).map((a) => a.label)).toEqual(["Proof Checker!", "Strict reviewer", "Fix", "Café"]);
    expect(customProfiles(profiles).map((p) => p.id)).toEqual(["proof", "strict", "fix2", "café"]);
  });

  it("gives every agent a slug of its own", () => {
    expect(BUILT_IN_AGENTS.map((a) => a.slug)).toEqual(["fix", "review", "respond", "task"]);
    expect(entries.slice(4).map((a) => a.slug)).toEqual(["proof-checker", "strict-reviewer", "fix-2", "cafe"]);
    expect(new Set(entries.map((a) => a.slug)).size).toBe(entries.length);
  });

  it("makes slugs from names", () => {
    expect(slugOf("My Proof Checker!")).toBe("my-proof-checker");
    expect(slugOf("  ---  ")).toBe("agent");
    expect(slugOf("Ünïcode name")).toBe("unicode-name");
    expect(slugOf("a".repeat(50)).length).toBe(32);
  });
});

describe("the / menu", () => {
  it("opens for a / at the start while the caret is in the command", () => {
    expect(slashQuery("/", 1)).toBe("");
    expect(slashQuery("/rev", 4)).toBe("rev");
    expect(slashQuery("/Rev", 2)).toBe("rev");
    expect(slashQuery("/review the intro", 7)).toBe("review");
  });

  it("stays closed elsewhere", () => {
    expect(slashQuery("hi /fix", 7)).toBeNull();
    expect(slashQuery("/review the intro", 12)).toBeNull();
    expect(slashQuery("/fix.tex", 4)).toBeNull();
    expect(slashQuery("/rev", 0)).toBeNull();
    expect(slashQuery("", 0)).toBeNull();
  });

  it("filters by slug or name, matches at the start first", () => {
    expect(filterAgents(entries, "")).toEqual(entries);
    expect(filterAgents(entries, "re").map((a) => a.slug)).toEqual(["review", "respond", "strict-reviewer"]);
    expect(filterAgents(entries, "fix").map((a) => a.slug)).toEqual(["fix", "fix-2"]);
    expect(filterAgents(entries, "proof")[0].slug).toBe("proof-checker");
    expect(filterAgents(entries, "zzz")).toEqual([]);
  });

  it("drops the command and keeps the words", () => {
    expect(dropSlash("/rev")).toBe("");
    expect(dropSlash("/review the intro")).toBe("the intro");
    expect(dropSlash("plain text")).toBe("plain text");
  });

  it("switches to an agent typed out in full", () => {
    expect(typedAgent(entries, "/review ")?.id).toBe("review");
    expect(typedAgent(entries, "/FIX-2 now")?.id).toBe("profile:fix2");
    expect(typedAgent(entries, "/review")).toBeNull();
    expect(typedAgent(entries, "/nope ")).toBeNull();
  });
});

describe("starting an agent", () => {
  it("starts the fixer at once, with the words as instructions", () => {
    expect(agentAction(by("fix"), "  only chapter 2 ", [])).toEqual({
      type: "start",
      request: { kind: "fixer", profileId: "fixer", prompt: "only chapter 2", options: { title: "Fix compile errors" } },
    });
    const own = agentAction(by("fix-2"), "", []);
    expect(own).toEqual({ type: "start", request: { kind: "fixer", profileId: "fix2", prompt: "", options: { title: "Fix" } } });
  });

  it("opens the review setup, which needs a venue and reviewers", () => {
    expect(agentAction(by("review"), "", [])).toEqual({ type: "dialog", dialog: { type: "review", profile: null } });
    const own = agentAction(by("strict-reviewer"), "look at Theorem 2", []);
    expect(own.type).toBe("dialog");
    if (own.type === "dialog") expect(own.dialog).toMatchObject({ type: "review", profile: { id: "strict" }, prompt: "look at Theorem 2" });
  });

  it("starts a custom task with the words and attachments", () => {
    const out = agentAction(by("task"), "Shorten the abstract", [image, text, reading]);
    expect(out).toEqual({
      type: "start",
      request: {
        kind: "task",
        profileId: null,
        prompt: "Shorten the abstract",
        attachments: [
          { name: "plot.jpg", mime: "image/jpeg", dataBase64: "AAAA" },
          { name: "notes.txt", mime: "text/plain", text: "hello" },
        ],
        options: {},
      },
    });
  });

  it("opens the dialog when there is nothing to work from", () => {
    expect(agentAction(by("task"), "  ", [reading])).toEqual({ type: "dialog", dialog: { type: "new", kind: "task", profile: null } });
    expect(agentAction(by("respond"), "", [])).toEqual({ type: "dialog", dialog: { type: "new", kind: "rebuttal", profile: null } });
    const own = agentAction(by("proof-checker"), "", []);
    expect(own).toMatchObject({ type: "dialog", dialog: { type: "new", kind: "task", profile: { id: "proof" } } });
  });

  it("opens the response setup prefilled with the pasted reviews and attachments", () => {
    expect(agentAction(by("respond"), " Reviewer 1: … ", [])).toEqual({
      type: "dialog",
      dialog: { type: "new", kind: "rebuttal", profile: null, prompt: "Reviewer 1: …" },
    });
    const own = agentAction(by("cafe"), "R1", [image, text, reading]);
    expect(own).toEqual({
      type: "dialog",
      dialog: {
        type: "new",
        kind: "rebuttal",
        profile: expect.objectContaining({ id: "café" }),
        prompt: "R1",
        attachments: [
          { name: "plot.jpg", mime: "image/jpeg", kind: "image", dataUrl: "data:image/jpeg;base64,AAAA", note: "" },
          { name: "notes.txt", mime: "text/plain", kind: "text", text: "hello", note: "" },
        ],
      },
    });
  });

  it("runs a custom agent with its own profile", () => {
    expect(agentAction(by("proof-checker"), "check", [])).toEqual({
      type: "start",
      request: { kind: "task", profileId: "proof", prompt: "check", options: { profileName: "Proof Checker!" } },
    });
    const odd: AgentEntry = { ...by("proof-checker"), kind: "translator", profile: profile({ id: "tr", name: "Translator", kind: "translator" }) };
    expect(agentAction(odd, "to French", [])).toMatchObject({ type: "start", request: { kind: "", profileId: "tr" } });
  });

  it("converts attachments and checks the run limit", () => {
    expect(toRunAttachment({ id: "a", name: "n", status: "ready" })).toEqual({ name: "n", mime: "text/plain", text: "" });
    expect(runAttachmentsProblem([text])).toBeNull();
    expect(runAttachmentsProblem(Array.from({ length: 13 }, (_, i) => ({ ...text, id: String(i) })))).toMatch(/up to 12/);
  });
});

describe("the agent button", () => {
  it("says Set up whenever Enter only opens a setup dialog", () => {
    expect(agentStartLabel(by("review"), "the proofs", [])).toEqual({ setup: true, short: "Set up", full: "Set up Review paper" });
    expect(agentStartLabel(by("respond"), "the reviews", [text]).full).toBe("Set up Respond to reviewers");
    expect(agentStartLabel(by("task"), "  ", []).full).toBe("Set up Custom task");
    expect(agentStartLabel(by("proof-checker"), "", [reading]).short).toBe("Set up");
  });

  it("says Start when Enter starts the run", () => {
    expect(agentStartLabel(by("fix"), "", [])).toEqual({ setup: false, short: "Start", full: "Start Fix compile errors" });
    expect(agentStartLabel(by("task"), "tidy the bibliography", []).full).toBe("Start Custom task");
    expect(agentStartLabel(by("proof-checker"), "", [image]).short).toBe("Start");
  });
});
