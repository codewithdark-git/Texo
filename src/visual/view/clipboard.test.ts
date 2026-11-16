import { describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Slice } from "prosemirror-model";
import { createSession, helpersFor, schema, type Dialect } from "../core";
import { Binding } from "./binding";
import { clipboardTextParser, transformPasted } from "./clipboard";
import type { VisualEnv } from "./commands";
import { FakeModel, FakeView } from "./testkit";

function setup(text: string, dialect: Dialect = "latex") {
  const model = new FakeModel(text);
  const session = createSession(dialect, text);
  const view = new FakeView(EditorState.create({ doc: session.doc }));
  const toast = vi.fn();
  const binding = new Binding({ session, model, view, host: { toast, dev: true } });
  const env: VisualEnv = {
    path: "a.tex",
    dialect,
    session,
    binding,
    helpers: helpersFor(dialect),
    view: Object.assign(view, { dispatch: binding.dispatch }) as unknown as EditorView,
    toast,
    openInCode() {},
  };
  /** Pastes plain text after `needle`, as the view would. */
  const paste = (needle: string, clip: string) => {
    let pos = -1;
    view.state.doc.descendants((n, p) => {
      if (pos < 0 && n.isText && n.text!.includes(needle)) pos = p + n.text!.indexOf(needle) + needle.length;
    });
    const slice = clipboardTextParser(() => env)(clip, view.state.doc.resolve(pos));
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).replaceSelection(slice);
    binding.dispatch(tr);
  };
  return { model, session, env, toast, paste };
}

const DOC = "Hello world.\n\nSecond.\n";

describe("Visual paste", () => {
  it("keeps the space before pasted words", () => {
    const t = setup(DOC);
    t.paste("Hello", " there");
    expect(t.model.getValue()).toBe("Hello there world.\n\nSecond.\n");
    t.paste("there", " \\textbf{big}");
    expect(t.model.getValue()).toBe("Hello there \\textbf{big} world.\n\nSecond.\n");
    expect(t.toast).not.toHaveBeenCalled();
  });

  it("joins the first and last pasted paragraphs to the text around the cursor", () => {
    const t = setup(DOC);
    t.paste("Hello", " one \\emph{a}\n\ntwo");
    expect(t.model.getValue()).toBe("Hello one \\emph{a}\n\ntwo world.\n\nSecond.\n");
    expect(t.toast).not.toHaveBeenCalled();
  });

  it("splits plain text into paragraphs at blank lines and escapes it", () => {
    const t = setup(DOC);
    t.paste("world.", " 50 percent\n\nmore");
    expect(t.model.getValue()).toBe("Hello world. 50 percent\n\nmore\n\nSecond.\n");
    t.paste("more", " a & b");
    expect(t.model.getValue()).toContain("more a \\& b");
  });

  it("gives marks pasted from elsewhere this file's spelling", () => {
    const t = setup(DOC, "markdown");
    const foreign = schema.text("x", [schema.marks.bold.create({ open: "<b>", close: "</b>", gid: 0, depth: 0 })]);
    const out = transformPasted(() => t.env)(new Slice(schema.nodes.paragraph.create(null, foreign).content, 0, 0));
    const mark = out.content.firstChild!.marks[0];
    expect(mark.type.name).toBe("bold");
    expect(mark.attrs.open).not.toBe("<b>");
  });

  it("pastes lines into code with the file's own line breaks", () => {
    const text = "Hi.\r\n\r\n```\r\nab\r\n```\r\n";
    const t = setup(text, "markdown");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    t.paste("a", "x\ny\r\nz");
    expect(t.model.getValue()).toBe("Hi.\r\n\r\n```\r\nax\r\ny\r\nzb\r\n```\r\n");
    expect(t.session.text).toBe(t.model.getValue());
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
