// LaTeX that Visual mode keeps exactly as written (raw blocks and inline raw
// pieces), shown the way it comes out rather than as code: a block is a
// picture of its place in the compiled PDF (see pdfSnapshot.ts), or a quiet
// placeholder before there is one; an inline piece shows the text it
// prints. Double-click, Enter, or the "…" menu still edits the source.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { monaco } from "../../../editor/monaco";
import { fileEol, replaceWithSource, type GetEnv, type VisualEnv } from "../commands";
import { anchorOf, openPopover } from "../Popovers";
import { AtomView, button, el, onActivate, whenVisible, type ViewFactory } from "./common";
import { SnapshotSlot } from "./SnapshotSlot";
import { readableInline } from "./friendly";
import { macroOutput, onTextMacros } from "../macroText";
import { renderTex } from "../katex";

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

const PLACEHOLDER = "Custom LaTeX — shown in the PDF";

class RawView extends AtomView {
  private body: HTMLElement;
  private slot: SnapshotSlot | null = null;
  private menu: HTMLElement | null = null;
  private offMacros: (() => void) | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    const inline = node.isInline;
    super(el(inline ? "span" : "div", inline ? "v-raw-inline" : "v-raw-block"), node, view, getPos, getEnv);
    if (inline) {
      this.body = el("span", "v-raw-body");
      // A call to one of the project's text macros repaints when their definitions arrive.
      this.offMacros = onTextMacros(() => this.paint());
    } else {
      const label = (node.attrs.label as string) || "";
      const text = label && !label.includes("\\") ?`${PLACEHOLDER} (${label})` : PLACEHOLDER;
      this.slot = new SnapshotSlot(this.dom, () => this.node, this.getPos, this.getEnv, text, "Custom LaTeX, as it appears in the compiled PDF");
      this.body = this.slot.dom;
    }
    this.dom.append(this.body);
    this.dom.setAttribute("role", inline ? "img" : "group");
    if (!inline) this.dom.append(this.moreButton());
    this.dom.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("button, [role=menu]")) return;
      e.preventDefault();
      this.edit();
    });
    // Enter on the selected block edits it, as double-click does.
    onActivate(this.dom, () => {
      this.edit();
      return true;
    });
    this.paint();
  }

  private edit() {
    this.closeMenu();
    const env = this.getEnv();
    if (env) editSource(env, this.view, this.node, this.getPos, this.dom, this.node.attrs.src as string, "Edit LaTeX");
  }

  private moreButton(): HTMLElement {
    const more = button("…", () => (this.menu ? this.closeMenu() : this.openMenu()), "More");
    more.classList.add("v-raw-more");
    more.setAttribute("aria-label", "More options");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    return more;
  }

  private openMenu() {
    const menu = el("div", "v-raw-menu");
    menu.setAttribute("role", "menu");
    const item = (label: string, run: () => void) => {
      const b = button(label, () => {
        this.closeMenu();
        run();
      });
      b.setAttribute("role", "menuitem");
      b.classList.add("v-menu-item");
      menu.append(b);
      return b;
    };
    const first = item("Edit LaTeX", () => this.edit());
    item("Show in Code", () => {
      const env = this.getEnv();
      const pos = this.getPos();
      env?.openInCode(pos === undefined ? undefined : env.session.pmToSrc(pos));
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeMenu();
        this.view.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    });
    this.menu = menu;
    this.dom.append(menu);
    this.dom.querySelector(".v-raw-more")?.setAttribute("aria-expanded", "true");
    first.focus();
    setTimeout(() => document.addEventListener("mousedown", this.outside, true));
  }

  private outside = (e: MouseEvent) => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
  };

  private closeMenu() {
    document.removeEventListener("mousedown", this.outside, true);
    this.menu?.remove();
    this.menu = null;
    this.dom.querySelector(".v-raw-more")?.setAttribute("aria-expanded", "false");
  }

  protected paint() {
    const src = this.node.attrs.src as string;
    if (this.slot) {
      const label = (this.node.attrs.label as string) || "";
      this.dom.setAttribute("aria-label", label && !label.includes("\\") ? `Custom LaTeX (${label}), as in the PDF` : "Custom LaTeX, as in the PDF");
      this.dom.title = "Shown as in the compiled PDF. Double-click to edit the LaTeX.";
      this.slot.refresh();
      return;
    }
    // A comment line inside a paragraph: shown (faintly) only with "Show LaTeX comments" on, like a comment block.
    const comment = /^\s*%/.test(src);
    this.dom.classList.toggle("v-comment-inline", comment);
    if (comment) {
      const note = src.replace(/^\s*%+\s?/, "").trimEnd();
      this.body.textContent = note;
      this.dom.title = "A comment. Double-click to edit.";
      this.dom.setAttribute("aria-label", `Comment: ${note}`);
      return;
    }
    // `\numRuns{}` defined as `{5}` elsewhere in the project reads as "5".
    const macro = macroOutput(src);
    this.dom.classList.toggle("v-macro-text", !!macro);
    if (macro) {
      const math = "math" in macro ? renderTex(macro.math, false) : null;
      if (math && !math.error) this.body.innerHTML = math.html;
      else this.body.textContent = "text" in macro ? macro.text : macro.math;
      this.dom.classList.remove("v-raw-empty");
      this.dom.title = "Text from a macro defined in the project. Double-click to edit.";
      this.dom.setAttribute("aria-label", this.body.textContent ?? "");
      return;
    }
    const text = readableInline(src);
    this.body.textContent = text || "◆";
    this.dom.classList.toggle("v-raw-empty", !text);
    this.dom.title = text ? "Custom LaTeX. Double-click to edit." : "Custom LaTeX (shown in the PDF). Double-click to edit.";
    this.dom.setAttribute("aria-label", text ? `Custom LaTeX: ${text}` : "Custom LaTeX");
  }

  destroy() {
    super.destroy();
    this.offMacros?.();
    this.closeMenu();
    this.slot?.destroy();
  }
}

export const rawView: ViewFactory = (getEnv) => (node, view, getPos) => new RawView(node, view, getPos, getEnv);
