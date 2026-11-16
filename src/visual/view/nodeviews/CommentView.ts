// LaTeX comments and Markdown HTML comments: faint, italic, and hidden when
// the "Show comments" preference is off (the pane toggles a class).

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import type { GetEnv } from "../commands";
import { AtomView, el, type ViewFactory } from "./common";
import { editSource } from "./RawView";

class CommentView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-comment"), node, view, getPos, getEnv);
    this.dom.title = "A comment. Click to edit.";
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      const env = this.getEnv();
      if (env) editSource(env, this.view, this.node, this.getPos, this.dom, this.node.attrs.src as string, "Comment");
    });
    this.paint();
  }

  protected paint() {
    this.dom.textContent = this.node.attrs.src as string;
  }
}

export const commentView: ViewFactory = (getEnv) => (node, view, getPos) => new CommentView(node, view, getPos, getEnv);
