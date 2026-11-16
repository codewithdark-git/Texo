// A figure: its image (found the way LaTeX finds it), an editable caption,
// the label as a chip, and buttons to change the image or edit the source.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { serializeNode } from "../../core";
import { useWorkspace } from "../../../workspace/store";
import { parentDir } from "../../../workspace/paths";
import { setAttrs, type GetEnv } from "../commands";
import { anchorOf, openPopover } from "../Popovers";
import { IMAGE_FILE, loadImage, resolveImage } from "../images";
import { button, el, type ViewFactory } from "./common";
import { editSource } from "./RawView";

/**
 * How a figure should name a project image: relative to the main document's
 * folder for LaTeX (where pdflatex runs), relative to the file for Markdown.
 */
export function figurePath(file: string, fromFile: string, dialect: "latex" | "markdown"): string {
  const base = dialect === "latex" ? parentDir(useWorkspace.getState().project?.mainDocument ?? "") : parentDir(fromFile);
  if (!base) return file;
  if (file.startsWith(base + "/")) return file.slice(base.length + 1);
  const up = base.split("/").map(() => "..").join("/");
  return `${up}/${file}`;
}

class FigureView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private media: HTMLElement;
  private img: HTMLImageElement;
  private note: HTMLElement;
  private chip: HTMLElement;
  private shownPath = "";

  constructor(
    node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private getEnv: GetEnv,
  ) {
    this.node = node;
    this.dom = el("figure", "v-figure");
    this.media = el("div", "v-figure-media");
    this.media.contentEditable = "false";
    this.img = el("img", "v-figure-img");
    this.img.draggable = false;
    this.note = el("div", "v-figure-missing");
    const bar = el("div", "v-figure-bar");
    this.chip = el("span", "v-chip v-label");
    bar.append(this.chip, button("Change image", () => this.changeImage()), button("Edit as code", () => this.editCode()));
    this.media.append(this.img, this.note, bar);
    this.contentDOM = el("div", "v-figure-caption");
    this.dom.append(this.media, this.contentDOM);
    this.paint();
  }

  private paint() {
    const label = this.node.attrs.label as string;
    this.chip.textContent = label ? "# " + label : "";
    this.chip.hidden = !label;
    const path = this.node.attrs.path as string;
    if (path === this.shownPath) return;
    this.shownPath = path;
    this.img.hidden = true;
    this.note.hidden = false;
    this.note.textContent = path ? `Image: ${path}` : "No image";
    const env = this.getEnv();
    if (!env || !path) return;
    const file = resolveImage(path, env.path, env.session.context.graphicsPaths);
    if (!file) {
      this.note.textContent = `Image not found: ${path}`;
      return;
    }
    if (/\.eps$/i.test(file)) {
      this.note.textContent = `EPS image: ${file} (shown in the PDF)`;
      return;
    }
    void loadImage(file).then((url) => {
      if (this.shownPath !== path) return;
      if (url) {
        this.img.src = url;
        this.img.alt = path;
        this.img.hidden = false;
        this.note.hidden = true;
      } else this.note.textContent = `Couldn't show ${file}`;
    });
  }

  private changeImage() {
    const env = this.getEnv();
    if (!env) return;
    const images = useWorkspace
      .getState()
      .files.filter((f) => !f.isDir && IMAGE_FILE.test(f.path))
      .map((f) => ({ key: f.path, label: f.path }));
    openPopover(
      {
        kind: "pick",
        anchor: anchorOf(this.media),
        title: "Image",
        items: images,
        empty: "No images in this project yet.",
        onPick: ([file]) => {
          const pos = this.getPos();
          if (pos === undefined || !file) return;
          setAttrs(this.view, pos, env.helpers.setFigurePath(this.node.attrs, figurePath(file, env.path, env.dialect)));
        },
      },
      () => this.view.focus(),
    );
  }

  private editCode() {
    const env = this.getEnv();
    if (!env) return;
    editSource(env, this.view, this.node, this.getPos, this.media, serializeNode(this.node, env.dialect), "Figure source");
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.paint();
    return true;
  }

  stopEvent(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && !!t.closest("button");
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    if (m.type === "selection") return false;
    return !this.contentDOM.contains(m.target);
  }
}

export const figureView: ViewFactory = (g) => (n, v, p) => new FigureView(n, v, p, g);
