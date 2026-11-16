// Inline and display maths drawn with KaTeX when they scroll into view. A
// click opens the maths popover; the edit goes through atoms.setMathBody so
// the delimiters and environment stay as written.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { atoms } from "../../core";
import { fileEol, setAttrs, type GetEnv } from "../commands";
import { displayTex, renderTex, stripForPreview } from "../katex";
import { anchorOf, openPopover } from "../Popovers";
import { AtomView, el, whenVisible, type ViewFactory } from "./common";

class MathView extends AtomView {
  private display: boolean;
  private drawn = false;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    const display = node.type.name === "math_display";
    super(el(display ? "div" : "span", display ? "v-math v-math-display" : "v-math v-math-inline"), node, view, getPos, getEnv);
    this.display = display;
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      this.edit();
    });
    this.paintSource();
    whenVisible(this.dom, () => this.paint());
  }

  /** Until it is visible (or when KaTeX can't draw it): the TeX itself. */
  private paintSource(error?: string) {
    const body = this.node.attrs.body as string;
    this.dom.replaceChildren();
    const code = el("code", error ? "v-math-src v-math-error" : "v-math-src", body.trim() || (this.display ? "Empty equation" : "∅"));
    if (error) code.title = error;
    this.dom.append(code);
  }

  protected paint() {
    this.drawn = true;
    const env = this.getEnv();
    const ctx = env?.session.context;
    const { tex, labels } = stripForPreview(this.node.attrs.body as string);
    const src = this.display ? displayTex(tex, this.node.attrs.env as string) : tex;
    if (!src.trim()) {
      this.paintSource();
      return;
    }
    const r = renderTex(src, this.display, ctx?.macros, ctx?.macrosHash);
    if (r.error) {
      this.paintSource(r.error);
    } else {
      this.dom.replaceChildren();
      const out = el("span", "v-math-out");
      out.innerHTML = r.html;
      this.dom.append(out);
    }
    if (this.display && labels.length) {
      const chips = el("span", "v-math-labels");
      for (const l of labels) chips.append(el("span", "v-chip v-label", "# " + l));
      this.dom.append(chips);
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.body !== this.node.attrs.body || node.attrs.env !== this.node.attrs.env;
    this.node = node;
    if (changed) {
      if (this.drawn) this.paint();
      else this.paintSource();
    }
    return true;
  }

  edit() {
    const env = this.getEnv();
    if (!env) return;
    const ctx = env.session.context;
    const node = this.node;
    openPopover(
      {
        kind: "math",
        anchor: anchorOf(this.dom),
        body: node.attrs.body as string,
        display: this.display,
        env: node.attrs.env as string,
        macros: ctx.macros,
        macrosHash: ctx.macrosHash,
        onCommit: (value) => {
          const body = fileEol(env, value);
          const pos = this.getPos();
          if (pos === undefined || body === this.node.attrs.body) return;
          if (!body.trim() && !this.display) {
            // An empty inline formula goes away.
            this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
            return;
          }
          setAttrs(this.view, pos, atoms.setMathBody(this.node.attrs, body));
        },
      },
      () => this.view.focus(),
    );
  }
}

export const mathView: ViewFactory = (getEnv) => (node, view, getPos) => new MathView(node, view, getPos, getEnv);
