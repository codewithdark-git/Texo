// The preamble as the top of the page, like a word processor's document
// header: the title, author and date drawn as a title block you type into
// (when they are plain text), and a small "Page setup" button in the page's
// corner. The preamble's code stays out of sight; Page setup's Advanced
// section opens it for those who want it. The postamble is a quiet end
// marker. Their source is protected from deletion; edits change attrs only.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { atoms, readContext } from "../../core";
import { fileEol, setAttrs, type GetEnv } from "../commands";
import { anchorOf, openPopover } from "../Popovers";
import { usePageSetup } from "../PageSetupDialog";
import { AtomView, button, el, type ViewFactory } from "./common";

const FIELDS = ["title", "author", "date"] as const;
type Field = (typeof FIELDS)[number];

const PLACEHOLDERS: Record<Field, string> = { title: "Title", author: "Author", date: "Date" };

/** The plain-text value of \title{..} etc., or null when it isn't simple. */
export function fieldValue(src: string, field: Field): string | null {
  if (atoms.setTitleField(src, field, "x") === null) return null;
  const m = new RegExp(`\\\\${field}\\s*\\{([^{}]*)\\}`).exec(src);
  return m ? m[1].replace(/\\([%$&#_{}])/g, "$1").replace(/~/g, " ") : null;
}

/** Grows a textarea to fit its text, so a long title wraps like it would on the page. */
function fit(area: HTMLTextAreaElement) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

const cards = new WeakMap<Node, PreambleView>();

class PreambleView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-preamble"), node, view, getPos, getEnv);
    cards.set(this.dom, this);
    this.paint();
  }

  /** Revealing a line in the preamble: the title block is always shown, so just draw attention to it. */
  expand() {
    this.dom.classList.add("v-flash");
    setTimeout(() => this.dom.classList.remove("v-flash"), 600);
  }

  private commitSrc(next: string) {
    const env = this.getEnv();
    const src = this.node.attrs.src as string;
    const value = env ? fileEol(env, next) : next;
    const pos = this.getPos();
    if (pos !== undefined && value !== src) setAttrs(this.view, pos, atoms.setRawSrc(this.node.attrs, value));
  }

  /** The preamble as code, in the raw popover (Page setup → Advanced, or Front matter). */
  editAsCode() {
    const env = this.getEnv();
    openPopover(
      {
        kind: "raw",
        anchor: anchorOf(this.dom),
        src: this.node.attrs.src as string,
        title: env?.dialect === "markdown" ? "Front matter" : "Preamble",
        onCommit: (value) => this.commitSrc(value),
        onOpenInCode: () => env?.openInCode(0),
      },
      () => this.view.focus(),
    );
  }

  openPageSetup() {
    usePageSetup.getState().open({
      src: this.node.attrs.src as string,
      onApply: (next) => {
        this.commitSrc(next);
        this.view.focus();
      },
      onEditCode: () => this.editAsCode(),
    });
  }

  protected paint() {
    const env = this.getEnv();
    const src = this.node.attrs.src as string;
    this.dom.replaceChildren();
    const markdown = env?.dialect === "markdown";
    const corner = markdown
      ? button("Front matter", () => this.editAsCode(), "Edit the front matter")
      : button("Page setup", () => this.openPageSetup(), "Paper, margins, font and spacing");
    corner.classList.add("v-page-setup");
    corner.setAttribute("aria-haspopup", "dialog");
    this.dom.append(corner);

    const ctx = readContext(markdown ? "markdown" : "latex", markdown ? src : src + "\n\\begin{document}");
    const block = el("div", "v-titleblock");
    block.setAttribute("role", "group");
    block.setAttribute("aria-label", "Title, author and date");
    for (const field of FIELDS) {
      const value = markdown ? null : fieldValue(src, field);
      if (value !== null) block.append(this.input(field, value));
      else if (ctx[field]) {
        // Not plain text (a \thanks, a line break, a macro): shown as it reads, edited as code.
        const text = el("div", `v-title-static v-tb-${field}`, ctx[field]!);
        text.title = "Double-click to edit the preamble as code";
        text.addEventListener("dblclick", (e) => {
          e.preventDefault();
          this.editAsCode();
        });
        block.append(text);
      }
    }
    if (block.childElementCount) this.dom.append(block);
    this.dom.classList.toggle("v-preamble-empty", !block.childElementCount);
  }

  private input(field: Field, value: string): HTMLElement {
    const input = el("textarea", `v-title-input v-tb-${field}`);
    input.rows = 1;
    input.value = value;
    input.spellcheck = true;
    input.placeholder = PLACEHOLDERS[field];
    input.setAttribute("aria-label", PLACEHOLDERS[field]);
    const commit = () => {
      const text = input.value.replace(/\s*\n\s*/g, " ");
      if (text === value) return;
      const next = atoms.setTitleField(this.node.attrs.src as string, field, text);
      if (next !== null) this.commitSrc(next);
    };
    input.addEventListener("input", () => fit(input));
    input.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      // Enter keeps the edit (a title is one paragraph); Ctrl+Enter keeps it and goes on to compile.
      if (e.key === "Enter") {
        commit();
        if (!mod) e.preventDefault();
      }
      if (e.key === "Escape") {
        input.value = value;
        input.blur();
      }
      // Typing stays in the field; Ctrl/Cmd shortcuts (compile, quick open,
      // switching tabs) still reach the window.
      if (!mod) e.stopPropagation();
    });
    input.addEventListener("blur", commit);
    requestAnimationFrame(() => fit(input));
    return input;
  }

  stopEvent(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && !!t.closest("button, input, textarea, label, .v-title-static");
  }
}

class PostambleView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-postamble", "End of document"), node, view, getPos, getEnv);
    this.dom.setAttribute("aria-label", "End of document");
  }
  protected paint() {}
}

export const preambleView: ViewFactory = (g) => (n, v, p) => new PreambleView(n, v, p, g);
export const postambleView: ViewFactory = (g) => (n, v, p) => new PostambleView(n, v, p, g);

/** Draws attention to the preamble drawn in `dom`, if it is one. */
export function expandPreamble(dom: Node | null) {
  if (dom) cards.get(dom)?.expand();
}

/** Opens Page setup for the preamble drawn in `dom` (the ribbon's Layout button uses this). */
export function openPageSetupFor(dom: Node | null): boolean {
  const card = dom ? cards.get(dom) : undefined;
  if (!card) return false;
  card.openPageSetup();
  return true;
}
