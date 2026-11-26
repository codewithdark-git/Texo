import { describe, expect, it } from "vitest";
import type { AiModel } from "../../lib/api";
import { newProfile, type AgentDefaults, type AgentProfile } from "../../lib/agentsApi";
import {
  addFallback,
  checkedTools,
  defaultScope,
  defaultSteps,
  kindLabel,
  memorySizeText,
  memoryUsage,
  modelChoices,
  moveUp,
  profileChanged,
  profileProblems,
  removeAt,
  roleOf,
  searxngProblem,
  sourceLabel,
  toggleTool,
  toolLabel,
  withRole,
} from "./agentSettingsLogic";

const model = (id: string, label = ""): AiModel => ({ id, label, free: null, contextLength: null, recommended: false });

describe("tools", () => {
  const all = ["read_file", "search", "edit_file"];
  it("treats an empty list as all tools", () => {
    expect([...checkedTools(all, [])]).toEqual(all);
    expect([...checkedTools(all, ["search", "gone"])]).toEqual(["search"]);
  });
  it("toggles, stores all-checked as [] and keeps at least one", () => {
    const a = toggleTool(all, [], "edit_file");
    expect(a).toEqual(["read_file", "search"]);
    expect(toggleTool(all, a, "edit_file")).toEqual([]);
    expect(toggleTool(all, ["search"], "search")).toEqual(["search"]);
  });
  it("has plain labels, with a fallback", () => {
    expect(toolLabel("compile_check").label).toBe("Test compile");
    expect(toolLabel("new_tool").label).toBe("new tool");
    expect(kindLabel("fixer")).toBe("Fix compile errors");
    expect(kindLabel("mine")).toBe("mine");
    expect(defaultSteps("reviewer")).toBe(40);
    expect(defaultSteps("fixer")).toBe(16);
    expect(defaultSteps("task")).toBe(24);
  });
});

describe("models", () => {
  it("keeps chosen models that the live list lacks", () => {
    const c = modelChoices([model("a"), model("b", "Bee")], ["x", "a", null, "X"]);
    expect(c.map((m) => m.id)).toEqual(["x", "a", "b"]);
    expect(c[0]).toMatchObject({ missing: true, label: "x (not in the list)" });
    expect(c[2].label).toBe("Bee (b)");
    expect(modelChoices(null, ["x"])).toEqual([{ id: "x", label: "x", missing: false }]);
    expect(modelChoices(null, [])).toEqual([]);
  });
  it("edits fallback lists", () => {
    expect(addFallback(["a"], " b ", "m")).toEqual(["a", "b"]);
    expect(addFallback(["a"], "a")).toEqual(["a"]);
    expect(addFallback(["a"], "m", "m")).toEqual(["a"]);
    expect(addFallback(["1", "2", "3", "4", "5", "6", "7", "8"], "9")).toHaveLength(8);
    expect(removeAt(["a", "b", "c"], 1)).toEqual(["a", "c"]);
    expect(moveUp(["a", "b", "c"], 2)).toEqual(["a", "c", "b"]);
    expect(moveUp(["a", "b"], 0)).toEqual(["a", "b"]);
  });
  it("reads and replaces one role of one provider", () => {
    const d: AgentDefaults = { roles: { nvidia: { agent: { model: "n1", fallbacks: ["n2"], thinking: true } } }, maxParallel: 3 };
    expect(roleOf(d, "nvidia", "agent")).toEqual({ model: "n1", fallbacks: ["n2"], thinking: true });
    expect(roleOf(d, "groq", "chat")).toEqual({ model: "", fallbacks: [] });
    const e = withRole(d, "nvidia", "chat", { model: " c ", fallbacks: [] });
    expect(e.roles.nvidia.chat).toEqual({ model: "c", fallbacks: [] });
    expect(e.roles.nvidia.agent?.model).toBe("n1");
    expect(d.roles.nvidia.chat).toBeUndefined();
    expect(withRole(e, "nvidia", "agent", { model: "", fallbacks: [] }).roles.nvidia.agent).toBeUndefined();
  });
});

describe("profiles", () => {
  const p: AgentProfile = { ...newProfile("task", "Mine"), id: "mine" };
  it("finds problems", () => {
    expect(profileProblems(p)).toEqual([]);
    expect(profileProblems({ ...p, name: " " })[0]).toMatch(/name/);
    expect(profileProblems({ ...p, name: "x".repeat(81) })[0]).toMatch(/80/);
    expect(profileProblems({ ...p, instructions: "x".repeat(8001) })[0]).toMatch(/8000/);
    expect(profileProblems({ ...p, maxSteps: 0 })[0]).toMatch(/Steps/);
    expect(profileProblems({ ...p, maxSteps: 2.5 })[0]).toMatch(/Steps/);
  });
  it("notices real changes only", () => {
    expect(profileChanged(p, { ...p, name: " Mine " })).toBe(false);
    expect(profileChanged(p, { ...p, source: "project" })).toBe(false);
    expect(profileChanged(p, { ...p, model: "" })).toBe(false);
    expect(profileChanged(p, { ...p, autoApply: true })).toBe(true);
    expect(profileChanged(p, { ...p, tools: ["read_file"] })).toBe(true);
  });
  it("picks the save scope and the badge", () => {
    expect(defaultScope({ ...p, source: "project" }, true)).toBe("project");
    expect(defaultScope({ ...p, source: "project" }, false)).toBe("global");
    expect(defaultScope({ ...p, source: "builtin" }, true)).toBe("global");
    expect(sourceLabel({ ...p, source: "builtin" })).toBe("Built-in");
    expect(sourceLabel({ ...p, source: "global", overridesBuiltin: true })).toBe("Built-in, changed");
    expect(sourceLabel({ ...p, source: "project" })).toBe("This project");
  });
});

describe("web and memory", () => {
  it("checks SearXNG addresses", () => {
    expect(searxngProblem("")).toBeNull();
    expect(searxngProblem("https://search.example.org")).toBeNull();
    expect(searxngProblem("http://localhost:8080")).toBeNull();
    expect(searxngProblem("http://search.example.org")).toMatch(/https/);
    expect(searxngProblem("ftp://x")).toMatch(/https/);
    expect(searxngProblem("not a url")).toMatch(/web address/);
    expect(searxngProblem("https://u:p@x.org")).toMatch(/password/);
  });
  it("shows memory use", () => {
    const u = memoryUsage(4096, 8192);
    expect(u).toEqual({ bytes: 4096, max: 8192, percent: 50, over: false });
    expect(memorySizeText(u)).toBe("4 KB of 8 KB");
    expect(memorySizeText(memoryUsage(300, 8192))).toBe("300 bytes of 8 KB");
    expect(memorySizeText(memoryUsage(3277, 8192))).toBe("3.2 KB of 8 KB");
    expect(memoryUsage(9000, 8192)).toMatchObject({ over: true, percent: 100 });
    expect(memoryUsage(10, 0).max).toBe(8192);
  });
});
