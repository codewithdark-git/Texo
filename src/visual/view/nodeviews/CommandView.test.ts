// An included file is read from disk asynchronously; a repaint while that read
// is in flight (\input{sec} changed to \include{sec}, same target) must not let
// the old read draw into the old, detached body or take over the watcher.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../editor/monaco", () => ({ monaco: {} }));
vi.mock("../../../workspace/EditorPane", () => ({ revealSource: () => {}, zoomBy: () => {} }));
vi.mock("../../../workspace/editorBridge", () => ({ switchMode: () => {} }));
vi.mock("../../../editor/completions", () => ({ completionSource: () => null }));
vi.mock("../pdfSnapshot", () => ({ cachedSnapshot: () => null, onCompileFinished: () => () => {}, snapshot: async () => null }));

const watchers: { disposed: boolean; fn: () => void }[] = [];
vi.mock("../../../workspace/store", () => {
  const state = { files: [{ path: "main.tex", isDir: false }, { path: "sec.tex", isDir: false }], project: null, openFile: async () => {} };
  const useWorkspace = Object.assign(<T,>(pick: (s: typeof state) => T) => pick(state), { getState: () => state, setState() {}, subscribe: () => () => {} });
  const model = {
    getValue: () => "Section text.",
    onDidChangeContent: (fn: () => void) => {
      const w = { disposed: false, fn };
      watchers.push(w);
      return { dispose: () => void (w.disposed = true) };
    },
  };
  return { useWorkspace, getModel: (path: string) => (path === "sec.tex" ? model : null) };
});

// Each read waits until the test resolves it; each mount is recorded.
const reads: ((text: string) => void)[] = [];
const mounts: { host: unknown; destroyed: boolean }[] = [];
vi.mock("../includePreview", async (orig) => {
  const real = await orig<typeof import("../includePreview")>();
  return {
    ...real,
    loadIncludeText: () => new Promise<string | null>((resolve) => reads.push(resolve)),
    renderInclude: (host: unknown) => {
      const m = { host, destroyed: false };
      mounts.push(m);
      return { destroy: () => void (m.destroyed = true) };
    },
  };
});

import { EditorState } from "prosemirror-state";
import { DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { createSession, helpersFor } from "../../core";
import type { Binding } from "../binding";
import type { VisualEnv } from "../commands";
import { buildNodeViews } from ".";
import { installFakeDom, type FakeElement } from "../fakeDom";

const saved = { document: (globalThis as Record<string, unknown>).document };
beforeAll(() => void installFakeDom());
afterAll(() => {
  (globalThis as Record<string, unknown>).document = saved.document;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("CommandView include drawing", () => {
  it("ignores a read that finishes after a repaint with the same target", async () => {
    const text = "\\documentclass{article}\n\\begin{document}\n\n\\input{sec}\n\n\\end{document}\n";
    const session = createSession("latex", text);
    let node: PMNode | null = null;
    let pos = 0;
    session.doc.descendants((n, p) => {
      if (n.type.name === "command_block") {
        node = n;
        pos = p;
      }
      return !node;
    });
    expect(node).not.toBeNull();
    const env = {
      path: "main.tex",
      dialect: "latex",
      session,
      binding: null as unknown as Binding,
      helpers: helpersFor("latex"),
      view: null as unknown as EditorView,
      toast() {},
      openInCode() {},
    } as VisualEnv;
    const view = { state: EditorState.create({ doc: session.doc }), editable: false, dispatch() {}, focus() {} } as unknown as EditorView;
    const nv = buildNodeViews(() => env).command_block(node!, view, () => pos, [], DecorationSet.empty);
    expect(reads).toHaveLength(1);

    // Same target, different command: a new paint and a new read.
    const n = node! as PMNode;
    expect(nv.update!(n.type.create({ ...n.attrs, src: "\\include{sec}", kind: "include" }), [], DecorationSet.empty)).toBe(true);
    expect(reads).toHaveLength(2);
    const liveBody = () => (nv.dom as unknown as FakeElement).children.find((c) => c.classList.contains("v-include-body"));

    // The old read lands late: it must not mount anything or start watching.
    reads[0]("old");
    await flush();
    expect(mounts).toHaveLength(0);
    expect(watchers).toHaveLength(0);

    reads[1]("new");
    await flush();
    expect(mounts).toHaveLength(1);
    expect(mounts[0].host).toBe(liveBody());
    expect(watchers.filter((w) => !w.disposed)).toHaveLength(1);
    nv.destroy?.();
    expect(mounts[0].destroyed).toBe(true);
    expect(watchers.every((w) => w.disposed)).toBe(true);
  });
});
