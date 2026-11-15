// Field setters for atom nodes. Each returns new attrs whose `src` matches the
// changed field, so the serializer writes the edit and keeps the rest of the
// original spelling (command name, options, brace style).

import { readBraced } from "./context";
import { escapeLatex } from "./latex/escape";

type Attrs = Record<string, unknown>;

/** Index of the "{" that opens the last top-level group of `src`, or -1. */
function lastGroupStart(src: string): number {
  if (!src.endsWith("}")) return -1;
  let depth = 0;
  for (let i = src.length - 1; i >= 0; i--) {
    const c = src[i];
    if (src[i - 1] === "\\") continue;
    if (c === "}") depth++;
    else if (c === "{" && --depth === 0) return i;
  }
  return -1;
}

/** Replaces the last {..} argument of a command's source. */
function withLastArg(src: string, arg: string): string {
  const at = lastGroupStart(src);
  return at === -1 ? src : src.slice(0, at) + "{" + arg + "}";
}

function str(a: Attrs, k: string): string {
  return typeof a[k] === "string" ? (a[k] as string) : "";
}

export const atoms = {
  setMathBody(a: Attrs, body: string): Attrs {
    return { ...a, body };
  },
  setCiteKeys(a: Attrs, keys: string[]): Attrs {
    return { ...a, keys: [...keys], src: withLastArg(str(a, "src"), keys.join(",")) };
  },
  setRefKeys(a: Attrs, keys: string[]): Attrs {
    return { ...a, keys: [...keys], src: withLastArg(str(a, "src"), keys.join(",")) };
  },
  setLabelKey(a: Attrs, key: string): Attrs {
    return { ...a, key, src: withLastArg(str(a, "src"), key) };
  },
  setFootnoteBody(a: Attrs, body: string): Attrs {
    return { ...a, body, src: withLastArg(str(a, "src"), body) };
  },
  setRawSrc(a: Attrs, src: string): Attrs {
    return { ...a, src };
  },
  /**
   * Rewrites the argument of \title, \author or \date in the preamble when it
   * is plain text; returns null when the field is missing or not simple.
   */
  setTitleField(preambleSrc: string, field: "title" | "author" | "date", text: string): string | null {
    const clean = preambleSrc.replace(/(^|[^\\])%.*$/gm, (m, pre: string) => pre + " ".repeat(m.length - pre.length));
    const m = new RegExp(`\\\\${field}\\s*(?=\\{)`).exec(clean);
    if (!m) return null;
    const at = m.index + m[0].length;
    const arg = readBraced(clean, at);
    if (!arg) return null;
    if (/[\\{}%$&#^_~]/.test(arg[0])) return null;
    return preambleSrc.slice(0, at) + "{" + escapeLatex(text) + "}" + preambleSrc.slice(arg[1]);
  },
};
