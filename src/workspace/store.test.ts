import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny stand-in for Monaco's text model: one long "line", offsets as columns.
const h = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  writes: [] as { path: string; text: string }[],
}));

vi.mock("../editor/monaco", () => {
  class FakeModel {
    private version = 1;
    private listeners: (() => void)[] = [];
    constructor(private text: string) {}
    getValue() {
      return this.text;
    }
    setValue(text: string) {
      this.text = text;
      this.version++;
      this.listeners.forEach((fn) => fn());
    }
    setEOL() {}
    getAlternativeVersionId() {
      return this.version;
    }
    onDidChangeContent(fn: () => void) {
      this.listeners.push(fn);
      return { dispose() {} };
    }
    getPositionAt(offset: number) {
      return { lineNumber: 1, column: offset + 1 };
    }
    pushEditOperations(_sel: unknown, edits: { range: { startColumn: number; endColumn: number }; text: string }[]) {
      for (const e of edits) this.text = this.text.slice(0, e.range.startColumn - 1) + e.text + this.text.slice(e.range.endColumn - 1);
      this.version++;
      this.listeners.forEach((fn) => fn());
      return null;
    }
    dispose() {}
  }
  return {
    languageFor: () => "latex",
    monaco: {
      editor: { createModel: (text: string) => new FakeModel(text), EndOfLineSequence: { LF: 0 } },
      Uri: { from: (x: unknown) => x },
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../editor/completions", () => ({ completionSource: { symbols: {}, files: [] } }));
vi.mock("../visual/view/macroText", () => ({ setTextMacros: () => {} }));
vi.mock("../lib/editorPrefs", () => ({ getEditorPrefs: () => ({}) }));
vi.mock("../ui", () => ({ toast: () => {}, trashName: () => "Recycle Bin" }));
vi.mock("../lib/api", () => ({
  FS_CHANGED_EVENT: "fs-changed",
  SHOW_PDF_EVENT: "show-pdf",
  errorText: (e: unknown) => String(e),
  api: {
    listProjectFiles: vi.fn(async () => [...h.disk.keys()].map((path) => ({ path, isDir: false, size: 1 }))),
    readFile: vi.fn(async (_p: string, path: string) => {
      const content = h.disk.get(path);
      if (content === undefined) throw new Error("gone");
      return { kind: "text", content };
    }),
    writeFile: vi.fn(async (_p: string, path: string, text: string) => {
      h.disk.set(path, text);
      h.writes.push({ path, text });
    }),
    projectSymbols: vi.fn(async () => ({ labels: [], citations: [], commands: [] })),
    watchProject: vi.fn(async () => {}),
    unwatchProject: vi.fn(async () => {}),
  },
}));

import { getModel, useWorkspace } from "./store";

const project = { id: "p1", path: "C:/papers/one", name: "One", mainDocument: "main.tex", outputPdf: null } as never;

beforeEach(async () => {
  h.disk.clear();
  h.writes = [];
  await useWorkspace.getState().teardown();
});

describe("files rewritten outside the editor", () => {
  it("shows a restore back to the last-saved text, and doesn't save the AI text again (DS-1)", async () => {
    h.disk.set("main.tex", "start");
    await useWorkspace.getState().init(project);
    const model = getModel("main.tex") as unknown as { getValue(): string; setValue(t: string): void };
    expect(model.getValue()).toBe("start");

    // You type and it is saved: text A.
    model.setValue("A");
    await useWorkspace.getState().save("main.tex");
    expect(h.disk.get("main.tex")).toBe("A");

    // An agent's change is applied: B on disk, reloaded into the editor.
    h.disk.set("main.tex", "B");
    await useWorkspace.getState().reloadFromDisk(["main.tex"]);
    expect(model.getValue()).toBe("B");

    // "Undo this AI run" writes A back: the editor must follow.
    h.disk.set("main.tex", "A");
    await useWorkspace.getState().reloadFromDisk(["main.tex"]);
    expect(model.getValue()).toBe("A");
    expect(useWorkspace.getState().status["main.tex"]?.dirty).toBe(false);

    // Nothing to save, so B never comes back.
    await useWorkspace.getState().saveAll();
    expect(h.disk.get("main.tex")).toBe("A");
  });
});
