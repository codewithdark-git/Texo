// The public types of the Visual core. index.ts re-exports them; internal
// modules import from here so they do not depend on the index.

import type { Fragment, Node as PMNode, Slice } from "prosemirror-model";

export type Dialect = "latex" | "markdown";

export interface DocContext {
  dialect: Dialect;
  eol: "\n" | "\r\n";
  docClass: string | null;
  hasChapters: boolean;
  packages: string[];
  macros: Record<string, string>;
  macrosHash: string;
  theorems: Record<string, string>;
  graphicsPaths: string[];
  title: string | null;
  author: string | null;
  date: string | null;
}

/** Offsets are in the session's CURRENT text; edits are sorted ascending and never overlap. */
export interface TextEdit {
  offset: number;
  deleteLength: number;
  insert: string;
}

export type PlanResult = { ok: true; edits: TextEdit[]; newText: string } | { ok: false; reason: string };

export interface SyncResult {
  changed: boolean;
  doc: PMNode;
  from: number;
  toOld: number;
  toNew: number;
}

export interface VisualSession {
  readonly dialect: Dialect;
  readonly doc: PMNode;
  readonly text: string;
  readonly context: DocContext;
  readonly rawRatio: number;
  syncFromText(text: string): SyncResult;
  plan(newDoc: PMNode): PlanResult;
  commit(newDoc: PMNode, newText: string): void;
  pmToSrc(pos: number): number;
  srcToPm(offset: number): number;
  topBlockAt(pos: number): { index: number; start: number; end: number };
  serializeSlice(slice: Slice): string;
  parseSnippet(src: string): Fragment;
  parseInlineSnippet(src: string): Fragment;
  verify(): { ok: true } | { ok: false; offset: number; expected: string; actual: string };
}

export type MarkName = "bold" | "italic" | "underline" | "code" | "smallcaps" | "sans" | "sup" | "sub" | "strike" | "link";

export interface DialectHelpers {
  escapeText(s: string): string;
  headingAttrs(level: 1 | 2 | 3 | 4, ctx: DocContext, prev?: Record<string, unknown>): Record<string, unknown>;
  listAttrs(kind: "bullet" | "ordered" | "description", ctx: DocContext): Record<string, unknown>;
  itemAttrs(kind: "bullet" | "ordered" | "description", index: number, ctx: DocContext): Record<string, unknown>;
  containerAttrs(kind: "quote", ctx: DocContext): Record<string, unknown>;
  newMark(name: MarkName, ctx: DocContext, href?: string): Record<string, unknown> | null;
  mathInlineAttrs(body: string): Record<string, unknown>;
  mathDisplayAttrs(body: string, ctx: DocContext, style: "brackets" | "equation"): Record<string, unknown>;
  codeBlockAttrs(lang: string, ctx: DocContext): Record<string, unknown>;
  figureSrc(path: string, label: string, ctx: DocContext): string;
  tableSrc(rows: number, cols: number, ctx: DocContext): string;
  ensurePackage(preambleSrc: string, pkg: string, ctx: DocContext): string | null;
  setFigurePath(attrs: Record<string, unknown>, path: string): Record<string, unknown>;
}

export interface TabularCell {
  start: number;
  end: number;
  text: string;
}

export interface TabularModel {
  colspec: string;
  rows: { cells: TabularCell[]; terminator: string }[];
  caption: string | null;
  simple: boolean;
}

export type TabularOp =
  | { kind: "setCell"; r: number; c: number; text: string }
  | { kind: "insertRow"; at: number }
  | { kind: "deleteRow"; r: number }
  | { kind: "insertCol"; at: number }
  | { kind: "deleteCol"; c: number }
  | { kind: "setCaption"; text: string };
