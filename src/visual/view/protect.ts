// Refuses edits that would break the file's structure behind the user's back:
// deleting the preamble or postamble (editing their attrs is fine), and code
// block text that would close its own environment or fence early.

import { Plugin } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../core";
import { FROM_SOURCE } from "./binding";

const { preamble, postamble, code_block } = schema.nodes;

/** Would this code block's text end its environment (or Markdown fence) early? */
export function codeBreaksOut(node: PMNode): boolean {
  const text = node.textContent;
  const begin = node.attrs.begin as string;
  const env = /\\begin\s*\{([^}]+)\}/.exec(begin)?.[1];
  if (env) return text.includes(`\\end{${env}}`);
  const fence = /^(\s*)(`{3,}|~{3,})/.exec(begin)?.[2];
  if (fence) return new RegExp(`(^|\\n)\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*($|\\n)`).test(text);
  return false;
}

function count(doc: PMNode, type: typeof preamble): number {
  let n = 0;
  doc.forEach((c) => {
    if (c.type === type) n++;
  });
  return n;
}

export function protectPlugin(): Plugin {
  return new Plugin({
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(FROM_SOURCE)) return true;
      const before = state.doc;
      const after = tr.doc;
      if (before.firstChild?.type === preamble && after.firstChild?.type !== preamble) return false;
      if (before.lastChild?.type === postamble && after.lastChild?.type !== postamble) return false;
      if (count(after, preamble) > count(before, preamble) || count(after, postamble) > count(before, postamble)) return false;
      const start = after.content.findDiffStart(before.content);
      if (start === null) return true;
      const end = after.content.findDiffEnd(before.content);
      const to = Math.max(start, end ? end.a : after.content.size);
      let bad = false;
      after.nodesBetween(start, Math.min(to, after.content.size), (n) => {
        if (bad) return false;
        if (n.type === code_block) {
          bad = codeBreaksOut(n);
          return false;
        }
        return !n.isInline;
      });
      return !bad;
    },
  });
}
