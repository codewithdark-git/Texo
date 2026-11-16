// Tables as a read-only grid. Simple tabulars open the grid editor; anything
// fancier (multicolumn, nested tabulars, Markdown tables) is edited as code.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { tabular } from "../../core";
import { replaceWithSource, type GetEnv } from "../commands";
import { useGridDialog } from "../GridDialog";
import { AtomView, button, el, onActivate, type ViewFactory } from "./common";
import { colorize, editSource } from "./RawView";

class TableView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-table"), node, view, getPos, getEnv);
    onActivate(this.dom, () => {
      const env = this.getEnv();
      if (!env) return false;
      const src = this.node.attrs.src as string;
      if (env.dialect === "latex" && tabular.parse(src)?.simple) this.editGrid();
      else editSource(env, this.view, this.node, this.getPos, this.dom, src, "Table source");
      return true;
    });
    this.paint();
  }

  protected paint() {
    const env = this.getEnv();
    const src = this.node.attrs.src as string;
    const model = env?.dialect === "latex" ? tabular.parse(src) : null;
    this.dom.replaceChildren();
    const bar = el("div", "v-table-bar");
    const label = this.node.attrs.label as string;
    if (label) bar.append(el("span", "v-chip v-label", "# " + label));
    bar.append(el("span", "v-spacer"));
    if (model?.simple) bar.append(button("Edit table", () => this.editGrid()));
    bar.append(
      button("Edit as code", () => {
        if (env) editSource(env, this.view, this.node, this.getPos, this.dom, src, "Table source");
      }),
    );
    this.dom.append(bar);
    if (model) {
      const table = el("table", "v-table-grid");
      for (const row of model.rows) {
        const tr = el("tr");
        for (const cell of row.cells) tr.append(el("td", undefined, cell.text));
        table.append(tr);
      }
      this.dom.append(table);
    } else {
      const code = el("pre", "v-raw-src");
      colorize(code, src, env?.dialect ?? "latex");
      this.dom.append(code);
    }
    const caption = (model?.caption ?? (this.node.attrs.caption as string)) || "";
    if (caption) this.dom.append(el("div", "v-table-caption", caption));
  }

  private editGrid() {
    const env = this.getEnv();
    if (!env) return;
    useGridDialog.getState().open({
      src: this.node.attrs.src as string,
      onApply: (src) => {
        const pos = this.getPos();
        if (pos !== undefined) replaceWithSource(env, pos, src, false);
        this.view.focus();
      },
    });
  }
}

export const tableView: ViewFactory = (g) => (n, v, p) => new TableView(n, v, p, g);
