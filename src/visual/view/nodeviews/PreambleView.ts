// The preamble as a collapsed "Document settings" card, with title, author
// and date fields when they are plain text, and the postamble as a quiet end
// marker. Their source is protected from deletion; edits change attrs only.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { atoms, readContext } from "../../core";
import { fileEol, setAttrs, type GetEnv } from "../commands";
import { anchorOf, openPopover } from "../Popovers";
import { AtomView, button, el, type ViewFactory } from "./common";

const FIELDS = ["title", "author", "date"] as const;

/** The plain-text value of \title{..} etc., or null when it isn't simple. */
function fieldValue(src: string, field: (typeof FIELDS)[number]): string | null {
  if (atoms.setTitleField(src, field, "x") === null) return null;
  const m = new RegExp(`\\\\${field}\\s*\\{([^{}]*)\\}`).exec(src);
  return m ? m[1].replace(/\\([%$&#_{}])/g, "$1").replace(/~/g, " ") : null;
}

const cards = new WeakMap<Node, PreambleView>();

class PreambleView extends AtomView {
  private open = false;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-preamble"), node, view, getPos, getEnv);
    cards.set(this.dom, this);
    this.paint();
  }

  /** Revealing a line in the preamble opens the card. */
  expand() {
    if (!this.open) {
      this.open = true;
      this.paint();
    }
  }

  protected paint() {
    const env = this.getEnv();
    const src = this.node.attrs.src as string;
    this.dom.replaceChildren();
    const head = el("div", "v-preamble-head");
    if (env?.dialect === "markdown") {
      head.append(el("span", "v-preamble-title", "Front matter"));
    } else {
      const ctx = readContext("latex", src + "\n\\begin{document}");
      head.append(el("span", "v-preamble-title", "Document settings"));
      head.append(el("span", "v-preamble-meta", [ctx.docClass ?? "no class", `${ctx.packages.length} packages`].join(" · ")));
    }
    const toggle = button(this.open ? "Hide" : "Show", () => {
      this.open = !this.open;
      this.paint();
    });
    toggle.setAttribute("aria-expanded", String(this.open));
    head.append(toggle);
    head.append(
      button("Edit as code", () => {
        openPopover(
          {
            kind: "raw",
            anchor: anchorOf(this.dom),
            src,
            title: env?.dialect === "markdown" ? "Front matter" : "Preamble",
            onCommit: (value) => {
              const next = env ? fileEol(env, value) : value;
              const pos = this.getPos();
              if (pos !== undefined && next !== src) setAttrs(this.view, pos, atoms.setRawSrc(this.node.attrs, next));
            },
            onOpenInCode: () => env?.openInCode(0),
          },
          () => this.view.focus(),
        );
      }),
    );
    this.dom.append(head);
    if (!this.open || env?.dialect !== "latex") return;
    const body = el("div", "v-preamble-fields");
    for (const field of FIELDS) {
      const value = fieldValue(src, field);
      if (value === null) continue;
      const row = el("label", "v-field");
      row.append(el("span", "v-field-name", field[0].toUpperCase() + field.slice(1)));
      const input = el("input", "v-field-input");
      input.value = value;
      input.spellcheck = true;
      const commit = () => {
        if (input.value === value) return;
        const next = atoms.setTitleField(this.node.attrs.src as string, field, input.value);
        const pos = this.getPos();
        if (next !== null && pos !== undefined) setAttrs(this.view, pos, atoms.setRawSrc(this.node.attrs, next));
      };
      input.addEventListener("keydown", (e) => {
        const mod = e.ctrlKey || e.metaKey;
        // Enter keeps the edit; Ctrl+Enter keeps it and goes on to compile.
        if (e.key === "Enter") {
          commit();
          if (!mod) e.preventDefault();
        }
        // Typing stays in the field; Ctrl/Cmd shortcuts (compile, quick open,
        // switching tabs) still reach the window.
        if (!mod) e.stopPropagation();
      });
      input.addEventListener("blur", commit);
      row.append(input);
      body.append(row);
    }
    if (!body.childElementCount) body.append(el("div", "v-muted", "No plain \\title, \\author or \\date to edit here."));
    this.dom.append(body);
  }

  stopEvent(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && !!t.closest("button, input, textarea, label");
  }
}

class PostambleView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-postamble", "End of document"), node, view, getPos, getEnv);
    this.dom.title = (node.attrs.src as string).trim();
  }
  protected paint() {
    this.dom.title = (this.node.attrs.src as string).trim();
  }
}

export const preambleView: ViewFactory = (g) => (n, v, p) => new PreambleView(n, v, p, g);
export const postambleView: ViewFactory = (g) => (n, v, p) => new PostambleView(n, v, p, g);

/** Opens the preamble card drawn in `dom`, if it is one. */
export function expandPreamble(dom: Node | null) {
  if (dom) cards.get(dom)?.expand();
}
