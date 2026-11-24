import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store's collaborators, replaced so the compile scheduling can run in Node.
const h = vi.hoisted(() => ({
  afterChange: null as ((path: string) => void) | null,
  compiles: [] as { resolve: () => void }[],
  saveAll: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../ui", () => ({ toast: vi.fn() }));
vi.mock("../editor/monaco", () => ({
  monaco: {
    editor: { getModels: () => [], setModelMarkers: vi.fn(), onDidCreateModel: () => ({ dispose() {} }) },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  },
}));
vi.mock("../lib/api", () => ({
  COMPILE_OUTPUT_EVENT: "compile-output",
  errorText: String,
  api: {
    getSettings: async () => ({ compiler: "auto" }),
    detectToolchains: async () => ({}),
    compileProject: () =>
      new Promise((resolve) => {
        h.compiles.push({ resolve: () => resolve({ status: "success", issues: [], hints: [], savedPdf: null }) });
      }),
    abortCompile: async () => {},
  },
}));
vi.mock("./store", () => {
  const state = { project: { path: "/p", outputPdf: null }, saveAll: h.saveAll };
  return {
    useWorkspace: { getState: () => state, setState: vi.fn() },
    onProjectChanged: (fn: ((path: string) => void) | null) => {
      h.afterChange = fn;
    },
  };
});

const { useCompile } = await import("./compileStore");

/** Lets pending promise callbacks run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("compile scheduling", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    h.compiles.length = 0;
    useCompile.setState({ auto: true });
    await useCompile.getState().init();
    await flush();
    // init compiles once when auto-compile is on; finish that run.
    h.compiles.shift()?.resolve();
    await flush();
    h.compiles.length = 0;
  });

  afterEach(() => {
    useCompile.getState().reset();
    vi.useRealTimers();
  });

  it("compiles shortly after a saved edit (Visual mode's live preview)", async () => {
    h.afterChange!("main.tex");
    await vi.advanceTimersByTimeAsync(299);
    expect(h.compiles).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.compiles).toHaveLength(1);
  });

  it("queues exactly one follow-up for any number of requests while compiling", async () => {
    void useCompile.getState().compile();
    await flush();
    expect(h.compiles).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      h.afterChange!("main.tex");
      await vi.advanceTimersByTimeAsync(400);
    }
    void useCompile.getState().compile();
    expect(useCompile.getState().queued).toBe(true);
    expect(h.compiles).toHaveLength(1);
    h.compiles[0].resolve();
    await flush();
    expect(h.compiles).toHaveLength(2);
    h.compiles[1].resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.compiles).toHaveLength(2);
    expect(useCompile.getState().compiling).toBe(false);
  });

  it("doesn't compile twice when its own save reports the files as changed", async () => {
    h.saveAll.mockImplementationOnce(async () => h.afterChange!("main.tex"));
    void useCompile.getState().compile();
    await flush();
    h.compiles[0].resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.compiles).toHaveLength(1);
  });

  it("ignores changes to files that aren't compile inputs", async () => {
    h.afterChange!("notes.txt");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.compiles).toHaveLength(0);
  });
});
