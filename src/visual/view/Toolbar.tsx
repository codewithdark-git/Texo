import type { ReactNode } from "react";
import type { Command, EditorState } from "prosemirror-state";
import {
  ArrowRight,
  Asterisk,
  BookOpen,
  Bold,
  Braces,
  Code,
  Ellipsis,
  Hash,
  Image,
  Italic,
  Link,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  Redo2,
  Sigma,
  SquareSigma,
  Subscript,
  Superscript,
  Table,
  TextQuote,
  Underline,
  Undo2,
} from "lucide-react";
import { Menu, type MenuItem } from "../../components/Menu";
import { schema, type MarkName } from "../core";
import {
  blockLevel,
  isLatex,
  liftItem,
  listKindAt,
  markActive,
  markSupported,
  quoteActive,
  setBlock,
  sinkItem,
  toggleList,
  toggleMark,
  toggleQuote,
  type VisualEnv,
} from "./commands";
import * as actions from "./actions";

interface Tool {
  key: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  active?: boolean;
  run(): void;
}

/** The Visual mode toolbar. Tools the dialect can't spell are left out. */
export function Toolbar({ env, state, width }: { env: VisualEnv; state: EditorState; width: number }) {
  const view = env.view;
  const getEnv = () => env;
  const cmd = (c: Command) => () => {
    c(view.state, view.dispatch, view);
    view.focus();
  };
  const act = (fn: (e: VisualEnv) => void) => () => fn(env);
  const latex = isLatex(env);
  const chapters = latex && env.session.context.hasChapters;
  const list = listKindAt(state);
  const level = blockLevel(state);

  const mark = (name: MarkName, label: string, hint: string, icon: ReactNode): Tool | null =>
    markSupported(env, name)
      ? { key: name, label, hint, icon, active: markActive(state, schema.marks[name]), run: cmd(toggleMark(getEnv, name)) }
      : null;

  const groups: (Tool | null)[][] = [
    [
      mark("bold", "Bold", "Ctrl+B", <Bold size={15} />),
      mark("italic", "Italic", "Ctrl+I", <Italic size={15} />),
      mark("underline", "Underline", "Ctrl+U", <Underline size={15} />),
      mark("code", "Monospace", "Ctrl+E", <Code size={15} />),
      mark("sup", "Superscript", "", <Superscript size={15} />),
      mark("sub", "Subscript", "", <Subscript size={15} />),
      markSupported(env, "link") ? { key: "link", label: "Link", hint: "Ctrl+K", icon: <Link size={15} />, active: markActive(state, schema.marks.link), run: act(actions.link) } : null,
    ],
    [
      { key: "bullet", label: "Bulleted list", hint: "- then Space", icon: <List size={15} />, active: list === "bullet", run: cmd(toggleList(getEnv, "bullet")) },
      { key: "ordered", label: "Numbered list", hint: "1. then Space", icon: <ListOrdered size={15} />, active: list === "ordered", run: cmd(toggleList(getEnv, "ordered")) },
      { key: "indent", label: "Indent", hint: "Tab", icon: <ListIndentIncrease size={15} />, run: cmd(sinkItem(getEnv)) },
      { key: "outdent", label: "Outdent", hint: "Shift+Tab", icon: <ListIndentDecrease size={15} />, run: cmd(liftItem(getEnv)) },
      { key: "quote", label: "Quote", hint: "> then Space", icon: <TextQuote size={15} />, active: quoteActive(state), run: cmd(toggleQuote(getEnv)) },
    ],
    [
      { key: "math", label: "Inline maths", hint: "$ or Ctrl+Shift+M", icon: <Sigma size={15} />, run: act(actions.mathInline) },
      { key: "display", label: "Display maths", hint: "$$", icon: <SquareSigma size={15} />, run: act(actions.mathDisplay) },
    ],
    latex
      ? [
          { key: "cite", label: "Citation", hint: "@", icon: <BookOpen size={15} />, run: act((e) => actions.citation(e)) },
          { key: "ref", label: "Reference", hint: "[[", icon: <ArrowRight size={15} />, run: act((e) => actions.reference(e)) },
          { key: "label", label: "Label", icon: <Hash size={15} />, run: act(actions.label) },
          { key: "footnote", label: "Footnote", icon: <Asterisk size={15} />, run: act(actions.footnote) },
        ]
      : [],
    [
      { key: "figure", label: "Figure", icon: <Image size={15} />, run: act(actions.figure) },
      { key: "table", label: "Table", icon: <Table size={15} />, run: act(actions.table) },
      { key: "raw", label: latex ? "Raw LaTeX" : "Raw Markdown", icon: <Braces size={15} />, run: act(actions.rawSource) },
    ],
    [
      { key: "undo", label: "Undo", hint: "Ctrl+Z", icon: <Undo2 size={15} />, run: () => env.binding.undo() },
      { key: "redo", label: "Redo", hint: "Ctrl+Y", icon: <Redo2 size={15} />, run: () => env.binding.redo() },
    ],
  ];

  // Narrow panes fold the trailing groups into a "…" menu (undo and redo stay).
  const visible = width >= 1000 ? groups.length : width >= 760 ? 3 : width >= 640 ? 2 : width >= 480 ? 1 : 0;
  const shown = groups.slice(0, Math.min(visible, groups.length - 1));
  const folded = groups.slice(shown.length, groups.length - 1).flat().filter((t): t is Tool => t !== null);
  const tail = groups[groups.length - 1];

  const levels: [number, string][] = [
    [0, "Paragraph"],
    [1, chapters ? "Chapter" : latex ? "Section" : "Heading 1"],
    [2, chapters ? "Section" : latex ? "Subsection" : "Heading 2"],
    [3, chapters ? "Subsection" : latex ? "Subsubsection" : "Heading 3"],
    [4, chapters ? "Subsubsection" : latex ? "Paragraph heading" : "Heading 4"],
  ];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-20 flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-border bg-surface/95 px-2 backdrop-blur"
      onMouseDown={(e) => {
        // Keep the editor's selection while using the toolbar.
        if (!(e.target as HTMLElement).closest("select")) e.preventDefault();
      }}
    >
      <select
        aria-label="Block type"
        title="Block type (Ctrl+Alt+0 to 4)"
        value={level < 0 ? "" : String(level)}
        disabled={level < 0}
        onChange={(e) => {
          const v = Number(e.target.value) as 0 | 1 | 2 | 3 | 4;
          setBlock(getEnv, v)(view.state, view.dispatch, view);
          view.focus();
        }}
        className={`h-7 ${width < 480 ? "w-28" : "w-36"} shrink-0 rounded-md border border-border bg-bg px-1.5 text-xs text-text outline-none disabled:opacity-50`}
      >
        {level < 0 && <option value="">—</option>}
        {levels.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      {/* Clipped rather than spilling over the PDF pane while a resize settles. */}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {shown.map((g, i) =>
          g.some(Boolean) ? (
            <div key={i} className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1">
              {g.map((t) => t && <ToolButton key={t.key} tool={t} />)}
            </div>
          ) : null,
        )}
      </div>
      {folded.length > 0 && (
        <div className="border-l border-border pl-1">
          <Menu
            align="left"
            trigger={({ toggle, open }) => (
              <button
                type="button"
                title="More"
                aria-label="More tools"
                aria-expanded={open}
                onClick={toggle}
                className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
              >
                <Ellipsis size={15} />
              </button>
            )}
            items={folded.map(
              (t): MenuItem => ({
                label: t.label,
                hint: t.hint,
                icon: t.icon,
                onSelect: t.run,
              }),
            )}
          />
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">{tail.map((t) => t && <ToolButton key={t.key} tool={t} />)}</div>
    </div>
  );
}

function ToolButton({ tool }: { tool: Tool }) {
  return (
    <button
      type="button"
      title={tool.hint ? `${tool.label} (${tool.hint})` : tool.label}
      aria-label={tool.label}
      aria-pressed={tool.active === undefined ? undefined : tool.active}
      onClick={tool.run}
      className={`flex size-7 items-center justify-center rounded-md ${
        tool.active ? "bg-accent/20 text-text" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      {tool.icon}
    </button>
  );
}
