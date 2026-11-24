// A place in a node view that shows a block as it appears in the compiled
// PDF (see pdfSnapshot.ts), with a neutral placeholder until there is a
// picture. It redraws after every compile, keeping the old picture until the
// new one arrives, and never shows source.

import type { Node as PMNode } from "prosemirror-model";
import type { GetEnv } from "../commands";
import { cachedSnapshot, onCompileFinished, snapshot, type Snapshot, type SnapshotRequest } from "../pdfSnapshot";
import { el, unobserve, whenVisible } from "./common";

export class SnapshotSlot {
  readonly dom: HTMLElement;
  private drawn = "";
  private paintedSrc = "";
  private stop: () => void;

  constructor(
    private host: HTMLElement,
    private getNode: () => PMNode,
    private getPos: () => number | undefined,
    private getEnv: GetEnv,
    private placeholderText: string,
    private alt: string,
  ) {
    this.dom = el("div", "v-snapshot-slot");
    this.stop = onCompileFinished(() => this.refresh());
  }

  /** The block's place in its file's text, for SyncTeX. */
  private request(): SnapshotRequest | null {
    const env = this.getEnv();
    const pos = this.getPos();
    if (!env || pos === undefined || env.dialect !== "latex") return null;
    return { path: env.path, text: env.session.text, start: env.session.pmToSrc(pos), end: env.session.pmToSrc(pos + this.getNode().nodeSize) };
  }

  /** Draws what is known now and fetches a picture when the slot scrolls into view. */
  refresh() {
    const src = this.getNode().attrs.src as string;
    const req = this.request();
    if (!req) return this.placeholder();
    const cached = cachedSnapshot(req);
    if (cached) {
      this.paintedSrc = src;
      return this.show(cached);
    }
    // The old picture is still right while the source is the same; a changed block waits for a compile.
    if (cached === null || src !== this.paintedSrc || !this.host.classList.contains("v-has-snapshot")) this.placeholder();
    this.paintedSrc = src;
    if (cached === undefined) {
      unobserve(this.dom);
      whenVisible(this.dom, () => this.fetch());
    }
  }

  private fetch() {
    const req = this.request();
    if (!req) return;
    const src = this.getNode().attrs.src as string;
    void snapshot(req).then((snap) => {
      if (this.getNode().attrs.src !== src || !this.dom.isConnected) return;
      if (snap) this.show(snap);
    });
  }

  private placeholder() {
    if (this.drawn === this.placeholderText) return;
    this.drawn = this.placeholderText;
    this.host.classList.remove("v-has-snapshot");
    this.dom.replaceChildren(el("span", "v-raw-placeholder", this.placeholderText));
  }

  private show(snap: Snapshot) {
    if (this.drawn === snap.url) return;
    this.drawn = snap.url;
    const img = el("img", "v-raw-snapshot");
    img.src = snap.url;
    img.alt = this.alt;
    img.draggable = false;
    // Drawn at the page's own scale: one PDF point is --v-pt pixels.
    img.style.width = `calc(var(--v-pt, 1.333px) * ${snap.widthPt.toFixed(2)})`;
    this.host.classList.add("v-has-snapshot");
    this.dom.replaceChildren(img);
  }

  destroy() {
    unobserve(this.dom);
    this.stop();
  }
}
