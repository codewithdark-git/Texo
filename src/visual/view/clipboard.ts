// Copy and paste. Copying writes the selection's source as plain text (and
// the nodes, with all their source attrs, as HTML for pasting back here).
// Pasted HTML from elsewhere goes through the schema's parse rules, and its
// marks get this dialect's spelling; pasted images are dropped.

import { Fragment, Slice, type Mark, type Node as PMNode, type ResolvedPos } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { schema, type MarkName } from "../core";
import { fileEol, type GetEnv } from "./commands";

const N = schema.nodes;

/** Gives foreign marks (gid 0: not from this file) canonical attrs for the dialect, or drops them. */
function respell(getEnv: GetEnv, frag: Fragment): Fragment {
  const env = getEnv();
  if (!env) return frag;
  const nodes: PMNode[] = [];
  frag.forEach((node) => {
    if (node.type === N.image && !node.attrs.src) return; // a foreign image: not supported
    if (node.isText) {
      const marks: Mark[] = [];
      for (const m of node.marks) {
        if (m.attrs.gid) {
          marks.push(m);
          continue;
        }
        const attrs = env.helpers.newMark(m.type.name as MarkName, env.session.context, m.attrs.href as string | undefined);
        if (attrs) marks.push(m.type.create(attrs));
      }
      nodes.push(node.mark(marks));
    } else nodes.push(node.copy(respell(getEnv, node.content)));
  });
  return Fragment.from(nodes);
}

export function transformPasted(getEnv: GetEnv) {
  return (slice: Slice): Slice => new Slice(respell(getEnv, slice.content), slice.openStart, slice.openEnd);
}

/** Plain text: LaTeX-looking text is parsed as source; otherwise blank lines split paragraphs. */
export function clipboardTextParser(getEnv: GetEnv) {
  return (text: string, $context: ResolvedPos): Slice => {
    const env = getEnv();
    const clean = text.replace(/\r\n?/g, "\n");
    if (!env) return Slice.empty;
    const inCode = $context.parent.type.spec.code;
    // Code keeps its line breaks, in the file's own spelling.
    if (inCode) return new Slice(Fragment.from(schema.text(fileEol(env, clean))), 0, 0);
    const looksLikeSource =
      env.dialect === "latex" ? /\\[A-Za-z]+|(^|[^\\])\$|(^|[^\\])%/.test(clean) : /[*_`#[\]]|^\s*[-+>]\s/m.test(clean);
    const paras = clean.split(/\n[ \t]*\n+/).filter((p) => p.trim() !== "");
    // A space before the pasted words is kept ("hello" + " world"), except
    // at the start of a paragraph, where the file can't hold it.
    const lead = $context.parentOffset > 0 && /^[ \t]/.test(clean) ? " " : "";
    if (looksLikeSource) {
      if (paras.length <= 1 && !clean.includes("\n")) return new Slice(env.session.parseInlineSnippet(lead + clean.trim()), 0, 0);
      const frag = withLead(env.session.parseSnippet(fileEol(env, clean.trim())), lead);
      // Open at paragraph ends, so the first and last paragraphs join the text around the cursor.
      return new Slice(frag, frag.firstChild?.type === N.paragraph ? 1 : 0, frag.lastChild?.type === N.paragraph ? 1 : 0);
    }
    const eol = env.session.context.eol;
    const inline = (p: string): PMNode[] => {
      const out: PMNode[] = [];
      p.split("\n").forEach((line, i) => {
        if (i > 0) out.push(N.softbreak.create({ src: eol }));
        if (line) out.push(schema.text(line));
      });
      return out;
    };
    if (paras.length <= 1) return new Slice(Fragment.from(inline(lead + clean.trim())), 0, 0);
    return new Slice(withLead(Fragment.from(paras.map((p) => N.paragraph.create(null, inline(p.trim())))), lead), 1, 1);
  };
}

/** Puts `lead` (a space) at the start of the first paragraph. */
function withLead(frag: Fragment, lead: string): Fragment {
  const first = frag.firstChild;
  if (!lead || !first || first.type !== N.paragraph) return frag;
  return frag.replaceChild(0, first.copy(Fragment.from(schema.text(lead)).append(first.content)));
}

/** Images pasted from the clipboard are not added (use Insert figure). */
export function handlePaste(toast: (text: string, kind?: "success" | "info" | "error") => void) {
  return (_view: EditorView, event: ClipboardEvent): boolean => {
    const files = event.clipboardData?.files;
    const hasText = !!event.clipboardData?.getData("text/plain") || !!event.clipboardData?.getData("text/html");
    if (files && files.length && !hasText) {
      toast("Images can't be pasted into Visual mode. Add them as a figure instead.", "info");
      return true;
    }
    return false;
  };
}
