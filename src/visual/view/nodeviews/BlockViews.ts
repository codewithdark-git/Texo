// Views for the editable block nodes: headings at their level, lists, list
// items, and containers (quotes, abstracts, proofs, theorems, Beamer frames
// as slide cards and Beamer blocks as titled boxes). Their \begin and \end
// lines are attrs, so they can't be edited away here.

import type { Node as PMNode } from "prosemirror-model";
import type { NodeView, ViewMutationRecord } from "prosemirror-view";
import { el, type ViewFactory } from "./common";

/** The last {..} argument of `\begin{env}[..]{..}…`, after the environment name. */
export function beginTitle(begin: string): string {
  const m = /^\\begin\s*\{[^}]*\}/.exec(begin);
  if (!m) return "";
  let rest = begin.slice(m[0].length);
  const args: string[] = [];
  for (;;) {
    rest = rest.replace(/^\s*/, "");
    if (rest.startsWith("<")) {
      const e = rest.indexOf(">");
      if (e === -1) break;
      rest = rest.slice(e + 1);
    } else if (rest.startsWith("[")) {
      const e = rest.indexOf("]");
      if (e === -1) break;
      rest = rest.slice(e + 1);
    } else if (rest.startsWith("{")) {
      let depth = 0;
      let i = 0;
      for (; i < rest.length; i++) {
        if (rest[i] === "\\") i++;
        else if (rest[i] === "{") depth++;
        else if (rest[i] === "}" && --depth === 0) break;
      }
      if (i >= rest.length) break;
      args.push(rest.slice(1, i));
      rest = rest.slice(i + 1);
    } else break;
  }
  return args[0] ? plain(args[0]) : "";
}

/** A readable version of a short LaTeX title. */
function plain(s: string): string {
  return s
    .replace(/\\(?:textbf|emph|textit|texttt|textsc|textsf|underline)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\([%$&#_{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .trim();
}

/** A frame's title: from its \begin arguments, or a \frametitle inside it. */
export function frameTitle(node: PMNode): string {
  const fromBegin = beginTitle(node.attrs.begin as string);
  if (fromBegin) return fromBegin;
  let title = "";
  node.descendants((child) => {
    if (title) return false;
    const src = child.attrs?.src;
    if (typeof src === "string") {
      const m = /\\frametitle\s*(?:<[^>]*>)?\s*\{([^{}]*)\}/.exec(src);
      if (m) title = plain(m[1]);
    }
    return !child.isInline;
  });
  return title;
}

/** The LaTeX sectioning command behind a heading ("section"), or "" (Markdown, unknown). */
export function headingCmd(node: PMNode): string {
  const open = typeof node.attrs.open === "string" ? node.attrs.open : "";
  const cmd = typeof node.attrs.cmd === "string" && node.attrs.cmd ? node.attrs.cmd : (/^\\([a-z]+)/.exec(open)?.[1] ?? "");
  return /^(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)$/.test(cmd) ? cmd : "";
}

class HeadingView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  constructor(private node: PMNode) {
    const level = Math.max(1, Math.min(4, (node.attrs.level as number) || 1));
    this.dom = this.contentDOM = el(`h${level}` as "h1", `v-heading v-h${level}`);
    if (/^\\[a-z]+\*/.test(node.attrs.open as string)) this.dom.classList.add("v-unnumbered");
    // Sized like LaTeX's own sectioning command (chapter, section, …) when the source names one.
    const cmd = headingCmd(node);
    if (cmd) this.dom.classList.add(`v-cmd-${cmd}`);
  }
  update(node: PMNode) {
    if (node.type !== this.node.type || node.attrs.level !== this.node.attrs.level || headingCmd(node) !== headingCmd(this.node)) return false;
    this.node = node;
    return true;
  }
}

class ListView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  constructor(private node: PMNode) {
    const kind = node.attrs.kind as string;
    this.dom = this.contentDOM = el(kind === "ordered" ? "ol" : "ul", `v-list v-list-${kind}`);
  }
  update(node: PMNode) {
    if (node.type !== this.node.type || node.attrs.kind !== this.node.attrs.kind) return false;
    this.node = node;
    return true;
  }
}

/** "\item[Term] " → "Term" (description lists). */
function itemTerm(head: string): string | null {
  const m = /^\\item\s*\[([^\]]*)\]/.exec(head);
  return m ? plain(m[1]) : null;
}

class ListItemView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private term: HTMLElement | null = null;
  constructor(private node: PMNode) {
    this.dom = el("li", "v-item");
    const term = itemTerm(node.attrs.head as string);
    if (term !== null) {
      this.term = el("span", "v-item-term", term);
      this.term.contentEditable = "false";
      this.dom.append(this.term);
    }
    this.contentDOM = el("div", "v-item-body");
    this.dom.append(this.contentDOM);
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    const term = itemTerm(node.attrs.head as string);
    if ((term === null) !== (this.term === null)) return false;
    if (this.term && term !== null) this.term.textContent = term;
    this.node = node;
    return true;
  }
  ignoreMutation(m: ViewMutationRecord) {
    return m.type !== "selection" && !!this.term && this.term.contains(m.target);
  }
}

/** "v-align-center" etc. for a container with an align attr, else "". */
function alignClass(node: PMNode): string {
  const a = node.attrs.align;
  return a === "center" || a === "left" || a === "right" ? `v-align-${a}` : "";
}

class ContainerView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private head: HTMLElement | null = null;
  constructor(private node: PMNode) {
    const kind = node.attrs.kind as string;
    const env = node.attrs.env as string;
    if (kind === "quote") {
      this.dom = this.contentDOM = el("blockquote", "v-quote");
      return;
    }
    this.dom = el("div", `v-container v-kind-${kind.replace(/[^a-z0-9-]/gi, "")}`);
    // center / flushleft / flushright (the core's align attr): the text aligns like Word's buttons.
    const align = alignClass(node);
    if (align) this.dom.classList.add(align);
    if (kind === "block") this.dom.classList.add(`v-env-${env.replace(/[^a-z]/gi, "")}`);
    this.head = el("div", kind === "frame" ? "v-frame-title" : "v-container-label");
    this.head.contentEditable = "false";
    this.contentDOM = el("div", kind === "frame" ? "v-frame-body" : "v-container-body");
    this.dom.append(this.head, this.contentDOM);
    this.paintHead();
  }
  private paintHead() {
    if (!this.head) return;
    const kind = this.node.attrs.kind as string;
    if (kind === "frame") {
      const title = frameTitle(this.node);
      this.head.textContent = title || "Slide";
      this.head.classList.toggle("v-untitled", !title);
    } else if (kind === "block") {
      this.head.textContent = beginTitle(this.node.attrs.begin as string) || (this.node.attrs.label as string) || "Block";
    } else {
      const title = beginTitle(this.node.attrs.begin as string);
      const label = (this.node.attrs.label as string) || (this.node.attrs.env as string);
      this.head.textContent = title ? `${label} (${title})` : label;
      this.head.hidden = kind === "center" || kind === "flush";
    }
  }
  update(node: PMNode) {
    if (node.type !== this.node.type || node.attrs.kind !== this.node.attrs.kind || alignClass(node) !== alignClass(this.node)) return false;
    this.node = node;
    this.paintHead();
    return true;
  }
  ignoreMutation(m: ViewMutationRecord) {
    return m.type !== "selection" && !!this.head && this.head.contains(m.target);
  }
}

export const headingView: ViewFactory = () => (n) => new HeadingView(n);
export const listView: ViewFactory = () => (n) => new ListView(n);
export const listItemView: ViewFactory = () => (n) => new ListItemView(n);
export const containerView: ViewFactory = () => (n) => new ContainerView(n);
