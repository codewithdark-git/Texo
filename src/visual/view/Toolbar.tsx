import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Command, EditorState } from "prosemirror-state";
import {
  ArrowRight,
  Asterisk,
  Baseline,
  BookOpen,
  Bold,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Ellipsis,
  FileCog,
  Hash,
  Image,
  Italic,
  Link,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  Pilcrow,
  Plus,
  Redo2,
  SeparatorHorizontal,
  Sigma,
  SquareSigma,
  Subscript,
  Superscript,
  Table,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  TextQuote,
  Underline,
  Undo2,
} from "lucide-react";
import { cssColor, schema, SIZE_SCALE, type Align, type MarkName } from "../core";
import {
  alignAt,
  colorAt,
  isLatex,
  liftItem,
  listKindAt,
  markActive,
  markSupported,
  quoteActive,
  setAlignment,
  setColor,
  setSize,
  setStyle,
  sinkItem,
  sizeAt,
  styleAt,
  toggleList,
  toggleMark,
  toggleQuote,
  type StyleKey,
  type VisualEnv,
} from "./commands";
import * as actions from "./actions";
import { COLOR_MENU, fitGroups, SIZE_LABELS, SIZE_MENU } from "./ribbon";

/** One row of a ribbon menu: a command, or a submenu (`children`). */
export interface Entry {
  key: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  active?: boolean;
  /** Draws the label as the thing it applies (a style, a size). */
  preview?: { className?: string; style?: CSSProperties };
  run?: () => void;
  children?: Entry[];
}

/** A ribbon control: a button, or a dropdown of entries. */
type Tool =
  | { kind: "button"; key: string; label: string; hint?: string; icon: ReactNode; active?: boolean; run(): void }
  | { kind: "menu"; key: string; label: string; icon: ReactNode; face: ReactNode; className?: string; disabled?: boolean; entries: Entry[] };

/** Controls that stay together; the lower `priority`, the longer a group stays out of the "…" menu. */
interface Group {
  key: string;
  priority: number;
  /** Roughly how wide it draws, in pixels, for folding. */
  width: number;
  tools: Tool[];
}

const STYLE_PREVIEW: Record<StyleKey, string> = {
  paragraph: "font-serif text-sm",
  title: "font-serif text-xl font-bold",
  h1: "font-serif text-lg font-bold",
  h2: "font-serif text-base font-bold",
  h3: "font-serif text-sm font-bold",
  h4: "font-serif text-sm font-semibold",
};

/** The Visual mode ribbon, as a word processor has it. Tools the dialect can't spell are left out. */
export function Toolbar({ env, state, width }: { env: VisualEnv; state: EditorState; width: number }) {
  const view = env.view;
  const getEnv = () => env;
  const cmd = (c: Command) => () => {
    c(view.state, view.dispatch, view);
    view.focus();
  };
  const act = (fn: (e: VisualEnv) => unknown) => () => void fn(env);
  const latex = isLatex(env);
  const chapters = latex && env.session.context.hasChapters;
  const list = listKindAt(state);
  const look = latex && !!schema.marks.size;

  const mark = (name: MarkName, label: string, hint: string, icon: ReactNode): Tool | null =>
    markSupported(env, name) ? { kind: "button", key: name, label, hint, icon, active: markActive(state, schema.marks[name]), run: cmd(toggleMark(getEnv, name)) } : null;
  const button = (key: string, label: string, icon: ReactNode, run: () => void, hint?: string, active?: boolean): Tool => ({ kind: "button", key, label, icon, run, hint, active });

  // Styles: Paragraph, Title and headings, each drawn as it looks.
  const style = styleAt(state);
  const styles: [StyleKey, string, string?][] = [
    ["paragraph", "Paragraph", "Ctrl+Alt+0"],
    ...(look ? ([["title", "Title"]] as [StyleKey, string][]) : []),
    ["h1", "Heading 1", chapters ? "Chapter" : "Ctrl+Alt+1"],
    ["h2", "Heading 2", chapters ? "Section" : "Ctrl+Alt+2"],
    ["h3", "Heading 3", chapters ? "Subsection" : "Ctrl+Alt+3"],
  ];
  const styleName = style === "h4" ? "Heading 4" : (styles.find(([k]) => k === style)?.[1] ?? "Style");
  const styleTool: Tool = {
    kind: "menu",
    key: "style",
    label: "Styles",
    icon: <Pilcrow size={15} />,
    face: <span className="truncate">{styleName}</span>,
    className: width < 480 ? "w-24" : "w-32",
    disabled: style === null,
    entries: styles.map(([k, label, hint]) => ({ key: k, label, hint, active: style === k, preview: { className: STYLE_PREVIEW[k] }, run: cmd(setStyle(getEnv, k)) })),
  };

  // Font size: Word's names for LaTeX's sizes; Normal takes the size away.
  const size = sizeAt(state);
  const sizeTool: Tool = {
    kind: "menu",
    key: "size",
    label: "Font size",
    icon: <span className="text-[11px] font-semibold">Aa</span>,
    face: <span className="truncate">{SIZE_LABELS[size ?? "normalsize"]}</span>,
    className: "w-24",
    entries: SIZE_MENU.map((s) => ({
      key: s,
      label: SIZE_LABELS[s],
      active: (size ?? "normalsize") === s,
      preview: { style: { fontSize: `${Math.min(1.6, SIZE_SCALE[s]) * 0.875}rem`, lineHeight: 1.2 } },
      run: cmd(setSize(getEnv, s === "normalsize" ? null : s)),
    })),
  };

  // Text colour: a few safe xcolor names; Automatic takes the colour away.
  const color = colorAt(state);
  const swatch = (name: string | null) => (
    <span
      className={`block size-3.5 rounded-sm border border-border ${name ? "" : "bg-[linear-gradient(135deg,transparent_45%,currentColor_45%,currentColor_55%,transparent_55%)]"}`}
      style={name ? { background: cssColor(name) ?? undefined } : undefined}
    />
  );
  const colorTool: Tool = {
    kind: "menu",
    key: "color",
    label: "Text colour",
    icon: <Baseline size={15} />,
    face: (
      <span className="flex flex-col items-center leading-none">
        <Baseline size={14} />
        <span className="mt-px block h-[3px] w-3.5 rounded-sm" style={{ background: (color && cssColor(color)) || "currentColor" }} />
      </span>
    ),
    entries: COLOR_MENU.map((c) => ({ key: c.name ?? "auto", label: c.label, icon: swatch(c.name), active: color === c.name, run: cmd(setColor(getEnv, c.name)) })),
  };

  const align = alignAt(state);
  const alignTool = (a: Align, label: string, icon: ReactNode): Tool => button(`align-${a}`, label, icon, cmd(setAlignment(getEnv, a)), undefined, align === a);

  // Insert: what a word processor's Insert tab has; LaTeX code sits under Advanced.
  const insert: Entry[] = [
    { key: "table", label: "Table", icon: <Table size={15} />, run: act(actions.table) },
    { key: "figure", label: "Image", icon: <Image size={15} />, run: act(actions.figure) },
    { key: "equation", label: "Equation", hint: "$$", icon: <SquareSigma size={15} />, run: act(actions.mathDisplay) },
    { key: "math", label: "Inline equation", hint: "$ or Ctrl+Shift+M", icon: <Sigma size={15} />, run: act(actions.mathInline) },
    ...(latex
      ? [
          { key: "cite", label: "Citation", hint: "@", icon: <BookOpen size={15} />, run: act((e) => actions.citation(e)) },
          { key: "ref", label: "Cross-reference", hint: "[[", icon: <ArrowRight size={15} />, run: act((e) => actions.reference(e)) },
          { key: "footnote", label: "Footnote", icon: <Asterisk size={15} />, run: act(actions.footnote) },
        ]
      : []),
    ...(markSupported(env, "link") ? [{ key: "link", label: "Link", hint: "Ctrl+K", icon: <Link size={15} />, run: act(actions.link) }] : []),
    ...(latex ? [{ key: "pagebreak", label: "Page break", icon: <SeparatorHorizontal size={15} />, run: act(actions.pageBreak) }] : []),
    {
      key: "advanced",
      label: "Advanced",
      icon: <Braces size={15} />,
      children: [
        { key: "raw", label: latex ? "LaTeX code block" : "Markdown code block", icon: <Braces size={15} />, run: act(actions.rawSource) },
        ...(latex ? [{ key: "label", label: "Label", icon: <Hash size={15} />, run: act(actions.label) }] : []),
      ],
    },
  ];
  const insertTool: Tool = {
    kind: "menu",
    key: "insert",
    label: "Insert",
    icon: <Plus size={15} />,
    face: (
      <span className="flex items-center gap-1">
        <Plus size={14} />
        {width >= 480 && <span>Insert</span>}
      </span>
    ),
    entries: insert,
  };

  const groups = (
    [
    { key: "style", priority: 1, width: width < 480 ? 104 : 136, tools: [styleTool] },
    { key: "size", priority: 5, width: 104, tools: look ? [sizeTool] : [] },
    {
      key: "marks",
      priority: 2,
      width: 100,
      tools: [mark("bold", "Bold", "Ctrl+B", <Bold size={15} />), mark("italic", "Italic", "Ctrl+I", <Italic size={15} />), mark("underline", "Underline", "Ctrl+U", <Underline size={15} />)].filter(
        (t): t is Tool => t !== null,
      ),
    },
    { key: "color", priority: 6, width: 48, tools: look && env.helpers.colorMark("red", env.session.context) ? [colorTool] : [] },
    {
      key: "align",
      priority: 7,
      width: 100,
      tools: look && env.helpers.alignAttrs("center", env.session.context)
        ? [alignTool("left", "Align left", <TextAlignStart size={15} />), alignTool("center", "Centre", <TextAlignCenter size={15} />), alignTool("right", "Align right", <TextAlignEnd size={15} />)]
        : [],
    },
    {
      key: "lists",
      priority: 4,
      width: 164,
      tools: [
        button("bullet", "Bulleted list", <List size={15} />, cmd(toggleList(getEnv, "bullet")), "- then Space", list === "bullet"),
        button("ordered", "Numbered list", <ListOrdered size={15} />, cmd(toggleList(getEnv, "ordered")), "1. then Space", list === "ordered"),
        button("outdent", "Decrease indent", <ListIndentDecrease size={15} />, cmd(liftItem(getEnv)), "Shift+Tab"),
        button("indent", "Increase indent", <ListIndentIncrease size={15} />, cmd(sinkItem(getEnv)), "Tab"),
        button("quote", "Quote", <TextQuote size={15} />, cmd(toggleQuote(getEnv)), "> then Space", quoteActive(state)),
      ],
    },
    { key: "insert", priority: 3, width: width >= 480 ? 84 : 48, tools: [insertTool] },
    {
      key: "more",
      priority: 9,
      width: 100,
      tools: [mark("code", "Monospace", "Ctrl+E", <Code size={15} />), mark("sup", "Superscript", "", <Superscript size={15} />), mark("sub", "Subscript", "", <Subscript size={15} />)].filter(
        (t): t is Tool => t !== null,
      ),
    },
    ] as Group[]
  ).filter((g) => g.tools.length > 0);

  const hasPreamble = latex && state.doc.firstChild?.type === schema.nodes.preamble;
  const tail: Tool[] = [
    ...(hasPreamble ? [button("pagesetup", "Page setup", <FileCog size={15} />, act(actions.pageSetup), "Paper, margins, font and spacing")] : []),
    button("undo", "Undo", <Undo2 size={15} />, () => env.binding.undo(), "Ctrl+Z"),
    button("redo", "Redo", <Redo2 size={15} />, () => env.binding.redo(), "Ctrl+Y"),
  ];

  const { shown, folded } = fitGroups(groups, width, 24 + tail.length * 30);
  const foldedEntries: Entry[] = folded.flatMap((g) => g.tools.map(toEntry));

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-20 flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-border bg-surface/95 px-2 backdrop-blur"
      onMouseDown={(e) => {
        // Keep the editor's selection while using the ribbon.
        e.preventDefault();
      }}
    >
      {/* Clipped rather than spilling over the PDF pane while a resize settles. */}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {shown.map((g, i) => (
          <div key={g.key} className={`flex shrink-0 items-center gap-0.5 ${i ? "border-l border-border pl-1" : ""}`}>
            {g.tools.map((t) => (t.kind === "button" ? <ToolButton key={t.key} tool={t} /> : <MenuTool key={t.key} tool={t} />))}
          </div>
        ))}
      </div>
      {foldedEntries.length > 0 && (
        <div className="border-l border-border pl-1">
          <DropMenu title="More" ariaLabel="More tools" entries={foldedEntries} className="size-7 justify-center">
            <Ellipsis size={15} />
          </DropMenu>
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {tail.map((t) => t.kind === "button" && <ToolButton key={t.key} tool={t} />)}
      </div>
    </div>
  );
}

/** A ribbon tool as a row of the "…" menu: a dropdown becomes a submenu. */
function toEntry(t: Tool): Entry {
  if (t.kind === "button") return { key: t.key, label: t.label, hint: t.hint, icon: t.icon, active: t.active, run: t.run };
  return { key: t.key, label: t.label, icon: t.icon, children: t.entries };
}

function ToolButton({ tool }: { tool: Extract<Tool, { kind: "button" }> }) {
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

function MenuTool({ tool }: { tool: Extract<Tool, { kind: "menu" }> }) {
  return (
    <DropMenu title={tool.label} ariaLabel={tool.label} entries={tool.entries} disabled={tool.disabled} className={`gap-1 px-1.5 text-xs ${tool.className ?? ""}`} chevron>
      {tool.face}
    </DropMenu>
  );
}

/**
 * A ribbon dropdown. The list is drawn in a portal so the ribbon's clipping
 * never cuts it off, and mouse presses in it never move the editor's selection.
 */
function DropMenu({
  title,
  ariaLabel,
  entries,
  disabled,
  className,
  chevron,
  children,
}: {
  title: string;
  ariaLabel: string;
  entries: Entry[];
  disabled?: boolean;
  className?: string;
  chevron?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const byKey = useRef(false);

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 248)), top: r.bottom + 4 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (byKey.current) list.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onResize = () => setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Up and down move between the rows, as in any menu.
  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...(list.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    rows[(at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => {
          // A click from the keyboard (Enter or Space) has no pointer detail: focus the first row.
          byKey.current = e.detail === 0;
          setOpen((o) => !o);
        }}
        className={`flex h-7 shrink-0 items-center rounded-md text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50 aria-expanded:bg-surface-2 aria-expanded:text-text ${className ?? ""}`}
      >
        <span className="flex min-w-0 flex-1 items-center">{children}</span>
        {chevron && <ChevronDown size={12} className="shrink-0 opacity-70" />}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            role="menu"
            aria-label={ariaLabel}
            style={{ left: pos.left, top: pos.top }}
            onMouseDown={(e) => e.preventDefault()}
            onKeyDown={onListKey}
            className="fixed z-50 max-h-[70vh] min-w-52 overflow-y-auto rounded-lg border border-border bg-surface p-1 text-text shadow-xl"
          >
            <EntryList entries={entries} close={() => setOpen(false)} />
          </div>,
          document.body,
        )}
    </>
  );
}

function EntryList({ entries, close, depth = 0 }: { entries: Entry[]; close: () => void; depth?: number }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <>
      {entries.map((item) => {
        const sub = item.children && item.children.length > 0;
        const isOpen = expanded === item.key;
        return (
          <div key={item.key}>
            <button
              // A choice (a style, a size, a colour) says whether it is the current one.
              role={item.active === undefined ? "menuitem" : "menuitemradio"}
              type="button"
              aria-haspopup={sub ? "menu" : undefined}
              aria-expanded={sub ? isOpen : undefined}
              aria-checked={item.active === undefined ? undefined : item.active}
              onClick={() => {
                if (sub) return setExpanded(isOpen ? null : item.key);
                close();
                item.run?.();
              }}
              onKeyDown={(e) => {
                if (sub && e.key === "ArrowRight") setExpanded(item.key);
                if (sub && e.key === "ArrowLeft") setExpanded(null);
              }}
              style={{ paddingLeft: 10 + depth * 14 }}
              className={`flex w-full items-center gap-2.5 rounded-md py-1.5 pr-2.5 text-left text-sm hover:bg-surface-2 focus:bg-surface-2 focus:outline-none ${item.active ? "bg-accent/10" : ""}`}
            >
              <span className="flex w-4 shrink-0 justify-center text-muted">{item.icon ?? (item.active ? <Check size={14} /> : null)}</span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate ${item.preview?.className ?? ""}`} style={item.preview?.style}>
                  {item.label}
                </span>
                {item.hint && <span className="block text-xs text-muted">{item.hint}</span>}
              </span>
              {sub ? <ChevronRight size={14} className={`shrink-0 text-muted transition-transform ${isOpen ? "rotate-90" : ""}`} /> : item.active && item.icon ? <Check size={14} className="shrink-0 text-muted" /> : null}
            </button>
            {sub && isOpen && <EntryList entries={item.children!} close={close} depth={depth + 1} />}
          </div>
        );
      })}
    </>
  );
}
