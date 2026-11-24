// Command blocks (\input, \include, \maketitle, \tableofcontents, \newpage…)
// as they read on the page, never as code. An included file is drawn in
// place, read-only, with a quiet "from file.tex" marker and an Edit button
// that opens it in Visual mode. Other commands show what they do in words.
// Double-click (or Enter) still edits the command's LaTeX.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { getModel, useWorkspace } from "../../../workspace/store";
import { switchMode } from "../../../workspace/editorBridge";
import type { GetEnv } from "../commands";
import { chainOf, displayName, includedFile, loadIncludeText, mayInline, renderInclude } from "../includePreview";
import { AtomView, button, el, onActivate, unobserve, whenVisible, type ViewFactory } from "./common";
import { commandLabel, commandName } from "./friendly";
import { editSource } from "./RawView";

const PAGE_BREAKS = new Set(["newpage", "clearpage", "cleardoublepage", "pagebreak"]);

/** Opens a project file in Visual mode. */
async function openInVisual(file: string) {
  await useWorkspace.getState().openFile(file);
  switchMode(file, "visual");
}

class CommandView extends AtomView {
  private child: EditorView | null = null;
  private stopWatch: (() => void) | null = null;
  private shown = "";
  private destroyed = false;
  /** Bumped by every paint, so a draw from an earlier paint (a slow disk read) knows it is stale. */
  private paintGen = 0;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-command"), node, view, getPos, getEnv);
    this.dom.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      this.activate();
    });
    onActivate(this.dom, () => this.activate());
    this.paint();
  }

  private isInclude(): boolean {
    const kind = this.node.attrs.kind as string;
    return (kind === "input" || kind === "include") && !!this.node.attrs.target;
  }

  /** Enter or double-click: an include opens its file; anything else edits its LaTeX. */
  private activate(): boolean {
    const env = this.getEnv();
    if (!env) return false;
    if (this.isInclude()) {
      const file = includedFile(this.node.attrs.target as string, env.path);
      if (file) {
        void openInVisual(file);
        return true;
      }
    }
    editSource(env, this.view, this.node, this.getPos, this.dom, this.node.attrs.src as string, "Edit LaTeX");
    return true;
  }

  protected paint() {
    const src = this.node.attrs.src as string;
    const key = src + "\u0000" + (this.node.attrs.target as string);
    if (key === this.shown) return;
    this.shown = key;
    this.paintGen++;
    this.clearChild();
    this.stopWatch?.();
    this.stopWatch = null;
    this.dom.replaceChildren();
    this.dom.className = "v-command";
    if (this.isInclude()) return this.paintInclude();
    const name = commandName(src) ?? "";
    const label = commandLabel(src, this.node.attrs.kind as string);
    this.dom.setAttribute("aria-label", label);
    this.dom.title = `${label}. Double-click to edit.`;
    if (PAGE_BREAKS.has(name)) {
      this.dom.classList.add("v-page-break");
      this.dom.append(el("span", "v-page-break-label", "Page break"));
      return;
    }
    this.dom.classList.add(`v-c-${name.replace(/[^a-z]/gi, "") || "other"}`);
    this.dom.append(el("span", "v-command-title", label));
  }

  private paintInclude() {
    const env = this.getEnv();
    const target = this.node.attrs.target as string;
    const name = displayName(target);
    this.dom.classList.add("v-include");
    this.dom.setAttribute("aria-label", `Included file ${name}`);
    this.dom.title = "";
    const bar = el("div", "v-include-bar");
    bar.append(el("span", "v-include-from", `from ${name}`));
    const file = env ? includedFile(target, env.path) : null;
    if (file) {
      const edit = button("Edit", () => void openInVisual(file), `Open ${name} to edit it`);
      edit.setAttribute("aria-label", `Edit ${name}`);
      bar.append(edit);
    }
    this.dom.append(bar);
    const body = el("div", "v-include-body");
    this.dom.append(body);
    if (!env || !file) {
      body.append(el("div", "v-include-note", `File not found: ${name}`));
      this.dom.classList.add("v-include-missing");
      return;
    }
    const chain = chainOf(env);
    const allowed = mayInline(chain, file);
    if (allowed !== "ok") {
      body.append(el("div", "v-include-note", allowed === "cycle" ? `${name} (already shown above)` : `${name} (open it to see its contents)`));
      return;
    }
    body.append(el("div", "v-include-note", `Loading ${name}…`));
    const gen = this.paintGen;
    const draw = () => {
      void loadIncludeText(file).then((text) => {
        // A later paint replaced this body (even with the same target): leave its view alone.
        if (this.destroyed || gen !== this.paintGen) return;
        this.clearChild();
        body.replaceChildren();
        if (text === null) {
          body.append(el("div", "v-include-note", `File not found: ${name}`));
          return;
        }
        this.child = renderInclude(body, file, text, { chain, context: env.session.context }, env.toast);
        if (!this.child) body.append(el("div", "v-include-note", name));
        this.watch(file, draw);
      });
    };
    whenVisible(this.dom, draw);
  }

  /** Redraws the include when its open editor changes (a short pause first); replaces any earlier watcher. */
  private watch(file: string, draw: () => void) {
    this.stopWatch?.();
    this.stopWatch = null;
    const model = getModel(file);
    if (!model) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(draw, 400);
    });
    this.stopWatch = () => {
      clearTimeout(timer);
      sub.dispose();
    };
  }

  private clearChild() {
    this.child?.destroy();
    this.child = null;
  }

  stopEvent(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    // The included file's view is read-only: its events are ours (select, double-click to open).
    return !!t && t !== this.dom && !!t.closest("button");
  }

  destroy() {
    super.destroy();
    this.destroyed = true;
    unobserve(this.dom);
    this.stopWatch?.();
    this.clearChild();
  }
}

export const commandView: ViewFactory = (g) => (n, v, p) => new CommandView(n, v, p, g);
