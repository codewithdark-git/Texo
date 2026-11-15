// markdown-it rules for maths: $..$ (and $$..$$) inline, and $$ display
// blocks on lines of their own. The tokens carry the exact delimiters as
// markup so the aligner can match them against the source.

import type { MarkdownIt, StateBlock, StateInline } from "markdown-it";

/** $x$ or $$x$$ inside a paragraph. The body may not start or end with a space for single $. */
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 36) return false;
  const delim = src.charCodeAt(start + 1) === 36 ? "$$" : "$";
  const bodyStart = start + delim.length;
  if (delim === "$") {
    const c = src[bodyStart];
    if (c === undefined || c === " " || c === "\t" || c === "\n") return false;
  }
  let i = bodyStart;
  while (i < state.posMax) {
    const at = src.indexOf(delim, i);
    if (at === -1 || at >= state.posMax) return false;
    if (src[at - 1] === "\\") {
      i = at + 1;
      continue;
    }
    if (at === bodyStart) return false;
    if (delim === "$") {
      const before = src[at - 1];
      if (before === " " || before === "\t" || before === "\n") {
        i = at + 1;
        continue;
      }
      if (src.charCodeAt(at + 1) === 36) {
        i = at + 2;
        continue;
      }
    }
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.markup = delim;
      token.content = src.slice(bodyStart, at);
    }
    state.pos = at + delim.length;
    return true;
  }
  return false;
}

/** A $$ block: "$$" starting a line, through a line ending in "$$". */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (pos + 2 > max || state.src.slice(pos, pos + 2) !== "$$") return false;
  const firstRest = state.src.slice(pos + 2, max);
  let last = -1;
  if (firstRest.trim().endsWith("$$") && firstRest.trim().length >= 2) last = startLine;
  else {
    for (let line = startLine + 1; line < endLine; line++) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (state.sCount[line] < state.blkIndent) return false;
      if (text.trimEnd().endsWith("$$")) {
        last = line;
        break;
      }
    }
  }
  if (last === -1) return false;
  if (silent) return true;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.markup = "$$";
  token.map = [startLine, last + 1];
  token.content = state.src.slice(pos, state.eMarks[last]);
  state.line = last + 1;
  return true;
}

export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
}
