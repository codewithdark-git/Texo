import { describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { baseKeymap } from "prosemirror-commands";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { createSession } from "../core";
import { Binding } from "./binding";
import { skipHiddenComments } from "./hiddenComments";
import { FakeModel, FakeView } from "./testkit";

const wrap = (body: string) => `\\documentclass{article}\n\\begin{document}\n\n${body}\n\n\\end{document}\n`;
const TODO = "% TODO: reviewer asked for more data here";

function setup(text: string, hidden = true) {
  const model = new FakeModel(text);
  const session = createSession("latex", text);
  const view = new FakeView(EditorState.create({ doc: session.doc }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const binding = new Binding({ session, model, view, host: { toast: vi.fn(), dev: true } });
  // What the Visual keymap runs: the comment guard first, then the base key.
  // The base keys get no view (FakeView can't measure text), as in a headless run.
  const press = (dir: -1 | 1) =>
    skipHiddenComments(dir, () => hidden)(view.state, binding.dispatch, view as unknown as EditorView) ||
    baseKeymap[dir < 0 ? "Backspace" : "Delete"](view.state, binding.dispatch);
  const at = (needle: string, offset = 0) => {
    const pos = posOf(view.state.doc, needle) + offset;
    binding.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  };
  const done = () => {
    expect(session.verify()).toEqual({ ok: true });
    expect(session.text).toBe(model.getValue());
    warn.mockRestore();
  };
  return { model, view, press, at, done };
}

function posOf(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found !== -1) return false;
    if (n.isText && n.text!.includes(needle)) found = pos + n.text!.indexOf(needle);
    return true;
  });
  if (found === -1) throw new Error("not found: " + needle);
  return found;
}

describe("Backspace and Delete next to hidden comments", () => {
  it("Backspace joins the paragraphs and keeps the comment between them", () => {
    const t = setup(wrap(`First para.\n\n${TODO}\n\nSecond para.`));
    t.at("Second");
    expect(t.press(-1)).toBe(true);
    const out = t.model.getValue();
    expect(out).toContain(TODO);
    expect(out).toContain("First para.Second para.");
    t.done();
  });

  it("Delete at the end of the paragraph before the comment joins without losing it", () => {
    const t = setup(wrap(`First para.\n\n${TODO}\n\nSecond para.`));
    t.at("First para.", "First para.".length);
    expect(t.press(1)).toBe(true);
    const out = t.model.getValue();
    expect(out).toContain(TODO);
    expect(out).toContain("First para.Second para.");
    t.done();
  });

  it("steps over several comment blocks in a row", () => {
    const t = setup(wrap(`One.\n\n% a\n\n% b\n\nTwo.`));
    t.at("Two");
    t.press(-1);
    const out = t.model.getValue();
    expect(out).toContain("% a");
    expect(out).toContain("% b");
    expect(out).toContain("One.Two.");
    t.done();
  });

  it("deletes the visible character before a hidden inline comment, not the comment", () => {
    const t = setup(wrap(`Text here % note\nmore words.`));
    const before = t.model.getValue();
    if (!before.includes("% note")) throw new Error("fixture");
    t.at("more");
    expect(t.press(-1)).toBe(true);
    // The space before the comment is the visible character that goes.
    expect(t.model.getValue()).toContain("Text here% note\nmore words.");
    t.done();
  });

  it("leaves the keys alone when comments are shown", () => {
    const t = setup(wrap(`First para.\n\n${TODO}\n\nSecond para.`), false);
    t.at("Second");
    t.press(-1);
    // Visible comment: the base key may remove it, as the user can see.
    expect(t.model.getValue()).not.toContain(TODO);
    t.done();
  });
});
