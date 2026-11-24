// A real paper's first page in Visual mode: drawn with the actual node views
// (into a tiny fake DOM), it must read like a word processor page, with no
// LaTeX commands on show; and the ribbon's page-look commands must write
// ordinary, canonical LaTeX back into the file.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Browser-only pieces the views import but these tests never reach.
vi.mock("../../editor/monaco", () => ({ monaco: {} }));
vi.mock("../../workspace/EditorPane", () => ({ revealSource: () => {}, zoomBy: () => {} }));
vi.mock("../../workspace/editorBridge", () => ({ switchMode: () => {} }));
vi.mock("../../editor/completions", () => ({ completionSource: () => null }));
vi.mock("./pdfSnapshot", () => ({ cachedSnapshot: () => null, onCompileFinished: () => () => {}, snapshot: async () => null }));
// The workspace (it pulls in Monaco): two project files, the included one open in an editor.
vi.mock("../../workspace/store", () => {
  const state = { files: [{ path: "main.tex", isDir: false }, { path: "sec_intro.tex", isDir: false }], project: null, openFile: async () => {} };
  const useWorkspace = Object.assign(<T,>(pick: (s: typeof state) => T) => pick(state), { getState: () => state, setState() {}, subscribe: () => () => {} });
  return {
    useWorkspace,
    getModel: (path: string) => (path === "sec_intro.tex" ? { getValue: () => intro, onDidChangeContent: () => ({ dispose() {} }) } : null),
  };
});
vi.mock("./includePreview", async (orig) => {
  const real = await orig<typeof import("./includePreview")>();
  return {
    ...real,
    renderInclude: (host: HTMLElement, path: string, text: string) => {
      const session = createSession("latex", text);
      renderDoc(session.doc, envFor(session, path), host as unknown as FakeElement);
      return { destroy() {} };
    },
  };
});

import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { DecorationSet, type EditorView } from "prosemirror-view";
import { DOMSerializer, type Node as PMNode } from "prosemirror-model";
import { createSession, helpersFor, type VisualSession } from "../core";
import { Binding } from "./binding";
import { insertPageBreak, setAlignment, setColor, setSize, type VisualEnv } from "./commands";
import { buildNodeViews } from "./nodeviews";
import { FakeElement, installFakeDom, visibleText, type FakeDocument } from "./fakeDom";
import { FakeModel, FakeView } from "./testkit";
import paper from "./__fixtures__/real-paper.tex?raw";
import intro from "./__fixtures__/sec_intro.tex?raw";

let doc: FakeDocument;
const saved = { document: (globalThis as Record<string, unknown>).document };

beforeAll(() => {
  doc = installFakeDom();
});

afterAll(() => {
  (globalThis as Record<string, unknown>).document = saved.document;
});

/** An env for drawing only: nothing dispatches through it. */
function envFor(session: VisualSession, path: string): VisualEnv {
  return {
    path,
    dialect: "latex",
    session,
    binding: null as unknown as Binding,
    helpers: helpersFor("latex"),
    view: null as unknown as EditorView,
    toast() {},
    openInCode() {},
  };
}

/**
 * Draws `pmDoc` into `host` the way the Visual editor does: each node with
 * its node view when it has one, else with the schema's toDOM, and text
 * wrapped in its marks' toDOM.
 */
function renderDoc(pmDoc: PMNode, env: VisualEnv, host: FakeElement) {
  const getEnv = () => env;
  const views = buildNodeViews(getEnv);
  const view = {
    state: EditorState.create({ doc: pmDoc }),
    dom: host,
    root: doc,
    editable: false,
    dispatch() {},
    focus() {},
    nodeDOM: () => null,
  } as unknown as EditorView;
  env.view ??= view;
  const fakeDoc = doc as unknown as Document;
  const draw = (node: PMNode, pos: number, parent: FakeElement) => {
    if (node.isText) {
      let out: FakeElement | ReturnType<FakeDocument["createTextNode"]> = doc.createTextNode(node.text!);
      for (const mark of [...node.marks].reverse()) {
        const toDOM = mark.type.spec.toDOM;
        if (!toDOM) continue;
        const { dom, contentDOM } = DOMSerializer.renderSpec(fakeDoc, toDOM(mark, true));
        ((contentDOM ?? dom) as unknown as FakeElement).appendChild(out);
        out = dom as unknown as FakeElement;
      }
      parent.appendChild(out);
      return;
    }
    const make = views[node.type.name];
    let dom: FakeElement;
    let content: FakeElement | null;
    if (make) {
      const nv = make(node, view, () => pos, [], DecorationSet.empty);
      dom = nv.dom as unknown as FakeElement;
      content = (nv.contentDOM ?? null) as unknown as FakeElement | null;
    } else {
      const spec = DOMSerializer.renderSpec(fakeDoc, node.type.spec.toDOM!(node));
      dom = spec.dom as unknown as FakeElement;
      content = (spec.contentDOM ?? null) as unknown as FakeElement | null;
    }
    parent.appendChild(dom);
    if (content) node.forEach((child, offset) => draw(child, pos + 1 + offset, content!));
  };
  pmDoc.forEach((child, offset) => draw(child, offset, host));
}

/** Comments are hidden unless the "Show LaTeX comments" preference is on (the pane's v-hide-comments class). */
const hiddenByDefault = (el: FakeElement) => el.classList.contains("v-comment") || el.classList.contains("v-comment-inline");

describe("a real paper in Visual mode", () => {
  it("parses losslessly", () => {
    const s = createSession("latex", paper);
    expect(s.verify()).toEqual({ ok: true });
    expect(s.text).toBe(paper);
  });

  it("reads as a page, with no LaTeX commands on show", async () => {
    const session = createSession("latex", paper);
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    renderDoc(session.doc, envFor(session, "main.tex"), host);
    // The included file loads asynchronously, as from an open editor.
    await new Promise((r) => setTimeout(r, 0));

    const text = visibleText(host, hiddenByDefault);
    // No control words, no control symbols, no braces, no comment text.
    expect(text).not.toMatch(/\\/);
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toContain("TODO");
    // What a reader expects to see instead.
    expect(text).toContain("Groupwise Coverage Under Source Imbalance");
    expect(text).toContain("Jane Q. Researcher");
    expect(text).toContain("Abstract.");
    expect(text).toContain("9,577");
    expect(text).toContain("81%");
    expect(text).toContain("from sec_intro.tex");
    expect(text).toContain("Introduction");
    expect(text).toContain("Medical images come from many sites.");
    expect(text).toContain("The method section follows.");
    // The TikZ picture waits for the PDF rather than showing its code.
    expect(text).toContain("shown in the PDF");
    expect(text).not.toContain("draw");

    // The page-look pieces are drawn as such.
    expect(host.querySelector(".v-align-center")).not.toBeNull();
    expect(host.querySelector(".v-vspace")).not.toBeNull();
    // The comment is there for those who turn comments on, and only then.
    expect(visibleText(host)).toContain("TODO");
  });
});

describe("page-look commands on the paper", () => {
  function setup() {
    const model = new FakeModel(paper);
    const session = createSession("latex", paper);
    const view = new FakeView(EditorState.create({ doc: session.doc }));
    const toast = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const binding = new Binding({ session, model, view, host: { toast, dev: true } });
    const pmView = Object.assign(view, { dispatch: binding.dispatch, focus() {} }) as unknown as EditorView;
    const env: VisualEnv = { ...envFor(session, "main.tex"), binding, view: pmView, toast };
    const run = (cmd: (s: EditorState, d?: (tr: Transaction) => void) => boolean) => expect(cmd(view.state, binding.dispatch)).toBe(true);
    const find = (needle: string) => {
      let found = -1;
      view.state.doc.descendants((n, pos) => {
        if (found === -1 && n.isText && n.text!.includes(needle)) found = pos + n.text!.indexOf(needle);
        return found === -1;
      });
      if (found === -1) throw new Error("not found: " + needle);
      return found;
    };
    const select = (needle: string) => {
      const at = find(needle);
      binding.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + needle.length)));
    };
    const caret = (needle: string) => binding.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, find(needle))));
    return { model, session, env, getEnv: () => env, run, select, caret, warn, toast };
  }

  it("writes size, colour, alignment and a page break as canonical LaTeX", () => {
    const t = setup();
    t.select("method section");
    t.run(setSize(t.getEnv, "Large"));
    t.select("follows");
    t.run(setColor(t.getEnv, "blue"));
    t.caret("The ");
    t.run(setAlignment(t.getEnv, "right"));
    expect(insertPageBreak(t.env)).toBe(true);

    const expected = paper
      .replace("\\usepackage{tikz}\n", "\\usepackage{tikz}\n\\usepackage{xcolor}\n")
      .replace(
        "The method section follows.\n",
        "\\begin{flushright}\nThe {\\Large method section} \\textcolor{blue}{follows}.\n\\end{flushright}\n\n\\newpage\n",
      );
    expect(t.model.getValue()).toBe(expected);
    expect(t.toast).toHaveBeenCalledWith("Added \\usepackage{xcolor}", "info");
    // Nothing was refused, and the file reads back as what Visual mode shows.
    expect(t.warn).not.toHaveBeenCalled();
    expect(t.session.verify()).toEqual({ ok: true });
    expect(createSession("latex", t.model.getValue()).verify()).toEqual({ ok: true });
    t.warn.mockRestore();
  });

  it("restyles part of the hand-set title without refusing", () => {
    const t = setup();
    t.select("Groupwise");
    t.run(setColor(t.getEnv, "red"));
    t.run(setSize(t.getEnv, "huge"));
    const out = t.model.getValue();
    expect(out).toContain("\\textcolor{red}{");
    expect(out).toContain("{\\huge ");
    expect(out).toContain("Coverage Under Source Imbalance");
    expect(t.warn).not.toHaveBeenCalled();
    expect(t.session.verify()).toEqual({ ok: true });
    t.warn.mockRestore();
  });
});
