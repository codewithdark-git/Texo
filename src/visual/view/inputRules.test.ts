import { describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection, type Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { createSession, helpersFor, type Dialect } from "../core";
import { Binding } from "./binding";
import type { VisualEnv } from "./commands";
import { FakeModel, FakeView } from "./testkit";

// The pickers and popovers need the app; these tests cover the text rules.
vi.mock("./actions", () => ({}));
vi.mock("./Popovers", () => ({ openPopover: vi.fn() }));

const { inputRulesPlugin, undoInputRule } = await import("./inputRules");

function setup(text: string, dialect: Dialect = "latex") {
  const model = new FakeModel(text);
  const session = createSession(dialect, text);
  const plugin = inputRulesPlugin(() => env);
  const view = new FakeView(EditorState.create({ doc: session.doc, plugins: [plugin] }));
  const binding = new Binding({ session, model, view, host: { toast: vi.fn(), dev: true } });
  const pmView = Object.assign(view, { dispatch: binding.dispatch, composing: false }) as unknown as EditorView;
  const env: VisualEnv = {
    path: "a.tex",
    dialect,
    session,
    binding,
    helpers: helpersFor(dialect),
    view: pmView,
    toast: vi.fn(),
    openInCode() {},
  };
  /** Types like a keyboard: the rule plugin first, else a plain insert. */
  const type = (s: string) => {
    for (const ch of s) {
      const { from, to } = view.state.selection;
      const handler = (plugin as Plugin).props.handleTextInput!;
      const handled = handler.call(plugin, pmView, from, to, ch, () => view.state.tr);
      if (!handled) binding.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };
  const placeAt = (needle: string, after = false) => {
    let p = -1;
    view.state.doc.descendants((n, pos) => {
      if (p === -1 && n.isText && n.text!.includes(needle)) p = pos + n.text!.indexOf(needle) + (after ? needle.length : 0);
    });
    binding.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, p)));
  };
  return { model, session, view, env, type, placeAt };
}

const DOC = "First paragraph.\n\nSecond.\n";

describe("Visual input rules", () => {
  it("'# ' at the start of a paragraph makes a section; Backspace gives the text back", () => {
    const t = setup(DOC);
    t.placeAt("Second");
    t.type("# ");
    expect(t.model.getValue()).toBe("First paragraph.\n\n\\section{Second.}\n");
    expect(undoInputRule(t.env)).toBe(true);
    expect(t.model.getValue()).toBe("First paragraph.\n\n\\# Second.\n");
    t.model.undo();
    expect(t.model.getValue()).toBe(DOC);
  });

  it("'- ' starts a bulleted list and '> ' a quote", () => {
    const t = setup(DOC);
    t.placeAt("Second");
    t.type("- ");
    expect(t.model.getValue()).toMatch(/\\begin\{itemize\}\s+\\item Second\.\s+\\end\{itemize\}/);
    const q = setup(DOC);
    q.placeAt("First");
    q.type("> ");
    expect(q.model.getValue()).toMatch(/^\\begin\{quote\}\s+First paragraph\.\s+\\end\{quote\}/);
  });

  it("**x**, *x* and `x` become marks", () => {
    const t = setup(DOC);
    t.placeAt("paragraph.", true);
    t.type(" **big** *it* `mono`");
    expect(t.model.getValue()).toBe("First paragraph. \\textbf{big} \\emph{it} \\texttt{mono}\n\nSecond.\n");
    expect(t.session.verify()).toEqual({ ok: true });
  });

  it("an opener followed by a space is left alone", () => {
    const t = setup(DOC);
    t.placeAt("paragraph.", true);
    t.type(" 2 * 3 * 4");
    expect(t.model.getValue()).toContain("2 * 3 * 4");
  });

  it("quotes and dashes become LaTeX glyphs", () => {
    const t = setup(DOC);
    t.placeAt("paragraph.", true);
    t.type(' "hi" 1--2 a---b');
    expect(t.model.getValue()).toBe("First paragraph. ``hi'' 1--2 a---b\n\nSecond.\n");
  });

  it("uses Markdown spelling in Markdown files", () => {
    const t = setup("Text here.\n\nMore.\n", "markdown");
    t.placeAt("More");
    t.type("## ");
    expect(t.model.getValue()).toBe("Text here.\n\n## More.\n");
    t.placeAt("here.", true);
    t.type(" __b__");
    // Bold, spelled in the file's own emphasis style.
    expect(t.model.getValue()).toMatch(/Text here\. (\*\*b\*\*|__b__)\n/);
    expect(t.view.state.doc.rangeHasMark(0, t.view.state.doc.content.size, t.view.state.schema.marks.bold)).toBe(true);
  });

  it("a space at the start of a paragraph or item is not typed, and nothing is refused", () => {
    for (const [text, dialect, needle] of [
      [DOC, "latex", "Second"],
      ["Text.\n\n- one\n\n> quote\n", "markdown", "one"],
      ["Text.\n\n- one\n\n> quote\n", "markdown", "quote"],
    ] as const) {
      const t = setup(text, dialect);
      t.placeAt(needle);
      t.type(" x");
      expect(t.model.getValue()).toBe(text.replace(needle, "x" + needle));
      expect(t.env.binding.model.getValue()).toBe(t.session.text);
    }
  });
});
