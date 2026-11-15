// The Visual core contract. The UI imports only from this file.

import type { Node as PMNode } from "prosemirror-model";
import { codecFor } from "./dialects";
import { latexHelpers } from "./latex/helpers";
import { markdownHelpers } from "./markdown/helpers";
import type { Dialect, DialectHelpers } from "./types";

export type {
  Dialect,
  DocContext,
  TextEdit,
  PlanResult,
  SyncResult,
  VisualSession,
  MarkName,
  DialectHelpers,
  TabularCell,
  TabularModel,
  TabularOp,
} from "./types";

export { schema } from "./schema";
export { readContext } from "./context";
export { createSession } from "./session";
export { atoms } from "./atoms";
export { tabular } from "./latex/tabular";
export { freshGid } from "./registry";
export { semEq } from "./semEq";

/** Which Visual dialect a file uses, by extension. */
export function dialectFor(path: string): Dialect | null {
  if (/\.(tex|ltx)$/i.test(path)) return "latex";
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  return null;
}

export function helpersFor(dialect: Dialect): DialectHelpers {
  return dialect === "latex" ? latexHelpers : markdownHelpers;
}

/** A node's source: its original bytes when untouched, otherwise rebuilt from its attrs. */
export function serializeNode(node: PMNode, dialect: Dialect): string {
  return codecFor(dialect).serialize(node);
}
