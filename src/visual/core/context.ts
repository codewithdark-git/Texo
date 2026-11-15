// Document-wide facts Visual mode needs: line endings, class, packages,
// macros for maths preview, theorem names, graphics paths, title fields.

import type { DocContext, Dialect } from "./types";
import { detectMdStyle, setMdStyle } from "./markdown/helpers";

/** "\r\n" when CRLF line ends are the majority. */
export function detectEol(text: string): "\n" | "\r\n" {
  if (!text.includes("\r\n")) return "\n";
  const all = text.split("\n").length - 1;
  const crlf = text.split("\r\n").length - 1;
  return crlf > all - crlf ? "\r\n" : "\n";
}

/** A cheap, stable string hash (FNV-1a, base 36). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Reads a balanced {..} group whose "{" is at `at`; returns [inner, endIndex] or null. */
export function readBraced(text: string, at: number): [string, number] | null {
  if (text[at] !== "{") return null;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return [text.slice(at + 1, i), i + 1];
  }
  return null;
}

/** Blanks out % comments, keeping offsets. */
function stripComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, (m, pre: string) => pre + " ".repeat(m.length - pre.length));
}

/** `Your Name \\ \small Inst` → `Your Name Inst`. */
export function plainText(tex: string): string {
  return tex
    .replace(/\\\\(\[[^\]]*\])?/g, " ")
    .replace(/\\(?:today)\b/g, "today")
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    .replace(/\\(.)/g, "$1")
    .replace(/~/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function emptyContext(dialect: Dialect, text: string): DocContext {
  return {
    dialect,
    eol: detectEol(text),
    docClass: null,
    hasChapters: false,
    packages: [],
    macros: {},
    macrosHash: hashString("{}"),
    theorems: {},
    graphicsPaths: [],
    title: null,
    author: null,
    date: null,
  };
}

function readLatexContext(text: string): DocContext {
  const ctx = emptyContext("latex", text);
  const begin = text.indexOf("\\begin{document}");
  const pre = stripComments(begin === -1 ? text : text.slice(0, begin));

  const cls = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(pre);
  if (cls) {
    ctx.docClass = cls[1].trim();
    ctx.hasChapters = /^(report|book|memoir|scrreprt|scrbook)$|thesis/i.test(ctx.docClass);
  }
  for (const m of pre.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(",")) {
      const name = p.trim();
      if (name && !ctx.packages.includes(name)) ctx.packages.push(name);
    }
  }

  const macros: Record<string, string> = { "\\bm": "\\boldsymbol" };
  for (const m of pre.matchAll(/\\(?:re)?newcommand\*?\s*(?:\{(\\[A-Za-z@]+)\}|(\\[A-Za-z@]+))\s*(?:\[(\d)\])?\s*(\[)?/g)) {
    if (m[4]) continue; // an optional default argument: KaTeX cannot express it
    const body = readBraced(pre, m.index! + m[0].length);
    if (body) macros[m[1] ?? m[2]] = body[0];
  }
  for (const m of pre.matchAll(/\\DeclareMathOperator(\*?)\s*\{(\\[A-Za-z@]+)\}\s*/g)) {
    const body = readBraced(pre, m.index! + m[0].length);
    if (body) macros[m[2]] = `\\operatorname${m[1]}{${body[0]}}`;
  }
  for (const m of pre.matchAll(/\\def\s*(\\[A-Za-z@]+)\s*(?=\{)/g)) {
    const body = readBraced(pre, m.index! + m[0].length);
    if (body) macros[m[1]] = body[0];
  }
  ctx.macros = macros;
  ctx.macrosHash = hashString(JSON.stringify(macros));

  for (const m of pre.matchAll(/\\newtheorem\*?\s*\{([^}]*)\}\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    ctx.theorems[m[1].trim()] = m[2].trim();
  }
  const gp = /\\graphicspath\s*\{/.exec(pre);
  if (gp) {
    const inner = readBraced(pre, gp.index + gp[0].length - 1);
    if (inner) for (const m of inner[0].matchAll(/\{([^{}]*)\}/g)) ctx.graphicsPaths.push(m[1]);
  }
  for (const field of ["title", "author", "date"] as const) {
    const m = new RegExp(`\\\\${field}\\s*(?:\\[[^\\]]*\\])?\\s*(?=\\{)`).exec(pre);
    if (!m) continue;
    const arg = readBraced(pre, m.index + m[0].length);
    if (arg) ctx[field] = plainText(arg[0]);
  }
  return ctx;
}

function readMarkdownContext(text: string): DocContext {
  const ctx = emptyContext("markdown", text);
  const fm = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (fm) {
    for (const field of ["title", "author", "date"] as const) {
      const m = new RegExp(`^${field}:\\s*(.*)$`, "m").exec(fm[1]);
      if (m) ctx[field] = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  setMdStyle(ctx, detectMdStyle(text));
  return ctx;
}

export function readContext(dialect: Dialect, text: string): DocContext {
  return dialect === "latex" ? readLatexContext(text) : readMarkdownContext(text);
}
