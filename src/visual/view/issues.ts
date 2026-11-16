// Compile errors and warnings as a coloured left rule on the blocks they
// point at, with the message as a tooltip.

import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Issue } from "../../lib/api";
import type { GetEnv } from "./commands";

export const issuesKey = new PluginKey<DecorationSet>("texo-issues");

/** Transaction meta carrying a new issue list for this file. */
export const SET_ISSUES = "texo.setIssues";

/** 1-based line → source offset of its start. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function buildIssueDecorations(state: EditorState, getEnv: GetEnv, issues: Issue[]): DecorationSet {
  const env = getEnv();
  if (!env || issues.length === 0) return DecorationSet.empty;
  const starts = lineStarts(env.session.text);
  const byBlock = new Map<number, { from: number; to: number; severity: string; messages: string[] }>();
  for (const issue of issues) {
    if (issue.file !== env.path || !issue.line || issue.severity === "badbox") continue;
    const offset = starts[Math.min(starts.length - 1, issue.line - 1)] ?? 0;
    const pos = env.session.srcToPm(offset);
    const block = env.session.topBlockAt(pos);
    if (block.end <= block.start || block.end > state.doc.content.size) continue;
    const hit = byBlock.get(block.start) ?? { from: block.start, to: block.end, severity: issue.severity, messages: [] };
    if (issue.severity === "error") hit.severity = "error";
    hit.messages.push(`Line ${issue.line}: ${issue.message}`);
    byBlock.set(block.start, hit);
  }
  const decos = [...byBlock.values()].map((b) =>
    Decoration.node(b.from, b.to, { class: b.severity === "error" ? "v-issue v-issue-error" : "v-issue v-issue-warning", title: b.messages.join("\n") }),
  );
  return DecorationSet.create(state.doc, decos);
}

export function issuesPlugin(getEnv: GetEnv): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: issuesKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set, _old, state) {
        const issues = tr.getMeta(SET_ISSUES) as Issue[] | undefined;
        if (issues) return buildIssueDecorations(state, getEnv, issues);
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: {
      decorations: (state) => issuesKey.getState(state),
    },
  });
}
