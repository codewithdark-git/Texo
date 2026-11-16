// Markdown-style shortcuts while typing. Each rule runs in two steps: the
// typed characters go into the file as ordinary text first, then the
// transform runs as its own undo step, so Backspace right after (or Ctrl+Z)
// gives back exactly what was typed.

import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "../core";
import { NEW_UNDO_STEP, type Binding } from "./binding";
import { isLatex, makeHeading, wrapInList, wrapInQuote, type GetEnv, type VisualEnv } from "./commands";
import * as actions from "./actions";
import { openPopover } from "./Popovers";

const N = schema.nodes;
const ATOM = "￼";

/** The model version right after a rule's transform, per binding: Backspace then undoes the rule. */
const lastRule = new WeakMap<Binding, number>();

export function undoInputRule(env: VisualEnv): boolean {
  const v = lastRule.get(env.binding);
  lastRule.delete(env.binding);
  if (v === undefined || v !== env.binding.model.getAlternativeVersionId()) return false;
  env.binding.undo();
  return true;
}

/** Inserts `text` as typing would, then (as its own undo step) applies `transform` to the result. */
export function twoStep(env: VisualEnv, view: EditorView, from: number, to: number, text: string, transform: (state: EditorState) => Transaction | null): boolean {
  const before = view.state.doc;
  view.dispatch(view.state.tr.insertText(text, from, to));
  if (view.state.doc === before) return true; // refused; the toast said why
  env.binding.breakUndo();
  const tr = transform(view.state);
  if (!tr || !tr.docChanged) return true;
  const mid = view.state.doc;
  view.dispatch(tr.setMeta(NEW_UNDO_STEP, true));
  if (view.state.doc === mid) return true;
  env.binding.breakUndo();
  lastRule.set(env.binding, env.binding.model.getAlternativeVersionId());
  return true;
}

interface Ctx {
  env: VisualEnv;
  view: EditorView;
  from: number;
  to: number;
  text: string;
  /** Text of the block before the cursor, including what was just typed; atoms are U+FFFC. */
  before: string;
  /** The block is a paragraph directly under the doc, a list item or a container. */
  paragraph: boolean;
  /** The block is empty (before typing). */
  empty: boolean;
}

/** Positions for a match that ends at the cursor (after the typed text is in). */
function span(state: EditorState, length: number) {
  const end = state.selection.from;
  return { start: end - length, end };
}

const BLOCK_RULES: { re: RegExp; run(c: Ctx, m: RegExpExecArray): boolean }[] = [
  {
    re: /^(#{1,4}) $/,
    run: (c, m) =>
      twoStep(c.env, c.view, c.from, c.to, c.text, (state) => {
        const { start, end } = span(state, m[0].length);
        const tr = state.tr.delete(start, end);
        return makeHeading(c.env, tr, m[1].length as 1 | 2 | 3 | 4) ? tr : null;
      }),
  },
  {
    re: /^([-*+]|1[.)]) $/,
    run: (c, m) =>
      twoStep(c.env, c.view, c.from, c.to, c.text, (state) => {
        const { start, end } = span(state, m[0].length);
        const tr = state.tr.delete(start, end);
        return wrapInList(c.env, tr, m[1].startsWith("1") ? "ordered" : "bullet") ? tr : null;
      }),
  },
  {
    re: /^> $/,
    run: (c, m) =>
      twoStep(c.env, c.view, c.from, c.to, c.text, (state) => {
        const { start, end } = span(state, m[0].length);
        const tr = state.tr.delete(start, end);
        return wrapInQuote(c.env, tr) ? tr : null;
      }),
  },
];

// Inline marks. The opener must follow the start, a space or punctuation, and not be followed by a space.
const OPEN_BEFORE = "(?:^|(?<=[\\s(\\[{\"'“‘,;:.!?—–-]))";
const INLINE_RULES: { re: RegExp; mark: "bold" | "italic" | "code"; open: number }[] = [
  { re: new RegExp(OPEN_BEFORE + "\\*\\*([^*\\s\\ufffc](?:[^*\\ufffc]*[^*\\s\\ufffc])?)\\*\\*$"), mark: "bold", open: 2 },
  { re: new RegExp(OPEN_BEFORE + "__([^_\\s\\ufffc](?:[^_\\ufffc]*[^_\\s\\ufffc])?)__$"), mark: "bold", open: 2 },
  { re: new RegExp(OPEN_BEFORE + "\\*([^*\\s\\ufffc](?:[^*\\ufffc]*[^*\\s\\ufffc])?)\\*$"), mark: "italic", open: 1 },
  { re: new RegExp(OPEN_BEFORE + "_([^_\\s\\ufffc](?:[^_\\ufffc]*[^_\\s\\ufffc])?)_$"), mark: "italic", open: 1 },
  { re: /`([^`￼]+)`$/, mark: "code", open: 1 },
];

function inlineMark(c: Ctx): boolean {
  for (const rule of INLINE_RULES) {
    const m = rule.re.exec(c.before);
    if (!m) continue;
    const attrs = c.env.helpers.newMark(rule.mark, c.env.session.context);
    if (!attrs) return false;
    return twoStep(c.env, c.view, c.from, c.to, c.text, (state) => {
      const end = state.selection.from;
      const start = end - m[0].length;
      const tr = state.tr.delete(end - rule.open, end).delete(start, start + rule.open);
      const innerEnd = end - 2 * rule.open;
      tr.addMark(start, innerEnd, schema.marks[rule.mark].create(attrs));
      tr.setSelection(TextSelection.create(tr.doc, innerEnd));
      tr.removeStoredMark(schema.marks[rule.mark]);
      return tr;
    });
  }
  return false;
}

/** LaTeX quotes and dashes become the glyphs LaTeX spells them with. */
function glyphs(c: Ctx): boolean {
  if (!isLatex(c.env)) return false;
  if (c.text === '"') {
    const prev = c.before.slice(-2, -1);
    const opening = prev === "" || /[\s(\[{—–]/.test(prev);
    const glyph = opening ? { src: "``", display: "“" } : { src: "''", display: "”" };
    return twoStep(c.env, c.view, c.from, c.to, c.text, (state) => {
      const end = state.selection.from;
      return state.tr.replaceWith(end - 1, end, N.glyph.create(glyph));
    });
  }
  if (c.text === "-") {
    const $from = c.view.state.doc.resolve(c.from);
    const nodeBefore = $from.nodeBefore;
    if (nodeBefore?.type === N.glyph && nodeBefore.attrs.src === "--") {
      return twoStep(c.env, c.view, c.from, c.to, c.text, (state) => {
        const end = state.selection.from;
        return state.tr.replaceWith(end - 2, end, N.glyph.create({ src: "---", display: "—" }));
      });
    }
    if (c.before.endsWith("--") && !c.before.endsWith("---")) {
      return twoStep(c.env, c.view, c.from, c.to, c.text, (state) => {
        const end = state.selection.from;
        return state.tr.replaceWith(end - 2, end, N.glyph.create({ src: "--", display: "–" }));
      });
    }
  }
  return false;
}

/** Characters that open a picker or popover instead of going into the text. */
function triggers(c: Ctx): boolean {
  const { env, view } = c;
  const prev = c.before.slice(-2, -1);
  const typeLiteral = () => view.dispatch(view.state.tr.insertText(c.text));
  if (c.text === "$") {
    if (prev === "\\") {
      // "\$" is a literal dollar sign.
      const at = view.state.selection.from;
      view.dispatch(view.state.tr.insertText("$", at - 1, at));
      return true;
    }
    if (c.from !== c.to) view.dispatch(view.state.tr.deleteSelection());
    actions.mathInline(env, { fromDollar: true });
    return true;
  }
  if (c.text === "/" && c.empty && c.paragraph) {
    openPopover(
      {
        kind: "slash",
        anchor: actions.cursorAnchor(env),
        items: actions.slashItems(env),
        onPick: (key) => actions.runSlash(env, key),
        onCancel: typeLiteral,
      },
      () => view.focus(),
    );
    return true;
  }
  if (!isLatex(env)) return false;
  if (c.text === "@" && (prev === "" || /[\s([]/.test(prev))) {
    actions.citation(env, { dropBefore: prev === "[" ? 1 : 0, onCancel: typeLiteral });
    return true;
  }
  if (c.text === "[" && prev === "[") {
    actions.reference(env, { dropBefore: 1, onCancel: typeLiteral });
    return true;
  }
  return false;
}

export const inputRulesKey = new PluginKey("texo-input-rules");

export function inputRulesPlugin(getEnv: GetEnv): Plugin {
  return new Plugin({
    key: inputRulesKey,
    props: {
      handleTextInput(view, from, to, text) {
        const env = getEnv();
        if (!env || view.composing) return false;
        const $from = view.state.doc.resolve(from);
        const parent = $from.parent;
        // Never inside code, and only in paragraphs and headings.
        if (parent.type !== N.paragraph && parent.type !== N.heading) return false;
        // A space at the start of a paragraph means nothing to TeX (and makes
        // Markdown indentation); the file can't hold it, so it isn't typed.
        if (/^[ \t]+$/.test(text) && $from.parentOffset === 0) {
          if (from !== to) view.dispatch(view.state.tr.delete(from, to));
          return true;
        }
        if (from !== to && text.length !== 1) return false;
        const before = parent.textBetween(0, $from.parentOffset, undefined, ATOM) + text;
        const c: Ctx = {
          env,
          view,
          from,
          to,
          text,
          before,
          paragraph: parent.type === N.paragraph,
          empty: parent.content.size === 0,
        };
        if (triggers(c)) return true;
        if (c.paragraph && $from.parentOffset + text.length === before.length) {
          for (const rule of BLOCK_RULES) {
            const m = rule.re.exec(before);
            if (m && from === $from.start() + $from.parentOffset && before.length === m[0].length) return rule.run(c, m);
          }
        }
        if (inlineMark(c)) return true;
        return glyphs(c);
      },
    },
  });
}

/** Enter on a paragraph that reads ``` or ```lang: a code block. */
export function codeFence(getEnv: GetEnv) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const env = getEnv();
    const { $from, empty } = state.selection;
    if (!env || !empty || $from.parent.type !== N.paragraph) return false;
    const m = /^```([A-Za-z0-9_+-]*)$/.exec($from.parent.textContent);
    if (!m || $from.parentOffset !== $from.parent.content.size) return false;
    if (!dispatch) return true;
    const pos = $from.before();
    const tr = state.tr.replaceWith(pos, pos + $from.parent.nodeSize, N.code_block.create(env.helpers.codeBlockAttrs(m[1], env.session.context)));
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    env.binding.breakUndo();
    dispatch(tr.setMeta(NEW_UNDO_STEP, true));
    env.binding.breakUndo();
    lastRule.set(env.binding, env.binding.model.getAlternativeVersionId());
    return true;
  };
}
