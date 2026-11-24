// Semantic equality: do two nodes mean the same thing to a reader? Used to
// check that re-parsing new text gives back the doc the user made (I3).
// Spelling of whitespace gaps and mark group ids do not matter; inline content
// compares as the rendered stream of text per mark set.

import type { Mark, Node as PMNode } from "prosemirror-model";

const IGNORED_ATTRS = new Set(["gaps", "gid", "depth"]);

function markKey(marks: readonly Mark[]): string {
  return marks.map((m) => `${m.type.name}|${m.attrs.open}|${m.attrs.close}|${m.attrs.href ?? ""}`).join("\u0001");
}

/** A spacing command ending in a control word (\quad, \noindent, \\) swallows the spaces after it. */
const EATS_SPACE = /(\\[A-Za-z]+\*?|\\\\\*?)$/;

/**
 * Treats a raw \\ chip as the spacing atom the same bytes parse to (older UI
 * code inserts line breaks as raw chips).
 */
function isSpacing(node: PMNode): boolean {
  if (node.type.name === "spacing") return true;
  return node.type.name === "raw_inline" && /^\\\\\*?\s*$/.test(String(node.attrs.src));
}

function atomSrc(node: PMNode): string {
  // "\noindent " and "\noindent" mean the same: the space is TeX's to skip.
  if (isSpacing(node)) return String(node.attrs.src).trimEnd();
  const src =
    node.type.name === "math_inline"
      ? `${node.attrs.open}${node.attrs.body}${node.attrs.close}`
      : typeof node.attrs.src === "string"
        ? node.attrs.src
        : "";
  return src.endsWith("{}") && src.length > 2 ? src.slice(0, -2) : src;
}

type Seg = { kind: "text"; marks: string; text: string } | { kind: "atom"; marks: string; key: string };

/** The rendered stream of a node's inline content. */
function stream(node: PMNode): Seg[] {
  const out: Seg[] = [];
  const addText = (marks: string, text: string) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last && last.kind === "text" && last.marks === marks) last.text += text;
    else out.push({ kind: "text", marks, text });
  };
  let eat = false;
  node.forEach((child) => {
    const marks = markKey(child.marks);
    if (child.isText) {
      const text = eat ? child.text!.replace(/^[ \t]+/, "") : child.text!;
      addText(marks, text);
      eat = eat && text === "";
      return;
    }
    if (child.type.name === "glyph") addText(marks, child.attrs.display as string);
    else out.push({ kind: "atom", marks, key: (isSpacing(child) ? "spacing" : child.type.name) + "\u0000" + atomSrc(child) });
    eat = isSpacing(child) && EATS_SPACE.test(atomSrc(child));
  });
  return out;
}

/** Drops spaces at the very end of a block's text: they don't show, in TeX or Markdown. */
function trimEnd(segs: Seg[]): Seg[] {
  const last = segs[segs.length - 1];
  if (!last || last.kind !== "text" || !/[ \t]$/.test(last.text)) return segs;
  const text = last.text.replace(/[ \t]+$/, "");
  const out = segs.slice(0, -1);
  if (text) out.push({ ...last, text });
  return out;
}

function sameStream(a: Seg[], b: Seg[]): boolean {
  a = trimEnd(a);
  b = trimEnd(b);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.kind !== y.kind || x.marks !== y.marks) return false;
    if (x.kind === "text" && x.text !== (y as typeof x).text) return false;
    if (x.kind === "atom" && x.key !== (y as typeof x).key) return false;
  }
  return true;
}

function sameAttrs(a: PMNode, b: PMNode): boolean {
  const item = a.type.name === "list_item";
  for (const k of Object.keys(a.attrs)) {
    if (IGNORED_ATTRS.has(k)) continue;
    // An item marker's trailing space and continuation indent are spelling:
    // an empty item parses as "\item" (or "-") with the space in the gap.
    if (item && k === "indent") continue;
    // Likewise an empty Markdown heading: "# " reads back as "#".
    if ((item && k === "head") || (a.type.name === "heading" && k === "open")) {
      if (String(a.attrs[k]).trimEnd() !== String(b.attrs[k]).trimEnd()) return false;
      continue;
    }
    const x = a.attrs[k];
    const y = b.attrs[k];
    if (k === "src" && a.isAtom) {
      if (atomSrc(a) !== atomSrc(b)) return false;
      continue;
    }
    if (x === y) continue;
    if (JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

export function semEq(a: PMNode, b: PMNode): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (!sameAttrs(a, b)) return false;
  if (a.isTextblock && !a.type.spec.code) return sameStream(stream(a), stream(b));
  if (a.type.spec.code) return a.textContent === b.textContent;
  // An empty paragraph inside a quote or item (Enter at its end) writes no
  // text and parses back as nothing: it is where the next words will go.
  const x = blockKids(a);
  const y = blockKids(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (!semEq(x[i], y[i])) return false;
  return true;
}

function blockKids(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => {
    if (!(child.type.name === "paragraph" && child.content.size === 0)) out.push(child);
  });
  return out;
}
