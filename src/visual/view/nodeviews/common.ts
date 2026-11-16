// Shared pieces for Visual mode's node views.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import type { GetEnv } from "../commands";

export type ViewFactory = (getEnv: GetEnv) => (node: PMNode, view: EditorView, getPos: () => number | undefined) => NodeView;

/** document.createElement with a class and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A small button inside a node view that never moves the editor's selection. */
export function button(label: string, onClick: (e: MouseEvent) => void, title?: string): HTMLButtonElement {
  const b = el("button", "v-btn", label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

// One IntersectionObserver for every lazily drawn node view.
const callbacks = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;

/** Runs `fn` once `target` scrolls near the viewport (at once where IntersectionObserver is missing). */
export function whenVisible(target: Element, fn: () => void) {
  if (typeof IntersectionObserver === "undefined") {
    fn();
    return;
  }
  observer ??= new IntersectionObserver(
    (items) => {
      for (const it of items) {
        if (!it.isIntersecting) continue;
        const cb = callbacks.get(it.target);
        callbacks.delete(it.target);
        observer?.unobserve(it.target);
        cb?.();
      }
    },
    { rootMargin: "400px 0px" },
  );
  callbacks.set(target, fn);
  observer.observe(target);
}

export function unobserve(target: Element) {
  callbacks.delete(target);
  observer?.unobserve(target);
}

// Views whose editor isn't opened by a click on their DOM say how to open it.
const activators = new WeakMap<Node, () => boolean>();

/** What Enter on this view's selected node does (instead of a click on `dom`). */
export function onActivate(dom: Node, fn: () => boolean) {
  activators.set(dom, fn);
}

/**
 * Opens the editor of the atom at `pos`, as clicking it would: Enter on a
 * selected formula, chip or raw block, so they can be edited without a mouse.
 */
export function activateNodeAt(view: EditorView, pos: number): boolean {
  const dom = view.nodeDOM(pos);
  if (!dom) return false;
  const own = activators.get(dom);
  if (own) return own();
  if (!(dom instanceof HTMLElement) || dom.contentEditable !== "false") return false;
  // The views' click handlers call preventDefault when they open something.
  return !dom.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
}

/** Base for atom views: the DOM is ours, ProseMirror only selects it. */
export abstract class AtomView implements NodeView {
  dom: HTMLElement;
  node: PMNode;
  protected view: EditorView;
  protected getPos: () => number | undefined;
  protected getEnv: GetEnv;

  constructor(dom: HTMLElement, node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    this.dom = dom;
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.getEnv = getEnv;
    dom.contentEditable = "false";
  }

  /** Redraws for new attrs. */
  protected abstract paint(): void;

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const same = node.attrs === this.node.attrs || JSON.stringify(node.attrs) === JSON.stringify(this.node.attrs);
    this.node = node;
    if (!same) this.paint();
    return true;
  }

  selectNode() {
    this.dom.classList.add("v-selected");
  }

  deselectNode() {
    this.dom.classList.remove("v-selected");
  }

  stopEvent(e: Event): boolean {
    // Let our own buttons and inputs work; ProseMirror handles the rest (selection, drag).
    const t = e.target as HTMLElement | null;
    return !!t && t !== this.dom && !!t.closest("button, input, textarea, select");
  }

  ignoreMutation(_m: ViewMutationRecord): boolean {
    return true;
  }

  destroy() {
    unobserve(this.dom);
  }
}
