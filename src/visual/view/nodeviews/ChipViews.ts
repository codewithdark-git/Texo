// Inline chips: citations, references, labels, footnotes, URLs, glyphs, soft
// line breaks and Markdown images, plus command cards (\input, \maketitle…).

import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { atoms } from "../../core";
import { completionSource } from "../../../editor/completions";
import { revealSource } from "../../../workspace/EditorPane";
import { useWorkspace } from "../../../workspace/store";
import { parentDir } from "../../../workspace/paths";
import { fileEol, safeUrl, setAttrs, type GetEnv } from "../commands";
import { anchorOf, openPopover, type PickItem } from "../Popovers";
import { loadImage, resolveImage } from "../images";
import { AtomView, button, el, type ViewFactory } from "./common";
import { colorize, editSource } from "./RawView";

/** "Author Year" for a citation key from the project's .bib files. */
function citeText(key: string): string | null {
  const c = completionSource.symbols.citations.find((x) => x.key === key);
  if (!c) return null;
  const author = c.author?.split(/\s+and\s+/i)[0]?.trim() ?? "";
  const last = author.includes(",") ? author.split(",")[0] : author.split(/\s+/).pop() ?? "";
  const who = last.replace(/[{}\\]/g, "") || key;
  return c.year ? `${who} ${c.year}` : who;
}

export function citationItems(): PickItem[] {
  return completionSource.symbols.citations.map((c) => ({
    key: c.key,
    label: c.key,
    detail: [c.author, c.year, c.title].filter(Boolean).join(" · ").replace(/[{}]/g, ""),
  }));
}

export function labelItems(): PickItem[] {
  return completionSource.symbols.labels.map((l) => ({ key: l.name, label: l.name, detail: `${l.file}:${l.line}` }));
}

/** Opens a web or mail link; anything else is refused. */
export async function openLink(url: string, toast: (t: string, k?: "success" | "info" | "error") => void) {
  if (!safeUrl(url)) {
    toast("Only web and email links open from Visual mode.", "error");
    return;
  }
  try {
    await openUrl(url.trim());
  } catch {
    toast("Couldn't open the link.", "error");
  }
}

class CiteView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("span", "v-chip v-cite"), node, view, getPos, getEnv);
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      this.edit();
    });
    this.paint();
  }

  protected paint() {
    const keys = this.node.attrs.keys as string[];
    const parts = keys.map((k) => citeText(k));
    const unknown = parts.some((p) => p === null);
    this.dom.classList.toggle("v-unknown", unknown);
    this.dom.textContent = "[" + keys.map((k, i) => parts[i] ?? k).join("; ") + "]";
    this.dom.title = (unknown ? "Not found in the project's .bib files: " : "") + keys.join(", ");
  }

  edit() {
    openPopover(
      {
        kind: "pick",
        anchor: anchorOf(this.dom),
        title: "Citations",
        items: citationItems(),
        multi: true,
        selected: this.node.attrs.keys as string[],
        empty: "No .bib entries in this project yet.",
        onPick: (keys) => {
          const pos = this.getPos();
          if (pos !== undefined && keys.length) setAttrs(this.view, pos, atoms.setCiteKeys(this.node.attrs, keys));
        },
      },
      () => this.view.focus(),
    );
  }
}

class RefView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("span", "v-chip v-ref"), node, view, getPos, getEnv);
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      this.edit();
    });
    this.paint();
  }

  protected paint() {
    const keys = this.node.attrs.keys as string[];
    const known = new Set(completionSource.symbols.labels.map((l) => l.name));
    this.dom.classList.toggle("v-unknown", keys.some((k) => !known.has(k)));
    this.dom.textContent = "→ " + keys.join(", ");
    this.dom.title = `\\${this.node.attrs.cmd}{${keys.join(",")}}`;
  }

  edit() {
    const key = (this.node.attrs.keys as string[])[0];
    const target = completionSource.symbols.labels.find((l) => l.name === key);
    openPopover(
      {
        kind: "pick",
        anchor: anchorOf(this.dom),
        title: "Reference",
        items: labelItems(),
        empty: "No labels in this project yet.",
        onPick: ([k]) => {
          const pos = this.getPos();
          if (pos !== undefined && k) setAttrs(this.view, pos, atoms.setRefKeys(this.node.attrs, [k]));
        },
        extra: target ? { label: "Go to label", run: () => void revealSource(target.file, target.line) } : undefined,
      },
      () => this.view.focus(),
    );
  }
}

class LabelView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("span", "v-chip v-label"), node, view, getPos, getEnv);
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      openPopover(
        {
          kind: "text",
          anchor: anchorOf(this.dom),
          title: "Label",
          value: this.node.attrs.key as string,
          hint: "Renaming a label doesn't change references to it.",
          onCommit: (key) => {
            const pos = this.getPos();
            const k = key.trim();
            if (pos !== undefined && k && k !== this.node.attrs.key && !/[{}\\%#\s]/.test(k)) setAttrs(this.view, pos, atoms.setLabelKey(this.node.attrs, k));
          },
        },
        () => this.view.focus(),
      );
    });
    this.paint();
  }

  protected paint() {
    this.dom.textContent = "# " + (this.node.attrs.key as string);
    this.dom.title = "Label";
  }
}

const isPlain = (s: string) => !/[\\{}$]/.test(s);

class FootnoteView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("sup", "v-chip v-footnote", "*"), node, view, getPos, getEnv);
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      this.edit();
    });
    this.paint();
  }

  protected paint() {
    this.dom.title = "Footnote: " + (this.node.attrs.body as string);
  }

  edit() {
    const env = this.getEnv();
    if (!env) return;
    const body = this.node.attrs.body as string;
    const commit = (value: string) => {
      const next = fileEol(env, value);
      const pos = this.getPos();
      if (pos !== undefined && next !== body) setAttrs(this.view, pos, atoms.setFootnoteBody(this.node.attrs, next));
    };
    if (isPlain(body)) {
      openPopover(
        {
          kind: "text",
          anchor: anchorOf(this.dom),
          title: "Footnote",
          value: body,
          multiline: true,
          onCommit: (text) => commit(isPlain(text) ? env.helpers.escapeText(text) : text),
          extra: { label: "Edit as code", run: () => editSource(env, this.view, this.node, this.getPos, this.dom, this.node.attrs.src as string, "Footnote") },
        },
        () => this.view.focus(),
      );
    } else {
      openPopover({ kind: "raw", anchor: anchorOf(this.dom), src: body, title: "Footnote source", onCommit: commit }, () => this.view.focus());
    }
  }
}

class UrlView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("span", "v-url"), node, view, getPos, getEnv);
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      const env = this.getEnv();
      if (!env) return;
      const url = this.node.attrs.url as string;
      if (e.ctrlKey || e.metaKey) {
        void openLink(url, env.toast);
        return;
      }
      openPopover(
        {
          kind: "link",
          anchor: anchorOf(this.dom),
          href: url,
          onOpen: () => void openLink(url, env.toast),
          onCommit: (href) => {
            const pos = this.getPos();
            if (pos === undefined || href === url || !href) return;
            const src = (this.node.attrs.src as string).split(url).join(href);
            editSourceDirect(env, this.view, pos, src, true);
          },
        },
        () => this.view.focus(),
      );
    });
    this.paint();
  }

  protected paint() {
    this.dom.textContent = this.node.attrs.url as string;
    this.dom.title = `${this.node.attrs.url as string} (Ctrl+click to open)`;
  }
}

function editSourceDirect(env: NonNullable<ReturnType<GetEnv>>, view: EditorView, pos: number, src: string, inline: boolean) {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  const frag = inline ? env.session.parseInlineSnippet(src) : env.session.parseSnippet(src);
  view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, frag));
}

class GlyphView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("span", "v-glyph"), node, view, getPos, getEnv);
    this.paint();
  }
  protected paint() {
    const display = this.node.attrs.display as string;
    this.dom.textContent = display;
    this.dom.title = this.node.attrs.src as string;
    this.dom.classList.toggle("v-glyph-empty", display === "");
  }
}

class SoftbreakView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("span", "v-softbreak", " "), node, view, getPos, getEnv);
  }
  protected paint() {}
}

class ImageView extends AtomView {
  private img = el("img", "v-inline-img");
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("span", "v-image"), node, view, getPos, getEnv);
    this.dom.append(this.img);
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      const env = this.getEnv();
      if (env) editSource(env, this.view, this.node, this.getPos, this.dom, this.node.attrs.src as string, "Image");
    });
    this.paint();
  }
  protected paint() {
    const env = this.getEnv();
    const path = this.node.attrs.path as string;
    this.img.alt = (this.node.attrs.alt as string) || path;
    this.img.title = path;
    this.dom.classList.add("v-missing");
    if (/^[a-z]+:/i.test(path)) return; // remote images are not loaded
    const file = env ? resolveImage(path, env.path, env.session.context.graphicsPaths) : null;
    if (!file) return;
    void loadImage(file).then((url) => {
      if (url && this.node.attrs.path === path) {
        this.img.src = url;
        this.dom.classList.remove("v-missing");
      }
    });
  }
}

const COMMAND_TITLES: Record<string, string> = {
  input: "Included file",
  include: "Included file",
  maketitle: "Title",
  tableofcontents: "Table of contents",
  bibliography: "Bibliography",
  printbibliography: "Bibliography",
  newpage: "Page break",
  clearpage: "Page break",
  appendix: "Appendix",
};

class CommandView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-command"), node, view, getPos, getEnv);
    this.dom.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      const env = this.getEnv();
      if (env) editSource(env, this.view, this.node, this.getPos, this.dom, this.node.attrs.src as string, "Source");
    });
    this.paint();
  }

  protected paint() {
    const env = this.getEnv();
    const kind = this.node.attrs.kind as string;
    const src = this.node.attrs.src as string;
    const name = /^\\([A-Za-z]+)/.exec(src)?.[1] ?? kind;
    this.dom.replaceChildren();
    this.dom.append(el("span", "v-command-title", COMMAND_TITLES[name] ?? COMMAND_TITLES[kind] ?? "Command"));
    const code = el("code", "v-command-src");
    colorize(code, src, env?.dialect ?? "latex");
    this.dom.append(code);
    const target = this.node.attrs.target as string;
    if ((kind === "input" || kind === "include") && target) {
      this.dom.append(
        button("Open", () => {
          const file = includedFile(target, env?.path ?? "");
          if (file) void useWorkspace.getState().openFile(file);
          else env?.toast(`Couldn't find ${target} in this project.`, "error");
        }),
      );
    }
  }
}

/** The project file an \input or \include names (relative to the main document's folder, as LaTeX does). */
function includedFile(target: string, fromFile: string): string | null {
  const ws = useWorkspace.getState();
  const files = new Set(ws.files.filter((f) => !f.isDir).map((f) => f.path));
  const main = ws.project?.mainDocument;
  const name = target.replace(/^\.\//, "");
  for (const dir of [main ? parentDir(main) : "", parentDir(fromFile)]) {
    for (const ext of ["", ".tex"]) {
      const p = (dir ? dir + "/" : "") + name + ext;
      if (files.has(p)) return p;
    }
  }
  return null;
}

export const citeView: ViewFactory = (g) => (n, v, p) => new CiteView(n, v, p, g);
export const refView: ViewFactory = (g) => (n, v, p) => new RefView(n, v, p, g);
export const labelView: ViewFactory = (g) => (n, v, p) => new LabelView(n, v, p, g);
export const footnoteView: ViewFactory = (g) => (n, v, p) => new FootnoteView(n, v, p, g);
export const urlView: ViewFactory = (g) => (n, v, p) => new UrlView(n, v, p, g);
export const glyphView: ViewFactory = (g) => (n, v, p) => new GlyphView(n, v, p, g);
export const softbreakView: ViewFactory = (g) => (n, v, p) => new SoftbreakView(n, v, p, g);
export const imageView: ViewFactory = (g) => (n, v, p) => new ImageView(n, v, p, g);
export const commandView: ViewFactory = (g) => (n, v, p) => new CommandView(n, v, p, g);
