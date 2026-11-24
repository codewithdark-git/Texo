import { describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { createSession, helpersFor, type Dialect } from "../core";
import { Binding } from "./binding";
import {
  alignAt,
  colorAt,
  hardBreak,
  insertPageBreak,
  setAlignment,
  setColor,
  setSize,
  setStyle,
  sizeAt,
  styleAt,
  type VisualEnv,
} from "./commands";
import { FakeModel, FakeView } from "./testkit";

function setup(src: string, dialect: Dialect = "latex") {
  const model = new FakeModel(src);
  const session = createSession(dialect, src);
  const view = new FakeView(EditorState.create({ doc: session.doc }));
  const toast = vi.fn();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const binding = new Binding({ session, model, view, host: { toast, dev: true } });
  const pmView = Object.assign(view, { dispatch: binding.dispatch, focus() {} }) as unknown as EditorView;
  const env: VisualEnv = {
    path: dialect === "latex" ? "main.tex" : "notes.md",
    dialect,
    session,
    binding,
    helpers: helpersFor(dialect),
    view: pmView,
    toast,
    openInCode() {},
  };
  const getEnv = () => env;
  const run = (cmd: (s: EditorState, d?: (tr: Transaction) => void) => boolean) => cmd(view.state, binding.dispatch);
  const select = (needle: string) => {
    const pos = posOf(view.state.doc, needle);
    binding.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos, pos + needle.length)));
  };
  const at = (needle: string) => {
    const pos = posOf(view.state.doc, needle);
    binding.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  };
  const text = () => model.getValue();
  const done = () => {
    expect(session.verify()).toEqual({ ok: true });
    expect(session.text).toBe(model.getValue());
    // Nothing was refused along the way.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  };
  return { model, session, view, env, getEnv, run, select, at, text, done, toast };
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

const wrap = (body: string, pre = "") => `\\documentclass{article}\n${pre}\\begin{document}\n\n${body}\n\n\\end{document}\n`;

describe("font size", () => {
  it("sets, changes and clears a size", () => {
    const t = setup(wrap("Hello big world."));
    t.select("big");
    expect(t.run(setSize(t.getEnv, "Large"))).toBe(true);
    expect(t.text()).toContain("Hello {\\Large big} world.");
    expect(sizeAt(t.view.state)).toBe("Large");
    t.select("big");
    t.run(setSize(t.getEnv, "small"));
    expect(t.text()).toContain("Hello {\\small big} world.");
    t.select("big");
    t.run(setSize(t.getEnv, null));
    expect(t.text()).toContain("Hello big world.");
    expect(sizeAt(t.view.state)).toBeNull();
    t.done();
  });

  it("respells a hand-set title when only part of it changes", () => {
    const t = setup(wrap("{\\LARGE\\bfseries Big Title\\par}"));
    t.select("Big");
    t.run(setSize(t.getEnv, "small"));
    // Nothing refused: the bold and the rest of the size are spelled so they hold on their own.
    expect(t.text()).toBe(wrap("\\textbf{{\\small Big} {\\LARGE Title\\par}}"));
    t.done();
  });

  it("is LaTeX only", () => {
    const t = setup("Hello world.\n", "markdown");
    t.select("world");
    expect(t.run(setSize(t.getEnv, "Large"))).toBe(false);
    expect(t.run(setColor(t.getEnv, "red"))).toBe(false);
    expect(t.run(setAlignment(t.getEnv, "center"))).toBe(false);
    expect(insertPageBreak(t.env)).toBe(false);
    t.done();
  });
});

describe("text colour", () => {
  it("adds xcolor once, then colours with \\textcolor", () => {
    const t = setup(wrap("One red word and one blue word."));
    t.select("red");
    t.run(setColor(t.getEnv, "red"));
    expect(t.text()).toContain("\\usepackage{xcolor}\n\\begin{document}");
    expect(t.text()).toContain("One \\textcolor{red}{red} word");
    expect(t.toast).toHaveBeenCalledWith("Added \\usepackage{xcolor}", "info");
    t.select("blue");
    t.run(setColor(t.getEnv, "blue"));
    expect(t.text().match(/usepackage\{xcolor\}/g)).toHaveLength(1);
    expect(colorAt(t.view.state)).toBe("blue");
    t.select("red");
    t.run(setColor(t.getEnv, null));
    expect(t.text()).toContain("One red word and one \\textcolor{blue}{blue} word.");
    t.done();
  });

  it("leaves an existing xcolor (with options) alone", () => {
    const t = setup(wrap("Paint me.", "\\usepackage[dvipsnames]{xcolor}\n"));
    t.select("Paint");
    t.run(setColor(t.getEnv, "teal"));
    expect(t.text().match(/xcolor/g)).toHaveLength(1);
    expect(t.text()).toContain("\\textcolor{teal}{Paint} me.");
    expect(t.toast).not.toHaveBeenCalled();
    t.done();
  });

  it("refuses names xcolor wouldn't know as written", () => {
    const t = setup(wrap("Text."));
    t.select("Text");
    expect(t.run(setColor(t.getEnv, "not a colour"))).toBe(false);
    t.done();
  });
});

describe("alignment", () => {
  it("centres a paragraph, switches it right, and takes it away again", () => {
    const t = setup(wrap("First.\n\nSecond."));
    t.at("First");
    t.run(setAlignment(t.getEnv, "center"));
    expect(t.text()).toContain("\\begin{center}\nFirst.\n\\end{center}\n\nSecond.");
    expect(alignAt(t.view.state)).toBe("center");
    t.run(setAlignment(t.getEnv, "right"));
    expect(t.text()).toContain("\\begin{flushright}\nFirst.\n\\end{flushright}");
    t.run(setAlignment(t.getEnv, "right"));
    expect(t.text()).toBe(wrap("First.\n\nSecond."));
    expect(alignAt(t.view.state)).toBeNull();
    t.done();
  });
});

describe("styles and breaks", () => {
  it("makes a Title and back", () => {
    const t = setup(wrap("My Paper\n\nBody."));
    t.at("My Paper");
    t.run(setStyle(t.getEnv, "title"));
    expect(t.text()).toContain("\\begin{center}\n\\textbf{{\\LARGE My Paper}}\n\\end{center}");
    expect(styleAt(t.view.state)).toBe("title");
    t.run(setStyle(t.getEnv, "paragraph"));
    expect(t.text()).toBe(wrap("My Paper\n\nBody."));
    expect(styleAt(t.view.state)).toBe("paragraph");
    t.run(setStyle(t.getEnv, "h2"));
    expect(t.text()).toContain("\\subsection{My Paper}");
    expect(styleAt(t.view.state)).toBe("h2");
    t.done();
  });

  it("inserts a page break as \\newpage and a line break as \\\\", () => {
    const t = setup(wrap("First.\n\nSecond."));
    t.at("First");
    expect(insertPageBreak(t.env)).toBe(true);
    expect(t.text()).toContain("First.\n\n\\newpage\n\nSecond.");
    t.at("Second");
    t.run(hardBreak(t.getEnv));
    expect(t.text()).toContain("\\\\\nSecond.");
    let atoms = 0;
    t.view.state.doc.descendants((n) => void (n.type.name === "spacing" && atoms++));
    expect(atoms).toBe(1);
    t.done();
  });
});
