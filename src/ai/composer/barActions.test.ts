// Starting an agent from the AI Chat bar: what opens, and what stays in front.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
vi.mock("../../ui", () => ({ toast: vi.fn() }));
vi.mock("../../workspace/store", () => ({ getModel: () => null }));
vi.mock("../agents/actions", () => ({ startRun: vi.fn(async () => "run-1") }));

import { startRun } from "../agents/actions";
import { useAgentDialog } from "../agents/dialogStore";
import { useAiTabs } from "../tabs/aiTabsStore";
import { BUILT_IN_AGENTS } from "./agentMenu";
import { startAgentFromBar } from "./barActions";

const agent = (slug: string) => BUILT_IN_AGENTS.find((a) => a.slug === slug)!;

beforeEach(() => {
  useAgentDialog.setState({ dialog: null });
  useAiTabs.setState({ tabs: [], active: null });
  vi.mocked(startRun).mockClear();
});

describe("starting an agent from the bar", () => {
  it("opens a setup dialog over the file in front, without opening the Agents tab", async () => {
    const outcome = await startAgentFromBar("C:/p", agent("review"), "check the proofs", []);
    expect(outcome).toBe("dialog");
    expect(useAgentDialog.getState().dialog).toMatchObject({ type: "review", prompt: "check the proofs" });
    expect(useAiTabs.getState().tabs).toEqual([]);
    expect(useAiTabs.getState().active).toBeNull();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("tells the bar once the dialog started the run", async () => {
    const onStarted = vi.fn();
    await startAgentFromBar("C:/p", agent("respond"), "", [], onStarted);
    const dialog = useAgentDialog.getState().dialog;
    expect(dialog).toMatchObject({ type: "new", kind: "rebuttal" });
    (dialog as { onStarted?: (id: string) => void }).onStarted?.("run-2");
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it("starts a run at once and opens only that run's tab", async () => {
    const outcome = await startAgentFromBar("C:/p", agent("fix"), "", []);
    expect(outcome).toBe("started");
    expect(startRun).toHaveBeenCalledOnce();
    expect(useAiTabs.getState().tabs).toEqual(["run:run-1"]);
  });
});
