// What the toolbar, the slash menu, and the shortcuts do when they need a
// picker or a popover first: maths, citations, references, labels,
// footnotes, links, figures, tables and raw source.

import { TextSelection, type Command } from "prosemirror-state";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { schema } from "../core";
import { getEditorPrefs } from "../../lib/editorPrefs";
import { useWorkspace } from "../../workspace/store";
import { baseName, joinPath, parentDir } from "../../workspace/paths";
import {
  ensurePackages,
  insertBlocks,
  insertInlineSrc,
  insertMathDisplay,
  insertMathInline,
  isLatex,
  linkAt,
  makeHeading,
  toggleList,
  toggleQuote,
  uniqueLabel,
  type VisualEnv,
} from "./commands";
import { NEW_UNDO_STEP } from "./binding";
import { citationItems, labelItems, openLink } from "./nodeviews/ChipViews";
import { figurePath } from "./nodeviews/FigureView";
import { IMAGE_FILE } from "./images";
import { openPopover, type Anchor, type PickItem } from "./Popovers";

/** Where the cursor is on screen, for anchoring a popover. */
export function cursorAnchor(env: VisualEnv): Anchor {
  try {
    const c = env.view.coordsAtPos(env.view.state.selection.head);
    return { left: c.left, top: c.top, bottom: c.bottom };
  } catch {
    const r = env.view.dom.getBoundingClientRect();
    return { left: r.left + 40, top: r.top + 40, bottom: r.top + 60 };
  }
}

const refocus = (env: VisualEnv) => () => env.view.focus();

/**
 * A new inline formula. Opened by typing "$" (`fromDollar`), leaving it with
 * Esc keeps what was typed, as $, Tab and the arrow keys do.
 */
export function mathInline(env: VisualEnv, opts: { onCancel?: () => void; fromDollar?: boolean } = {}) {
  openPopover(
    {
      kind: "math",
      anchor: cursorAnchor(env),
      body: "",
      display: false,
      allowDisplay: true,
      macros: env.session.context.macros,
      macrosHash: env.session.context.macrosHash,
      onCommit: (body, display) => {
        if (!body.trim()) return;
        if (display) insertMathDisplay(env, body.trim(), getEditorPrefs().displayMath);
        else insertMathInline(env, body.trim());
      },
      onCancel: opts.onCancel,
      commitOnEscape: opts.fromDollar,
    },
    refocus(env),
  );
}

export function mathDisplay(env: VisualEnv) {
  openPopover(
    {
      kind: "math",
      anchor: cursorAnchor(env),
      body: "",
      display: true,
      macros: env.session.context.macros,
      macrosHash: env.session.context.macrosHash,
      onCommit: (body) => {
        if (body.trim()) insertMathDisplay(env, body.trim(), getEditorPrefs().displayMath);
      },
    },
    refocus(env),
  );
}

/** Before inserting: drops `before` characters typed just ahead of the cursor (the "[" of "[@"). */
function dropBefore(env: VisualEnv, before: number) {
  if (before <= 0) return;
  const { state } = env.view;
  const at = state.selection.from;
  env.view.dispatch(state.tr.delete(at - before, at));
}

export function citation(env: VisualEnv, opts: { dropBefore?: number; onCancel?: () => void } = {}) {
  openPopover(
    {
      kind: "pick",
      anchor: cursorAnchor(env),
      title: "Cite",
      items: citationItems(),
      multi: true,
      empty: "No .bib entries in this project yet.",
      onPick: (keys) => {
        dropBefore(env, opts.dropBefore ?? 0);
        insertInlineSrc(env, `\\cite{${keys.join(",")}}`);
      },
      onCancel: opts.onCancel,
    },
    refocus(env),
  );
}

export function reference(env: VisualEnv, opts: { dropBefore?: number; onCancel?: () => void } = {}) {
  openPopover(
    {
      kind: "pick",
      anchor: cursorAnchor(env),
      title: "Reference",
      items: labelItems(),
      empty: "No labels in this project yet.",
      onPick: ([key]) => {
        dropBefore(env, opts.dropBefore ?? 0);
        const cmd = /^eq:/.test(key) && env.session.context.packages.includes("amsmath") ? "eqref" : "ref";
        insertInlineSrc(env, `\\${cmd}{${key}}`);
      },
      onCancel: opts.onCancel,
    },
    refocus(env),
  );
}

export function label(env: VisualEnv) {
  openPopover(
    {
      kind: "text",
      anchor: cursorAnchor(env),
      title: "Label",
      value: "",
      placeholder: "sec:intro",
      onCommit: (key) => {
        const k = key.trim();
        if (k && !/[{}\\%#\s]/.test(k)) insertInlineSrc(env, `\\label{${k}}`);
        else if (k) env.toast("A label can't contain spaces or { } \\ % #.", "error");
      },
    },
    refocus(env),
  );
}

export function footnote(env: VisualEnv) {
  openPopover(
    {
      kind: "text",
      anchor: cursorAnchor(env),
      title: "Footnote",
      value: "",
      multiline: true,
      onCommit: (text) => {
        if (text.trim()) insertInlineSrc(env, `\\footnote{${env.helpers.escapeText(text.trim())}}`);
      },
    },
    refocus(env),
  );
}

/** Ctrl+K: edit the link at the cursor, or link the selection (or insert a linked address). */
export function link(env: VisualEnv) {
  const { state } = env.view;
  const existing = linkAt(state);
  const type = schema.marks.link;
  if (existing) {
    const href = existing.mark.attrs.href as string;
    openPopover(
      {
        kind: "link",
        anchor: cursorAnchor(env),
        href,
        onOpen: () => void openLink(href, env.toast),
        onRemove: () => env.view.dispatch(env.view.state.tr.removeMark(existing.from, existing.to, type).setMeta(NEW_UNDO_STEP, true)),
        onCommit: (next) => {
          if (!next || next === href) return;
          const attrs = env.helpers.newMark("link", env.session.context, next);
          if (!attrs) return;
          // Keep the original spelling around the new address where possible.
          const old = existing.mark.attrs;
          const keep = { ...old, href: next, open: (old.open as string).split(href).join(next), close: (old.close as string).split(href).join(next) };
          const tr = env.view.state.tr.removeMark(existing.from, existing.to, type).addMark(existing.from, existing.to, type.create(keep));
          env.view.dispatch(tr.setMeta(NEW_UNDO_STEP, true));
        },
      },
      refocus(env),
    );
    return;
  }
  if (!env.helpers.newMark("link", env.session.context, "x")) return;
  openPopover(
    {
      kind: "link",
      anchor: cursorAnchor(env),
      href: "",
      onCommit: (href) => {
        if (!href) return;
        const attrs = env.helpers.newMark("link", env.session.context, href);
        if (!attrs) return;
        const s = env.view.state;
        const tr = s.tr;
        const { from } = s.selection;
        let { to } = s.selection;
        if (from === to) {
          tr.insertText(href, from);
          to = from + href.length;
        }
        tr.addMark(from, to, type.create(attrs));
        tr.setSelection(TextSelection.create(tr.doc, to));
        tr.removeStoredMark(type);
        const added = isLatex(env) ? ensurePackages(env, tr, ["hyperref"]) : [];
        env.view.dispatch(tr.setMeta(NEW_UNDO_STEP, true));
        for (const p of added) env.toast(`Added \\usepackage{${p}}`, "info");
      },
    },
    refocus(env),
  );
}

/** A figure for a project image: picked from the project's images or imported. */
export function figure(env: VisualEnv) {
  const ws = useWorkspace.getState();
  const items: PickItem[] = ws.files.filter((f) => !f.isDir && IMAGE_FILE.test(f.path)).map((f) => ({ key: f.path, label: f.path }));
  openPopover(
    {
      kind: "pick",
      anchor: cursorAnchor(env),
      title: "Figure",
      items,
      empty: "No images in this project yet.",
      onPick: ([file]) => insertFigure(env, file),
      extra: { label: "Import image…", run: () => void importImage(env) },
    },
    refocus(env),
  );
}

export function insertFigure(env: VisualEnv, file: string) {
  const path = figurePath(file, env.path, env.dialect);
  const stem = baseName(file).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-");
  insertBlocks(env, env.helpers.figureSrc(path, "fig:" + stem, env.session.context), isLatex(env) ? ["graphicx"] : []);
}

async function importImage(env: VisualEnv) {
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "pdf", "eps", "svg"] }],
  });
  if (!picked || Array.isArray(picked)) return;
  const ws = useWorkspace.getState();
  const main = ws.project?.mainDocument ?? env.path;
  const dest = joinPath(parentDir(main), "figures");
  await ws.importFiles(dest, [picked]);
  const name = picked.split(/[\\/]/).pop() ?? "";
  const file = joinPath(dest, name);
  if (useWorkspace.getState().files.some((f) => f.path === file)) insertFigure(env, file);
}

/** A table label not used in this file or the project yet: tab:new, tab:new2, … */
export function newTableLabel(env: VisualEnv): string {
  const taken = new Set(labelItems().map((l) => l.key));
  for (const m of env.session.text.matchAll(/\\label\s*\{([^}]*)\}/g)) taken.add(m[1].trim());
  return uniqueLabel("tab:new", taken);
}

export function table(env: VisualEnv) {
  openPopover(
    {
      kind: "size",
      anchor: cursorAnchor(env),
      onPick: (rows, cols) => insertBlocks(env, env.helpers.tableSrc(rows, cols, env.session.context, newTableLabel(env))),
    },
    refocus(env),
  );
}

export function rawSource(env: VisualEnv) {
  openPopover(
    {
      kind: "raw",
      anchor: cursorAnchor(env),
      src: "",
      title: isLatex(env) ? "Raw LaTeX" : "Raw Markdown",
      onCommit: (src) => {
        if (src.trim()) insertBlocks(env, src.trim());
      },
    },
    refocus(env),
  );
}

export function pageBreak(env: VisualEnv) {
  insertBlocks(env, "\\newpage");
}

/** The slash menu's entries for this dialect. */
export function slashItems(env: VisualEnv): PickItem[] {
  const latex = isLatex(env);
  const items: (PickItem & { latex?: boolean })[] = [
    { key: "h1", label: env.session.context.hasChapters && latex ? "Chapter" : "Section", detail: "#" },
    { key: "h2", label: env.session.context.hasChapters && latex ? "Section" : "Subsection", detail: "##" },
    { key: "h3", label: env.session.context.hasChapters && latex ? "Subsection" : "Subsubsection", detail: "###" },
    { key: "bullet", label: "Bulleted list", detail: "-" },
    { key: "ordered", label: "Numbered list", detail: "1." },
    { key: "quote", label: "Quote", detail: ">" },
    { key: "equation", label: "Equation", detail: "$$" },
    { key: "figure", label: "Figure" },
    { key: "table", label: "Table" },
    { key: "footnote", label: "Footnote", latex: true },
    { key: "cite", label: "Citation", detail: "@", latex: true },
    { key: "ref", label: "Reference", detail: "[[", latex: true },
    { key: "label", label: "Label", latex: true },
    { key: "pagebreak", label: "Page break", latex: true },
    { key: "raw", label: latex ? "Raw LaTeX" : "Raw Markdown" },
  ];
  return items.filter((i) => latex || !i.latex);
}

export function runSlash(env: VisualEnv, key: string) {
  const getEnv = () => env;
  const { view } = env;
  const run = (cmd: Command) => cmd(view.state, view.dispatch, view);
  switch (key) {
    case "h1":
    case "h2":
    case "h3": {
      const tr = view.state.tr;
      if (makeHeading(env, tr, Number(key[1]) as 1 | 2 | 3)) view.dispatch(tr.setMeta(NEW_UNDO_STEP, true));
      break;
    }
    case "bullet":
    case "ordered":
      run(toggleList(getEnv, key));
      break;
    case "quote":
      run(toggleQuote(getEnv));
      break;
    case "equation":
      mathDisplay(env);
      break;
    case "figure":
      figure(env);
      break;
    case "table":
      table(env);
      break;
    case "footnote":
      footnote(env);
      break;
    case "cite":
      citation(env);
      break;
    case "ref":
      reference(env);
      break;
    case "label":
      label(env);
      break;
    case "pagebreak":
      pageBreak(env);
      break;
    case "raw":
      rawSource(env);
      break;
  }
}
