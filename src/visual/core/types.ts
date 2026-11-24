// The public types of the Visual core. index.ts re-exports them; internal
// modules import from here so they do not depend on the index.

import type { Fragment, Node as PMNode, Slice } from "prosemirror-model";
import type { SizeCmd } from "./latex/style";

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
  /** `label` is the table's \label key where the dialect has labels (default tab:new). */
  tableSrc(rows: number, cols: number, ctx: DocContext, label?: string): string;
  ensurePackage(preambleSrc: string, pkg: string, ctx: DocContext): string | null;
  setFigurePath(attrs: Record<string, unknown>, path: string): Record<string, unknown>;
  /** Attrs for a new `size` mark ({\large ..}), or null when the dialect has no sizes. */
  sizeMark(cmd: SizeCmd, ctx: DocContext): Record<string, unknown> | null;
  /**
   * Attrs for a new `color` mark (\textcolor{red}{..}), or null when the
   * dialect has no colours or the name is not a plain xcolor name. The
   * document needs \usepackage{xcolor}: see ensurePackage.
   */
  colorMark(color: string, ctx: DocContext): Record<string, unknown> | null;
  /** Attrs for a new center / flushleft / flushright container, or null. */
  alignAttrs(align: Align, ctx: DocContext): Record<string, unknown> | null;
  /** Attrs for a new spacer_block (\newpage, \vspace{..}), or null. */
  spacerAttrs(kind: "pagebreak" | "vspace", ctx: DocContext, amount?: string): Record<string, unknown> | null;
  /** Attrs for a new inline `spacing` atom: a line break (\\), \quad, \noindent. */
  spacingAttrs(kind: "break" | "hspace" | "noindent", ctx: DocContext): Record<string, unknown> | null;
}

export type Align = "center" | "left" | "right";

export type { SizeCmd };

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
