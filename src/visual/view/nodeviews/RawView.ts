// Source that Visual mode keeps exactly as written: raw blocks and inline
// raw chips. Shown highlighted; a click edits the source in a popover.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { monaco } from "../../../editor/monaco";
import { fileEol, replaceWithSource, type GetEnv, type VisualEnv } from "../commands";
import { anchorOf, openPopover } from "../Popovers";
import { AtomView, el, whenVisible, type ViewFactory } from "./common";

/** Highlights `src` into `target` with the code editor's tokenizer. */
export function colorize(target: HTMLElement, src: string, dialect: "latex" | "markdown") {
  target.textContent = src;
  whenVisible(target, () => {
    monaco.editor
      .colorize(src, dialect, { tabSize: 2 })
      .then((html) => {
        // colorize escapes the text itself; the markup is only its own spans.
        if (target.textContent === src) target.innerHTML = html;
      })
      .catch(() => {});
  });
}

/** Opens the source of the node at `getPos()` for editing; the result is parsed again. */
export function editSource(env: VisualEnv, view: EditorView, node: PMNode, getPos: () => number | undefined, anchor: Element, src: string, title?: string) {
  const inline = node.isInline;
  openPopover(
    {
      kind: "raw",
      anchor: anchorOf(anchor),
      src,
      title,
      onCommit: (value) => {
        const pos = getPos();
        const next = fileEol(env, value);
        if (pos === undefined || next === src) return;
        const e = env;
        if (!next.trim() && !inline) {
          view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
          return;
        }
        replaceWithSource(e, pos, next, inline);
      },
      onOpenInCode: () => {
        const pos = getPos();
        env.openInCode(pos === undefined ? undefined : env.session.pmToSrc(pos));
      },
    },
    () => view.focus(),
  );
}

class RawView extends AtomView {
  private code: HTMLElement;
  private label: HTMLElement | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    const inline = node.isInline;
    super(el(inline ? "span" : "div", inline ? "v-raw-inline" : "v-raw-block"), node, view, getPos, getEnv);
    if (!inline) {
      this.label = el("div", "v-raw-label");
      this.dom.append(this.label);
    }
    this.code = el(inline ? "code" : "pre", "v-raw-src");
    this.dom.append(this.code);
    this.dom.title = inline ? "LaTeX kept as written. Click to edit." : "Kept exactly as written. Click to edit.";
    this.dom.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      const env = this.getEnv();
      if (env) editSource(env, this.view, this.node, this.getPos, this.dom, this.node.attrs.src as string, "Source");
    });
    this.paint();
  }

  protected paint() {
    const env = this.getEnv();
    const src = this.node.attrs.src as string;
    if (this.label) this.label.textContent = (this.node.attrs.label as string) || (env?.dialect === "markdown" ? "Markdown" : "LaTeX");
    if (this.node.isInline) this.code.textContent = src;
    else colorize(this.code, src, env?.dialect ?? "latex");
  }
}

export const rawView: ViewFactory = (getEnv) => (node, view, getPos) => new RawView(node, view, getPos, getEnv);
