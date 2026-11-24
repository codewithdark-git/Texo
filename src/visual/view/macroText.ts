// What a project's own text macros print. A paper that writes its numbers
// as `\confirmatoryNumRuns{}` (defined elsewhere as `\newcommand{..}{5}`)
// reads as "5" in Visual mode instead of a placeholder. The definitions come
// from the project's symbol scan.

import { readableInline } from "./nodeviews/friendly";

const macros = new Map<string, string>();
const listeners = new Set<() => void>();

/** Replaces the known definitions (from the project's symbol scan). */
export function setTextMacros(list: readonly { name: string; body: string }[]) {
  const next = new Map(list.map((m) => [m.name, m.body] as const));
  const same = next.size === macros.size && [...next].every(([k, v]) => macros.get(k) === v);
  if (same) return;
  macros.clear();
  for (const [k, v] of next) macros.set(k, v);
  for (const fn of [...listeners]) fn();
}

/** Runs `fn` whenever the definitions change; returns the unsubscribe. */
export function onTextMacros(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** What a bare macro call prints: plain text, or maths for KaTeX. */
export type MacroOutput = { text: string } | { math: string };

/** The macro a source calls with nothing else around it (`\foo`, `\foo{}`), or null. */
export function calledMacro(src: string): string | null {
  return /^\s*\\([A-Za-z@]+)\s*(?:\{\s*\})?\s*$/.exec(src)?.[1] ?? null;
}

/**
 * What `src` prints when it is a bare call to one of the project's text
 * macros, following macros that just call another (up to a few levels).
 * Null for anything else, or when the definition isn't readable.
 */
export function macroOutput(src: string, defs: ReadonlyMap<string, string> = macros): MacroOutput | null {
  let name = calledMacro(src);
  for (let depth = 0; name && depth < 4; depth++) {
    const body = defs.get(name);
    if (body === undefined) return null;
    const inner = calledMacro(body);
    if (inner) {
      name = inner;
      continue;
    }
    const math = /^\s*\$([^$]+)\$\s*$/.exec(body)?.[1];
    if (math) return { math };
    // Text with some maths in it ("0.724 $\pm$ 0.009"): all of it as maths, the text parts in \text{..}.
    if (/(^|[^\\])\$/.test(body)) return mixedMath(body);
    // `--` is LaTeX's en dash; a body of just that reads as "–".
    const text = readableInline(body.replace(/---/g, "—").replace(/--/g, "–"));
    return text ? { text } : null;
  }
  return null;
}

/** "0.724 $\pm$ 0.009" → `\text{0.724 }{\pm}\text{ 0.009}` for KaTeX. */
function mixedMath(body: string): MacroOutput | null {
  const parts = body.split(/(?<!\\)\$/);
  if (parts.length % 2 === 0) return null; // an unclosed $
  let tex = "";
  parts.forEach((part, i) => {
    if (i % 2) {
      tex += `{${part}}`;
      return;
    }
    if (!part) return;
    const lead = /^\s/.test(part) ? " " : "";
    const trail = /\s$/.test(part) ? " " : "";
    const text = readableInline(part.replace(/---/g, "—").replace(/--/g, "–"));
    if (text || lead || trail) tex += `\\text{${(lead + text + trail).replace(/[{}\\]/g, "")}}`;
  });
  return tex ? { math: tex } : null;
}
