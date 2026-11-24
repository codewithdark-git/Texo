// Find and replace in Visual mode, over the text a reader sees. Matches in
// source kept as code (raw chips, maths) are counted but left to Code mode.

import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { NEW_UNDO_STEP } from "./binding";

export interface FindQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface FindState {
  query: FindQuery;
  matches: { from: number; to: number }[];
  /** Index of the current match, or -1. */
  current: number;
  /** Matches inside atoms whose source is shown as code. */
  inCode: number;
  decorations: DecorationSet;
}

export const findKey = new PluginKey<FindState>("texo-find");
const META = "texo.find";

const EMPTY: FindQuery = { text: "", caseSensitive: false, wholeWord: false };
const ATOM = "￼";
// Spacing atoms (\quad, \vspace{..}, \newpage) are code too: their source is counted, never matched as page text.
const CODE_ATOMS = new Set(["raw_inline", "raw_block", "math_inline", "math_display", "table_block", "command_block", "comment_block", "spacing", "spacer_block"]);

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function queryRegExp(q: FindQuery): RegExp | null {
  if (!q.text) return null;
  const body = escapeRe(q.text);
  return new RegExp(q.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, q.caseSensitive ? "gu" : "giu");
}

/** All matches in `doc`, plus how many fall in code-like atoms. */
export function findMatches(doc: PMNode, q: FindQuery): { matches: { from: number; to: number }[]; inCode: number } {
  const re = queryRegExp(q);
  const matches: { from: number; to: number }[] = [];
  let inCode = 0;
  if (!re) return { matches, inCode };
  doc.descendants((node, pos) => {
    if (node.isTextblock && !node.type.spec.code) {
      const text = node.textBetween(0, node.content.size, undefined, ATOM);
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        if (!m[0].includes(ATOM)) matches.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
      }
      node.forEach((child) => {
        if (CODE_ATOMS.has(child.type.name)) inCode += countIn(re, String(child.attrs.src ?? child.attrs.body ?? ""));
      });
      return false;
    }
    if (node.type.spec.code) {
      const text = node.textContent;
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        matches.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
      }
      return false;
    }
    if (CODE_ATOMS.has(node.type.name)) {
      inCode += countIn(re, String(node.attrs.src ?? node.attrs.body ?? ""));
      return false;
    }
    return true;
  });
  return { matches, inCode };
}

function countIn(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[0].length === 0) re.lastIndex++;
    else n++;
  }
  return n;
}

function build(doc: PMNode, query: FindQuery, near: number): FindState {
  const { matches, inCode } = findMatches(doc, query);
  let current = -1;
  if (matches.length) {
    current = matches.findIndex((m) => m.from >= near);
    if (current === -1) current = 0;
  }
  return { query, matches, current, inCode, decorations: decorate(doc, matches, current) };
}

function decorate(doc: PMNode, matches: { from: number; to: number }[], current: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? "v-find v-find-current" : "v-find" })),
  );
}

export function findPlugin(): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({ query: EMPTY, matches: [], current: -1, inCode: 0, decorations: DecorationSet.empty }),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(META) as { query?: FindQuery; current?: number } | undefined;
        if (meta?.query) return build(state.doc, meta.query, state.selection.from);
        if (meta?.current !== undefined && prev.matches.length) {
          const current = ((meta.current % prev.matches.length) + prev.matches.length) % prev.matches.length;
          return { ...prev, current, decorations: decorate(state.doc, prev.matches, current) };
        }
        if (tr.docChanged && prev.query.text) return build(state.doc, prev.query, state.selection.from);
        return prev;
      },
    },
    props: {
      decorations: (state) => findKey.getState(state)?.decorations,
    },
  });
}

export function getFind(state: EditorState): FindState | undefined {
  return findKey.getState(state);
}

export function setQuery(view: EditorView, query: FindQuery) {
  view.dispatch(view.state.tr.setMeta(META, { query }));
}

/** Moves to the next (dir 1) or previous (dir -1) match and selects it. */
export function step(view: EditorView, dir: 1 | -1) {
  const st = getFind(view.state);
  if (!st || !st.matches.length) return;
  const current = st.current + dir;
  const n = st.matches.length;
  const m = st.matches[((current % n) + n) % n];
  const tr: Transaction = view.state.tr.setMeta(META, { current });
  tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
  view.dispatch(tr);
}

export function replaceCurrent(view: EditorView, text: string) {
  const st = getFind(view.state);
  if (!st || st.current < 0) return;
  const m = st.matches[st.current];
  const tr = view.state.tr;
  if (text) tr.insertText(text, m.from, m.to);
  else tr.delete(m.from, m.to);
  view.dispatch(tr.setMeta(NEW_UNDO_STEP, true).scrollIntoView());
  step(view, 1);
}

/** Replaces every match in one transaction (one undo step). */
export function replaceAll(view: EditorView, text: string): number {
  const st = getFind(view.state);
  if (!st || !st.matches.length) return 0;
  const tr = view.state.tr;
  for (let i = st.matches.length - 1; i >= 0; i--) {
    const m = st.matches[i];
    if (text) tr.insertText(text, m.from, m.to);
    else tr.delete(m.from, m.to);
  }
  const before = view.state.doc;
  view.dispatch(tr.setMeta(NEW_UNDO_STEP, true));
  return view.state.doc === before ? 0 : st.matches.length;
}
