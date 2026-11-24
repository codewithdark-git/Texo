// Tables as a read-only grid. Simple tabulars open the grid editor; anything
// fancier (multicolumn, nested tabulars) is shown as it appears in the PDF
// and edited as LaTeX.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { tabular } from "../../core";
import { replaceWithSource, type GetEnv } from "../commands";
import { useGridDialog } from "../GridDialog";
import { AtomView, button, el, onActivate, type ViewFactory } from "./common";
import { editSource } from "./RawView";
import { SnapshotSlot } from "./SnapshotSlot";
import { plainRows } from "./tableCells";

/** The cells of a Markdown pipe table (the |---| rule left out). */
export function markdownRows(src: string): string[][] | null {
  const lines = src.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length || !lines.every((l) => l.includes("|"))) return null;
  return lines
    .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replace(/\\\|/g, "|")),
    );
}

class TableView extends AtomView {
  private slot: SnapshotSlot | null = null;

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
      button("Edit LaTeX", () => {
        if (env) editSource(env, this.view, this.node, this.getPos, this.dom, src, "Table source");
      }),
    );
    this.dom.append(bar);
    // LaTeX cells that still hold code (a macro, maths) show as in the PDF.
    const rows = model ? plainRows(model.rows.map((r) => r.cells.map((c) => c.text))) : env?.dialect === "markdown" ? markdownRows(src) : null;
    if (rows) {
      // A wide table scrolls inside the page instead of widening it.
      const wrap = el("div", "v-table-wrap");
      const table = el("table", "v-table-grid");
      for (const row of rows) {
        const tr = el("tr");
        for (const cell of row) tr.append(el("td", undefined, cell));
        table.append(tr);
      }
      wrap.append(table);
      this.dom.append(wrap);
    } else {
      this.slot ??= new SnapshotSlot(this.dom, () => this.node, this.getPos, this.getEnv, "Table — shown in the PDF", "The table, as it appears in the compiled PDF");
      this.dom.append(this.slot.dom);
      this.slot.refresh();
    }
    const caption = (model?.caption ?? (this.node.attrs.caption as string)) || "";
    if (caption) this.dom.append(el("div", "v-table-caption", caption));
  }

  destroy() {
    super.destroy();
    this.slot?.destroy();
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
