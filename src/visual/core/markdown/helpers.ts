// Markdown spellings for things the Visual UI creates. The bullet marker and
// emphasis character follow what the file already uses.

import { freshGid } from "../registry";
import type { DialectHelpers, DocContext, MarkName } from "../types";
import { escapeMarkdown } from "./serialize";

/** House style read from a Markdown file. */
export interface MdStyle {
  bullet: string;
  emphasis: string;
  orderedDelim: string;
}

const STYLES = new WeakMap<DocContext, MdStyle>();

/** Finds the dominant bullet marker, emphasis char and ordered delimiter. */
export function detectMdStyle(text: string): MdStyle {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const bullets: [string, number][] = [
    ["-", count(/^[ \t]*- /gm)],
    ["*", count(/^[ \t]*\* /gm)],
    ["+", count(/^[ \t]*\+ /gm)],
  ];
  bullets.sort((a, b) => b[1] - a[1]);
  const star = count(/(^|[^*\w])\*[^*\s][^*\n]*\*(?!\*)/g);
  const under = count(/(^|[^_\w])_[^_\s][^_\n]*_(?![_\w])/g);
  const paren = count(/^[ \t]*\d+\) /gm);
  const dot = count(/^[ \t]*\d+\. /gm);
  return {
    bullet: bullets[0][1] > 0 ? bullets[0][0] : "-",
    emphasis: under > star ? "_" : "*",
    orderedDelim: paren > dot ? ")" : ".",
  };
}

export function setMdStyle(ctx: DocContext, style: MdStyle) {
  STYLES.set(ctx, style);
}

function styleOf(ctx: DocContext): MdStyle {
  return STYLES.get(ctx) ?? { bullet: "-", emphasis: "*", orderedDelim: "." };
}

export const markdownHelpers: DialectHelpers = {
  escapeText: (s) => escapeMarkdown(s),

  headingAttrs(level, _ctx, prev) {
    const open = "#".repeat(level) + " ";
    if (prev && prev.cmd === "atx") return { ...prev, level, open };
    return { cmd: "atx", level, open, close: "", trail: "" };
  },

  listAttrs(kind) {
    // Only the two edge gaps: items added later take the line break between
    // them from the serializer (a third, empty gap would glue them together).
    return { kind: kind === "description" ? "bullet" : kind, begin: "", end: "", gaps: ["", ""] };
  },

  itemAttrs(kind, index, ctx) {
    const st = styleOf(ctx);
    const head = kind === "ordered" ? `${index + 1}${st.orderedDelim} ` : st.bullet + " ";
    return { head, indent: " ".repeat(head.length), gaps: [] };
  },

  containerAttrs() {
    return { kind: "quote", env: "", label: "Quote", begin: "", end: "", prefix: "> ", gaps: ["", ""] };
  },

  newMark(name: MarkName, ctx, href) {
    const st = styleOf(ctx);
    const gid = freshGid();
    switch (name) {
      case "bold":
        return { open: st.emphasis.repeat(2), close: st.emphasis.repeat(2), gid, depth: 0 };
      case "italic":
        return { open: st.emphasis, close: st.emphasis, gid, depth: 0 };
      case "code":
        return { open: "`", close: "`", gid, depth: 0 };
      case "strike":
        return { open: "~~", close: "~~", gid, depth: 0 };
      case "link":
        return { open: "[", close: `](${href ?? ""})`, href: href ?? "", gid, depth: 0 };
      default:
        return null;
    }
  },

  mathInlineAttrs(body) {
    return { open: "$", body, close: "$" };
  },

  mathDisplayAttrs(body, ctx) {
    return { open: "$$" + ctx.eol, body, close: ctx.eol + "$$", env: "" };
  },

  codeBlockAttrs(lang, ctx) {
    return { begin: "```" + lang + ctx.eol, end: ctx.eol + "```", lang };
  },

  figureSrc(path) {
    return `![](${path})`;
  },

  tableSrc(rows, cols, ctx) {
    const c = Math.max(1, cols);
    const line = (cell: string) => "|" + Array(c).fill(cell).join("|") + "|";
    const out = [line("   "), line(" --- ")];
    for (let i = 0; i < Math.max(1, rows); i++) out.push(line("   "));
    return out.join(ctx.eol);
  },

  ensurePackage() {
    return null;
  },

  setFigurePath(attrs, path) {
    const src = typeof attrs.src === "string" ? attrs.src : "";
    const m = /^(!\[[^\]]*\]\()\s*(<[^>]*>|[^\s)]*)/.exec(src);
    if (!m) return { ...attrs, path };
    return { ...attrs, path, src: m[1] + path + src.slice(m[0].length) };
  },
};
