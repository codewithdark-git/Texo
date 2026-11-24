// LaTeX spellings for things the Visual UI creates: new headings, lists,
// marks, maths, figures and tables, and package lines for the preamble.

import { freshGid } from "../registry";
import type { Align, DialectHelpers, DocContext, MarkName } from "../types";
import { escapeLatex } from "./escape";
import { COLOR_NAME, cssLength, isSizeCmd, spacingAmount } from "./style";

const MARKS: Record<MarkName, [string, string] | null> = {
  bold: ["\\textbf{", "}"],
  italic: ["\\emph{", "}"],
  underline: ["\\underline{", "}"],
  code: ["\\texttt{", "}"],
  smallcaps: ["\\textsc{", "}"],
  sans: ["\\textsf{", "}"],
  sup: ["\\textsuperscript{", "}"],
  sub: ["\\textsubscript{", "}"],
  strike: null,
  link: ["\\href{URL}{", "}"],
};

const ENVS = { bullet: "itemize", ordered: "enumerate", description: "description" } as const;

const ALIGN_ENVS: Record<Align, string> = { center: "center", left: "flushleft", right: "flushright" };

/** The sectioning command for a UI heading level. */
function headingCmd(level: 1 | 2 | 3 | 4, ctx: DocContext): string {
  const names = ctx.hasChapters
    ? ["chapter", "section", "subsection", "subsubsection"]
    : ["section", "subsection", "subsubsection", "paragraph"];
  return names[level - 1];
}

export const latexHelpers: DialectHelpers = {
  escapeText: escapeLatex,

  headingAttrs(level, ctx, prev) {
    const cmd = headingCmd(level, ctx);
    if (prev && typeof prev.open === "string" && typeof prev.cmd === "string") {
      const open = (prev.open as string).replace(/^\\[a-z]+/, "\\" + cmd);
      return { ...prev, cmd, level, open };
    }
    return { cmd, level, open: `\\${cmd}{`, close: "}", trail: "" };
  },

  listAttrs(kind, ctx) {
    const env = ENVS[kind];
    return { kind, begin: `\\begin{${env}}`, end: `\\end{${env}}`, gaps: [ctx.eol + "  ", ctx.eol] };
  },

  itemAttrs(kind) {
    return { head: kind === "description" ? "\\item[] " : "\\item ", indent: "", gaps: [] };
  },

  containerAttrs(_kind, ctx) {
    return {
      kind: "quote",
      env: "quote",
      label: "quote",
      begin: "\\begin{quote}",
      end: "\\end{quote}",
      prefix: "",
      gaps: [ctx.eol, ctx.eol],
    };
  },

  newMark(name, _ctx, href) {
    const m = MARKS[name];
    if (!m) return null;
    const attrs: Record<string, unknown> = { open: m[0], close: m[1], gid: freshGid(), depth: 0 };
    if (name === "link") {
      attrs.href = href ?? "";
      attrs.open = `\\href{${href ?? ""}}{`;
    }
    return attrs;
  },

  mathInlineAttrs(body) {
    return { open: "$", body, close: "$" };
  },

  // Split exactly as the parser splits what these write, so a new formula
  // re-parses to the same node: the parser keeps an environment's first line
  // break in `open` and its last in `close`, and \[..\] keeps all inner space
  // in the body.
  mathDisplayAttrs(body, ctx, style) {
    if (style === "equation") {
      return { open: "\\begin{equation*}" + ctx.eol, body: "  " + body, close: ctx.eol + "\\end{equation*}", env: "equation*" };
    }
    return { open: "\\[", body: ctx.eol + "  " + body + ctx.eol, close: "\\]", env: "" };
  },

  codeBlockAttrs(lang, ctx) {
    return { begin: "\\begin{verbatim}" + ctx.eol, end: ctx.eol + "\\end{verbatim}", lang };
  },

  figureSrc(path, label, ctx) {
    const e = ctx.eol;
    return [
      "\\begin{figure}[htbp]",
      "  \\centering",
      `  \\includegraphics[width=0.8\\linewidth]{${path}}`,
      "  \\caption{}",
      `  \\label{${label}}`,
      "\\end{figure}",
    ].join(e);
  },

  tableSrc(rows, cols, ctx, label = "tab:new") {
    const e = ctx.eol;
    const r = Math.max(1, rows);
    const c = Math.max(1, cols);
    const spec = "|" + "l|".repeat(c);
    const row = "    " + Array(c).fill("").join(" & ") + " \\\\";
    const lines = ["\\begin{table}[htbp]", "  \\centering", `  \\begin{tabular}{${spec}}`, "    \\hline"];
    for (let i = 0; i < r; i++) lines.push(c === 1 ? "     \\\\" : row, "    \\hline");
    lines.push("  \\end{tabular}", "  \\caption{}", `  \\label{${label}}`, "\\end{table}");
    return lines.join(e);
  },

  ensurePackage(preambleSrc, pkg, ctx) {
    const pre = preambleSrc.replace(/(^|[^\\])%.*$/gm, "$1");
    for (const m of pre.matchAll(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
      if (m[1].split(",").some((p) => p.trim() === pkg)) return null;
    }
    const at = preambleSrc.search(/^[ \t]*\\begin\s*\{document\}/m);
    const line = `\\usepackage{${pkg}}` + ctx.eol;
    if (at === -1) return preambleSrc + ctx.eol + `\\usepackage{${pkg}}`;
    return preambleSrc.slice(0, at) + line + preambleSrc.slice(at);
  },

  sizeMark(cmd) {
    if (!isSizeCmd(cmd)) return null;
    return { open: `{\\${cmd} `, close: "}", gid: freshGid(), depth: 0, cmd };
  },

  colorMark(color) {
    if (!COLOR_NAME.test(color)) return null;
    return { open: `\\textcolor{${color}}{`, close: "}", gid: freshGid(), depth: 0, color, model: "" };
  },

  alignAttrs(align, ctx) {
    const env = ALIGN_ENVS[align];
    if (!env) return null;
    // The same attrs the parser gives these environments, so a new one re-parses equal.
    return {
      kind: align === "center" ? "center" : "flush",
      env,
      label: env,
      begin: `\\begin{${env}}`,
      end: `\\end{${env}}`,
      prefix: "",
      gaps: [ctx.eol, ctx.eol],
      align,
    };
  },

  spacerAttrs(kind, _ctx, amount) {
    if (kind === "pagebreak") return { src: "\\newpage", kind, amount: "" };
    const len = amount ?? "12pt";
    if (cssLength(len) === "" || /\\/.test(len)) return null;
    const src = `\\vspace{${len}}`;
    return { src, kind, amount: spacingAmount(src) };
  },

  spacingAttrs(kind) {
    // A trailing space after a control word, as the parser reads "\noindent Text".
    if (kind === "break") return { src: "\\\\", kind, amount: "" };
    if (kind === "hspace") return { src: "\\quad ", kind, amount: "1em" };
    return { src: "\\noindent ", kind, amount: "" };
  },

  setFigurePath(attrs, path) {
    const head = typeof attrs.head === "string" ? attrs.head : "";
    const newHead = head.replace(/(\\includegraphics\s*(?:\[[^\]]*\])?\s*\{)[^}]*(\})/, (_m, a: string, b: string) => a + path + b);
    const tail = typeof attrs.tail === "string" ? attrs.tail : "";
    const newTail = newHead === head ? tail.replace(/(\\includegraphics\s*(?:\[[^\]]*\])?\s*\{)[^}]*(\})/, (_m, a: string, b: string) => a + path + b) : tail;
    return { ...attrs, head: newHead, tail: newTail, path };
  },
};
