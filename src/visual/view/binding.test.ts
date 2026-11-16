import { describe, expect, it, vi } from "vitest";
import { EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { createSession, helpersFor, schema } from "../core";
import { Binding, REFUSED_MESSAGE } from "./binding";
import { FakeModel, FakeView } from "./testkit";

const TEXT = "\\section{Intro}\n\nHello world, this is text.\n\nSecond paragraph here.\n";

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

function setup(text = TEXT) {
  const model = new FakeModel(text);
  const session = createSession("latex", text);
  const view = new FakeView(EditorState.create({ doc: session.doc }));
  let clock = 0;
  const toast = vi.fn();
  const binding = new Binding({ session, model, view, host: { toast, now: () => clock, dev: true } });
  const tick = (ms: number) => (clock += ms);
  /** Types `s` one character at a time at the cursor. */
  const type = (s: string) => {
    for (const ch of s) binding.dispatch(view.state.tr.insertText(ch));
  };
  const place = (pos: number) => binding.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  return { model, session, view, binding, toast, tick, type, place };
}

describe("Visual binding", () => {
  it("attaching and detaching without edits leaves the model alone", () => {
    const { model, binding, view, session } = setup();
    const before = model.getAlternativeVersionId();
    binding.selectSource(TEXT.indexOf("world"));
    binding.hide();
    binding.show();
    binding.dispose();
    expect(model.edits).toBe(0);
    expect(model.getAlternativeVersionId()).toBe(before);
    expect(model.getValue()).toBe(TEXT);
    expect(view.state.doc).toBe(session.doc);
  });

  it("typing becomes small model edits grouped into one undo step", () => {
    const { model, view, place, type, tick } = setup();
    place(posOf(view.state.doc, "world"));
    const stopsBefore = model.stackElements;
    type("big ");
    expect(model.getValue()).toBe(TEXT.replace("world", "big world"));
    expect(model.edits).toBe(4);
    // Only the first keystroke after attaching starts a new step.
    expect(model.stackElements - stopsBefore).toBe(1);

    tick(1500);
    type("!");
    expect(model.stackElements - stopsBefore).toBe(2);

    model.undo();
    expect(model.getValue()).toBe(TEXT.replace("world", "big world"));
    model.undo();
    expect(model.getValue()).toBe(TEXT);
    expect(view.state.doc.textContent).toContain("Hello world");
  });

  it("a cursor jump starts a new undo step", () => {
    const { model, view, place, type } = setup();
    place(posOf(view.state.doc, "world"));
    type("a");
    const stops = model.stackElements;
    type("b");
    expect(model.stackElements).toBe(stops);
    place(posOf(view.state.doc, "Second"));
    type("c");
    expect(model.stackElements).toBe(stops + 1);
  });

  it("a refused plan leaves the view and the model untouched", () => {
    const { model, view, session, binding, toast } = setup();
    const plan = vi.spyOn(session, "plan").mockReturnValue({ ok: false, reason: "test" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stateBefore = view.state;
    binding.dispatch(view.state.tr.insertText("X", posOf(view.state.doc, "world")));
    binding.dispatch(view.state.tr.insertText("Y", posOf(view.state.doc, "world")));
    expect(view.state).toBe(stateBefore);
    expect(model.getValue()).toBe(TEXT);
    expect(model.edits).toBe(0);
    // Throttled: one toast for the burst.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(REFUSED_MESSAGE);
    plan.mockRestore();
    warn.mockRestore();
  });

  it("undo and redo put the selection back where it was", () => {
    const { model, view, place, type, session } = setup();
    const at = posOf(view.state.doc, "world");
    place(at);
    type("XY");
    const afterSel = view.state.selection.head;
    model.undo();
    expect(model.getValue()).toBe(TEXT);
    expect(session.pmToSrc(view.state.selection.head)).toBe(TEXT.indexOf("world"));
    model.redo();
    expect(model.getValue()).toBe(TEXT.replace("world", "XYworld"));
    expect(view.state.selection.head).toBe(afterSel);
  });

  it("an edit in the model replaces only the changed block", () => {
    const { model, view } = setup();
    const before = view.state.doc;
    const firstBlocks = [before.child(0), before.child(1)];
    const lastBlock = before.child(before.childCount - 1);
    model.external(TEXT.indexOf("Second"), 0, "My ");
    const after = view.state.doc;
    expect(after.textContent).toContain("My Second paragraph");
    expect(after.child(0)).toBe(firstBlocks[0]);
    expect(after.child(1)).toBe(firstBlocks[1]);
    expect(after.child(after.childCount - 1)).not.toBe(lastBlock);
  });

  it("while hidden, model changes wait until the view is shown", () => {
    const { model, view, binding } = setup();
    binding.hide();
    model.external(0, 0, "% note\n");
    expect(binding.stale).toBe(true);
    expect(view.state.doc.textContent).not.toContain("note");
    binding.show();
    expect(binding.stale).toBe(false);
    expect(view.state.doc.childCount).toBeGreaterThan(0);
    // Showing again makes no edit of its own.
    expect(model.getValue().startsWith("% note\n")).toBe(true);
  });

  it("structural edits get their own undo step", () => {
    const { model, view, binding, session } = setup();
    const at = posOf(view.state.doc, "Hello");
    const $at = view.state.doc.resolve(at);
    const stops = model.stackElements;
    binding.dispatch(view.state.tr.setBlockType($at.before(), $at.after(), schema.nodes.heading, helpersFor("latex").headingAttrs(1, session.context)));
    expect(model.getValue()).toContain("\\section{Hello world, this is text.}");
    expect(model.stackElements).toBeGreaterThanOrEqual(stops + 2);
    expect(session.verify()).toEqual({ ok: true });
    model.undo();
    expect(model.getValue()).toBe(TEXT);
  });
  it("resyncs when the model stores other text than planned, even outside dev builds", () => {
    const text = ["Hello world.", "", "$$", "x", "$$", "", "After text.", ""].join("\r\n");
    const model = new FakeModel(text, { normalizeEol: true });
    const session = createSession("latex", text);
    const view = new FakeView(EditorState.create({ doc: session.doc }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const binding = new Binding({ session, model, view, host: { toast: vi.fn() } });
    let mathPos = -1;
    view.state.doc.descendants((n, pos) => {
      if (n.type === schema.nodes.math_display) mathPos = pos;
      return mathPos === -1;
    });
    const node = view.state.doc.nodeAt(mathPos)!;
    // A textarea value: its line breaks are bare LFs.
    binding.dispatch(view.state.tr.setNodeMarkup(mathPos, null, { ...node.attrs, body: "\ny\n" }));
    expect(error).toHaveBeenCalled();
    expect(session.text).toBe(model.getValue());
    // Later edits land where they should.
    binding.dispatch(view.state.tr.insertText("!", posOf(view.state.doc, "After") + 5));
    expect(model.getValue()).toContain("After! text.");
    expect(session.text).toBe(model.getValue());
    expect(session.verify()).toEqual({ ok: true });
    error.mockRestore();
  });

  it("an inbound sync keeps plugin state", () => {
    const key = new PluginKey<number>("probe");
    let inits = 0;
    const probe = new Plugin<number>({
      key,
      state: {
        init: () => ++inits,
        apply: (_tr, v) => v,
      },
    });
    const model = new FakeModel(TEXT);
    const session = createSession("latex", TEXT);
    const view = new FakeView(EditorState.create({ doc: session.doc, plugins: [probe] }));
    new Binding({ session, model, view, host: { toast: vi.fn(), dev: true } });
    expect(inits).toBe(1);
    model.external(TEXT.indexOf("Second"), 0, "My ");
    model.undo();
    model.redo();
    expect(view.state.doc.textContent).toContain("My Second");
    expect(inits).toBe(1);
    expect(key.getState(view.state)).toBe(1);
    // The blocks are still the session's own nodes.
    for (let i = 0; i < session.doc.childCount; i++) expect(view.state.doc.child(i)).toBe(session.doc.child(i));
  });
});
