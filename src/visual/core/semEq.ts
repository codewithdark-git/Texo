// Semantic equality: do two nodes mean the same thing to a reader? Used to
// check that re-parsing new text gives back the doc the user made (I3).
// Spelling of whitespace gaps and mark group ids do not matter; inline content
// compares as the rendered stream of text per mark set.

import type { Mark, Node as PMNode } from "prosemirror-model";

const IGNORED_ATTRS = new Set(["gaps", "gid", "depth"]);

function markKey(marks: readonly Mark[]): string {
  return marks.map((m) => `${m.type.name}|${m.attrs.open}|${m.attrs.close}|${m.attrs.href ?? ""}`).join("\u0001");
}

function atomSrc(node: PMNode): string {
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
  node.forEach((child) => {
    const marks = markKey(child.marks);
    if (child.isText) addText(marks, child.text!);
    else if (child.type.name === "glyph") addText(marks, child.attrs.display as string);
    else out.push({ kind: "atom", marks, key: child.type.name + "\u0000" + atomSrc(child) });
  });
  return out;
}

function sameStream(a: Seg[], b: Seg[]): boolean {
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
  for (const k of Object.keys(a.attrs)) {
    if (IGNORED_ATTRS.has(k)) continue;
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
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) if (!semEq(a.child(i), b.child(i))) return false;
  return true;
}
