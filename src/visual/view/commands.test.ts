import { describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { joinBackward } from "prosemirror-commands";
import type { Node as PMNode } from "prosemirror-model";
import { createSession, helpersFor, type Dialect } from "../core";
import { Binding } from "./binding";
import {
  enter,
  hardBreak,
  insertBlocks,
  insertInlineSrc,
  insertMathDisplay,
  insertMathInline,
  normalizeTransaction,
  setBlock,
  sinkItem,
  toggleList,
  toggleMark,
  toggleQuote,
  toEol,
  uniqueLabel,
  type VisualEnv,
} from "./commands";
import { FakeModel, FakeView } from "./testkit";

function setup(text: string, dialect: Dialect = "latex") {
  const model = new FakeModel(text);
  const session = createSession(dialect, text);
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
  const run = (cmd: (s: EditorState, d?: (tr: import("prosemirror-state").Transaction) => void) => boolean) => cmd(view.state, binding.dispatch);
  const at = (needle: string, offset = 0) => {
    const pos = posOf(view.state.doc, needle) + offset;
    binding.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  };
  const select = (needle: string) => {
    const pos = posOf(view.state.doc, needle);
    binding.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos, pos + needle.length)));
  };
  const done = () => {
    expect(toast).not.toHaveBeenCalled();
    expect(session.verify()).toEqual({ ok: true });
    expect(session.text).toBe(model.getValue());
    warn.mockRestore();
  };
  return { model, session, view, binding, env, getEnv, run, at, select, done, toast };
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

const DOC = "\\documentclass{article}\n\\begin{document}\n\nHello world here.\n\nSecond one.\n\n\\end{document}\n";

describe("Visual commands (LaTeX)", () => {
  it("bold and italic wrap the selection with \\textbf and \\emph", () => {
    const t = setup(DOC);
    t.select("world");
    expect(t.run(toggleMark(t.getEnv, "bold"))).toBe(true);
    expect(t.model.getValue()).toContain("Hello \\textbf{world} here.");
    t.select("here");
    t.run(toggleMark(t.getEnv, "italic"));
    expect(t.model.getValue()).toContain("\\emph{here}.");
    t.select("world");
    t.run(toggleMark(t.getEnv, "bold"));
    expect(t.model.getValue()).toContain("Hello world \\emph{here}.");
    t.done();
  });

  it("turns a paragraph into a section and back without losing text", () => {
    const t = setup(DOC);
    t.at("Hello");
    t.run(setBlock(t.getEnv, 1));
    expect(t.model.getValue()).toContain("\\section{Hello world here.}");
    t.run(setBlock(t.getEnv, 2));
    expect(t.model.getValue()).toContain("\\subsection{Hello world here.}");
    t.run(setBlock(t.getEnv, 0));
    expect(t.model.getValue()).toBe(DOC);
    t.done();
  });

  it("keeps a heading's trailing \\label when it becomes a paragraph", () => {
    const text = DOC.replace("Second one.", "\\section{Intro}\\label{sec:intro}");
    const t = setup(text);
    t.at("Intro");
    expect(t.run(setBlock(t.getEnv, 0))).toBe(true);
    expect(t.model.getValue()).toContain("\n\nIntro\\label{sec:intro}\n");
    t.done();
  });

  it("wraps a paragraph in itemize, splits items, nests and leaves", () => {
    const t = setup(DOC);
    t.at("Hello");
    t.run(toggleList(t.getEnv, "bullet"));
    expect(t.model.getValue()).toMatch(/\\begin\{itemize\}\s+\\item Hello world here\.\s+\\end\{itemize\}/);
    t.at("here.", 5);
    t.run(enter(t.getEnv));
    t.binding.dispatch(t.view.state.tr.insertText("Next"));
    expect(t.model.getValue()).toMatch(/\\item Hello world here\.\s+\\item Next\s+\\end\{itemize\}/);
    t.run(toggleList(t.getEnv, "ordered"));
    expect(t.model.getValue()).toContain("\\begin{enumerate}");
    t.run(sinkItem(t.getEnv));
    expect(t.model.getValue().match(/\\begin\{enumerate\}/g)?.length).toBe(2);
    t.done();
  });

  it("Enter splits a paragraph and a new paragraph takes typing; Backspace joins", () => {
    const t = setup(DOC);
    t.at("here.", 5);
    t.run(enter(t.getEnv));
    t.binding.dispatch(t.view.state.tr.insertText("New"));
    expect(t.model.getValue()).toContain("Hello world here.\n\nNew\n\nSecond one.");
    t.at("world");
    t.run(enter(t.getEnv));
    expect(t.model.getValue()).toContain("Hello \n\nworld here.");
    t.at("world");
    t.run(joinBackward);
    expect(t.model.getValue()).toContain("Hello world here.");
    t.done();
  });

  it("wraps a paragraph in a quote and unwraps it", () => {
    const t = setup(DOC);
    t.at("Second");
    t.run(toggleQuote(t.getEnv));
    expect(t.model.getValue()).toMatch(/\\begin\{quote\}\s+Second one\.\s+\\end\{quote\}/);
    t.run(toggleQuote(t.getEnv));
    expect(t.model.getValue()).toBe(DOC);
    t.done();
  });

  it("inserts maths, chips, a line break and blocks", () => {
    const t = setup(DOC);
    t.at("world");
    insertMathInline(t.env, "x^2");
    expect(t.model.getValue()).toContain("Hello $x^2$world");
    insertInlineSrc(t.env, "\\cite{knuth}");
    expect(t.model.getValue()).toContain("$x^2$\\cite{knuth}world");
    t.run(hardBreak(t.getEnv));
    expect(t.model.getValue()).toContain("\\cite{knuth}\\\\\nworld");
    t.at("Second");
    insertMathDisplay(t.env, "E = mc^2", "brackets");
    expect(t.model.getValue()).toContain("\\[\n  E = mc^2\n\\]");
    insertBlocks(t.env, "\\newpage");
    expect(t.model.getValue()).toContain("\\newpage");
    t.done();
  });

  it("inserts a figure and adds graphicx to the preamble in the same step", () => {
    const t = setup(DOC);
    t.at("Second");
    const src = t.env.helpers.figureSrc("figures/plot.png", "fig:plot", t.session.context);
    insertBlocks(t.env, src, ["graphicx"]);
    const text = t.model.getValue();
    expect(text).toContain("\\usepackage{graphicx}\n\\begin{document}");
    expect(text).toContain("\\includegraphics[width=0.8\\linewidth]{figures/plot.png}");
    expect(t.toast).toHaveBeenCalledWith("Added \\usepackage{graphicx}", "info");
    t.toast.mockClear();
    t.model.undo();
    expect(t.model.getValue()).toBe(DOC);
    t.done();
  });

  it("adds amsmath for equation* display maths", () => {
    const t = setup(DOC);
    t.at("Second");
    insertMathDisplay(t.env, "E = mc^2", "equation");
    const text = t.model.getValue();
    expect(text).toContain("\\begin{equation*}");
    expect(text).toContain("\\usepackage{amsmath}\n\\begin{document}");
    expect(t.toast).toHaveBeenCalledWith("Added \\usepackage{amsmath}", "info");
    t.toast.mockClear();
    t.done();
  });

  it("gives each new table its own label", () => {
    expect(uniqueLabel("tab:new", [])).toBe("tab:new");
    expect(uniqueLabel("tab:new", ["tab:new", "tab:new2"])).toBe("tab:new3");
    const t = setup(DOC);
    t.at("Second");
    insertBlocks(t.env, t.env.helpers.tableSrc(1, 2, t.session.context, "tab:new2"));
    expect(t.model.getValue()).toContain("\\label{tab:new2}");
    t.done();
  });

  it("writes text from the page with the file's line breaks", () => {
    expect(toEol("a\nb\r\nc\rd", "\r\n")).toBe("a\r\nb\r\nc\r\nd");
    expect(toEol("a\r\nb", "\n")).toBe("a\nb");
    const crlf = DOC.replace(/\n/g, "\r\n");
    const t = setup(crlf);
    t.at("Second");
    insertMathDisplay(t.env, "a \\\\\nb", "brackets");
    insertBlocks(t.env, "\\begin{center}\nx\n\\end{center}");
    expect(t.model.getValue()).not.toMatch(/[^\r]\n/);
    t.done();
  });

  it("inserts a table", () => {
    const t = setup(DOC);
    t.at("Second");
    insertBlocks(t.env, t.env.helpers.tableSrc(2, 3, t.session.context));
    expect(t.model.getValue()).toContain("\\begin{tabular}{|l|l|l|}");
    t.done();
  });
});

describe("Visual commands (Markdown)", () => {
  const MD = "# Title\n\nSome text here.\n\nMore.\n";

  it("uses Markdown spelling", () => {
    const t = setup(MD, "markdown");
    t.select("text");
    t.run(toggleMark(t.getEnv, "bold"));
    expect(t.model.getValue()).toContain("Some **text** here.");
    t.at("More");
    t.run(toggleList(t.getEnv, "bullet"));
    expect(t.model.getValue()).toContain("- More.");
    t.at("Some");
    t.run(setBlock(t.getEnv, 2));
    expect(t.model.getValue()).toContain("## Some **text** here.");
    t.done();
  });

  it("Enter on an empty item in the middle of a list stays put instead of being refused", () => {
    const t = setup("1. first\n2. second\n", "markdown");
    t.at("first", 5);
    t.run(enter(t.getEnv));
    const withItem = t.model.getValue();
    expect(withItem).toMatch(/1\. first\n2\.\n/);
    t.run(enter(t.getEnv));
    expect(t.model.getValue()).toBe(withItem);
    t.done();
  });

  it("has no underline in Markdown", () => {
    const t = setup(MD, "markdown");
    t.select("text");
    expect(t.run(toggleMark(t.getEnv, "underline"))).toBe(false);
    t.done();
  });
});

describe("Visual commands inside quotes and lists", () => {
  const QUOTE =
    "\\documentclass{article}\n\\begin{document}\n\\begin{quote}\nQuoted text.\n\\end{quote}\n\nLast.\n\n\\begin{itemize}\n\\item one\n\\end{itemize}\n\nAfter.\n\\end{document}\n";
  const QUOTE_MD = "> quote text\n\nLast.\n\n- one\n\nAfter.\n";
  const user = (t: ReturnType<typeof setup>) => (cmd: (s: EditorState, d?: (tr: import("prosemirror-state").Transaction) => void) => boolean) =>
    cmd(t.view.state, (tr) => t.binding.dispatch(normalizeTransaction(t.env, tr)));

  it("Enter inside a LaTeX quote starts a new paragraph in it", () => {
    const t = setup(QUOTE);
    t.at("text");
    t.run(enter(t.getEnv));
    expect(t.model.getValue()).toContain("\\begin{quote}\nQuoted \n\ntext.\n\\end{quote}");
    t.done();
  });

  it("Enter inside a Markdown quote keeps both lines quoted", () => {
    const t = setup(QUOTE_MD, "markdown");
    t.at("text");
    t.run(enter(t.getEnv));
    expect(t.model.getValue()).toBe("> quote \n>\n> text\n\nLast.\n\n- one\n\nAfter.\n");
    t.done();
  });

  it("Enter twice at the end of a quote leaves it, and typing goes after it", () => {
    for (const [text, dialect, want] of [
      [QUOTE, "latex", "\\end{quote}\n\nOut\n\nLast."],
      [QUOTE_MD, "markdown", "> quote text\n\nOut\n\nLast."],
    ] as const) {
      const t = setup(text, dialect);
      if (dialect === "latex") t.at("text.", 5);
      else t.at("text", 4);
      t.run(enter(t.getEnv));
      expect(t.model.getValue()).toBe(text);
      t.run(enter(t.getEnv));
      t.binding.dispatch(t.view.state.tr.insertText("Out"));
      expect(t.model.getValue()).toContain(want);
      t.done();
    }
  });

  it("Backspace joins a paragraph into the quote before it", () => {
    for (const [text, dialect] of [[QUOTE, "latex"], [QUOTE_MD, "markdown"]] as const) {
      const t = setup(text, dialect);
      t.at("Last");
      expect(user(t)(joinBackward)).toBe(true);
      expect(t.view.state.doc.toString()).toMatch(/container\(paragraph\("[a-zA-Z .]+"\), paragraph\("Last\."\)\)/);
      t.done();
    }
  });

  it("Backspace after a list makes the paragraph a spelled list item", () => {
    const t = setup(QUOTE);
    t.at("After");
    expect(user(t)(joinBackward)).toBe(true);
    expect(t.model.getValue()).toMatch(/\\item one\s+\\item After\.\s+\\end\{itemize\}/);
    t.done();
    const m = setup(QUOTE_MD, "markdown");
    m.at("After");
    expect(user(m)(joinBackward)).toBe(true);
    expect(m.model.getValue()).toMatch(/- one\n+- After\.\n$/);
    m.done();
  });

  it("normalizing leaves ordinary typing as one text step", () => {
    const t = setup(QUOTE_MD, "markdown");
    t.at("one", 3);
    const tr = t.view.state.tr.insertText("x");
    expect(normalizeTransaction(t.env, tr).steps.length).toBe(1);
    t.done();
  });
});
