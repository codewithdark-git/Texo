// Views for the layout pieces a word processor has and LaTeX spells as
// commands: text size and colour (marks), horizontal space (an inline atom),
// vertical space and page breaks (blocks), and aligned paragraphs (a
// container). The core gains these node and mark types separately, so every
// factory here is registered only when the schema has its type: the pane
// works the same before and after that change.

import type { Mark, Node as PMNode, Schema } from "prosemirror-model";
import type { EditorView, MarkViewConstructor, NodeView, NodeViewConstructor, ViewMutationRecord } from "prosemirror-view";
import type { GetEnv } from "../commands";
import { lengthCm } from "../pageSetup";
import { AtomView, el, type ViewFactory } from "./common";

/* ---------- Pure helpers ---------- */

/** LaTeX's relative sizes, at 10pt, as em of the body text. */
export const LATEX_SIZES: Record<string, number> = {
  tiny: 0.5,
  scriptsize: 0.7,
  footnotesize: 0.8,
  small: 0.9,
  normalsize: 1,
  large: 1.2,
  Large: 1.44,
  LARGE: 1.728,
  huge: 2.074,
  Huge: 2.488,
};

/** The size command a mark's attrs name ("large"), or null. */
export function sizeName(attrs: Record<string, unknown>): string | null {
  for (const k of ["cmd", "size", "name", "value"]) {
    const v = attrs[k];
    if (typeof v === "string") {
      const name = v.replace(/^\\/, "").trim();
      if (name in LATEX_SIZES) return name;
    }
  }
  return null;
}

// xcolor's base colours, and the dvipsnames people use most.
const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  yellow: "#ffff00",
  gray: "#808080",
  darkgray: "#404040",
  lightgray: "#bfbfbf",
  brown: "#bf8040",
  lime: "#bfff00",
  olive: "#808000",
  orange: "#ff8000",
  pink: "#ffbfbf",
  purple: "#bf0040",
  teal: "#008080",
  violet: "#800080",
  NavyBlue: "#006eb8",
  RoyalBlue: "#0071bc",
  ForestGreen: "#009b55",
  BrickRed: "#b6321c",
  Maroon: "#af3235",
  Orange: "#f58137",
  Gray: "#949698",
};

/**
 * A CSS colour for an xcolor spec: a name ("red"), a mix ("red!40" or
 * "red!40!blue"), or a model value ("HTML" "FF8800", "rgb" "1,0.5,0",
 * "RGB" "255,128,0", "gray" "0.5"). Null when it isn't one we know.
 */
export function cssColor(spec: string, model?: string): string | null {
  const s = spec.trim();
  if (model) {
    const m = model.trim();
    if (m === "HTML" && /^[0-9a-f]{6}$/i.test(s)) return `#${s.toLowerCase()}`;
    const nums = s.split(",").map((x) => Number(x.trim()));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    if (m === "rgb" && nums.length === 3) return `rgb(${nums.map((n) => Math.round(n * 255)).join(", ")})`;
    if (m === "RGB" && nums.length === 3) return `rgb(${nums.map((n) => Math.round(n)).join(", ")})`;
    if (m === "gray" && nums.length === 1) {
      const g = Math.round(nums[0] * 255);
      return `rgb(${g}, ${g}, ${g})`;
    }
    return null;
  }
  const parts = s.split("!");
  const base = NAMED[parts[0]];
  if (!base) return null;
  if (parts.length === 1) return base;
  const pct = Number(parts[1]);
  if (!Number.isFinite(pct)) return null;
  const other = parts[2] ? NAMED[parts[2]] : "#ffffff";
  if (!other) return null;
  return `color-mix(in srgb, ${base} ${Math.max(0, Math.min(100, pct))}%, ${other})`;
}

/** A mark's colour from its attrs (`color`, with an optional `model`). */
export function markColor(attrs: Record<string, unknown>): string | null {
  const spec = [attrs.color, attrs.value, attrs.name].find((v) => typeof v === "string") as string | undefined;
  if (!spec) return null;
  return cssColor(spec, typeof attrs.model === "string" && attrs.model ? attrs.model : undefined);
}

/** A LaTeX length in PDF points (for --v-pt), or null for \fill, \baselineskip and the like. */
export function lengthPt(value: string): number | null {
  const v = value.trim().replace(/^\{|\}$/g, "");
  if (/^\\(baselineskip|bigskipamount)$/.test(v)) return 12;
  if (/^\\medskipamount$/.test(v)) return 6;
  if (/^\\smallskipamount$/.test(v)) return 3;
  const cm = lengthCm(v);
  return cm === null ? null : (cm / 2.54) * 72;
}

/** The length an atom's attrs give ("1cm" in `amount`, `length`, `size` or the command's source). */
export function atomLength(attrs: Record<string, unknown>): string | null {
  for (const k of ["amount", "length", "size", "height", "width", "value"]) {
    if (typeof attrs[k] === "string" && attrs[k]) return attrs[k] as string;
  }
  const src = typeof attrs.src === "string" ? attrs.src : "";
  return /\{([^{}]*)\}\s*$/.exec(src)?.[1] ?? null;
}

/** "center" | "right" | "left" from an align container's attrs. */
export function alignOf(attrs: Record<string, unknown>): "center" | "right" | "left" | null {
  const raw = [attrs.align, attrs.kind, attrs.env, attrs.value].find((v) => typeof v === "string") as string | undefined;
  if (!raw) return null;
  // \raggedright sets text flush left, \raggedleft flush right.
  if (/center|centering/i.test(raw)) return "center";
  if (/raggedright/i.test(raw)) return "left";
  if (/raggedleft/i.test(raw)) return "right";
  if (/right/i.test(raw)) return "right";
  if (/left/i.test(raw)) return "left";
  return null;
}

/** Opens an atom's LaTeX in the source popover (loaded lazily: it pulls in the code editor). */
function editAtom(v: { getEnv: GetEnv; view: EditorView; node: PMNode; getPos: () => number | undefined; dom: HTMLElement }, title: string) {
  const env = v.getEnv();
  const src = v.node.attrs.src;
  if (!env || typeof src !== "string") return;
  void import("./RawView").then(({ editSource }) => editSource(env, v.view, v.node, v.getPos, v.dom, src, title));
}

/* ---------- Marks ---------- */

const sizeMark: MarkViewConstructor = (mark: Mark) => {
  const dom = el("span", "v-size");
  const name = sizeName(mark.attrs);
  if (name) dom.classList.add(`v-size-${name}`);
  return { dom };
};

const colorMark: MarkViewConstructor = (mark: Mark) => {
  const dom = el("span", "v-color");
  const color = markColor(mark.attrs);
  if (color) dom.style.setProperty("--v-text-color", color);
  return { dom };
};

/* ---------- Nodes ---------- */

/**
 * Spacing inside text: a blank gap as wide as the length asks (a wider one
 * for \hfill), a line break for \\, nothing visible for \noindent. The
 * core's `kind` says which; without one it is a horizontal space.
 */
class HSpaceView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("span", "v-hspace"), node, view, getPos, getEnv);
    this.dom.addEventListener("dblclick", (e) => {
      e.preventDefault();
      editAtom({ getEnv: this.getEnv, view: this.view, node: this.node, getPos: this.getPos, dom: this.dom }, "Edit space");
    });
    this.paint();
  }
  protected paint() {
    const kind = typeof this.node.attrs.kind === "string" && this.node.attrs.kind ? this.node.attrs.kind : "hspace";
    const len = atomLength(this.node.attrs);
    const pt = len ? lengthPt(len) : null;
    this.dom.className = `v-spacing v-spacing-${kind.replace(/[^a-z]/gi, "")}`;
    this.dom.style.width = "";
    this.dom.style.removeProperty("--v-gap");
    this.dom.replaceChildren();
    if (kind === "pagebreak") {
      this.dom.classList.add("v-page-break");
      this.dom.append(el("span", "v-page-break-label", "Page break"));
      this.dom.setAttribute("aria-label", "Page break");
      this.dom.title = "Page break";
      return;
    }
    if (kind === "break" || kind === "vspace") {
      // A line break (with extra room for a vertical space).
      if (kind === "vspace" && pt !== null) this.dom.style.setProperty("--v-gap", `calc(var(--v-pt, 1.333px) * ${Math.max(0, pt).toFixed(2)})`);
      this.dom.setAttribute("aria-label", kind === "break" ? "Line break" : "Vertical space");
      this.dom.title = kind === "break" ? "Line break" : len ? `Vertical space (${len})` : "Vertical space";
      return;
    }
    if (kind === "noindent") {
      this.dom.setAttribute("aria-label", "No indent");
      this.dom.title = "No indent";
      return;
    }
    if (kind === "thin") this.dom.style.width = "0.17em";
    else if (pt !== null) this.dom.style.width = `calc(var(--v-pt, 1.333px) * ${Math.max(0, pt).toFixed(2)})`;
    this.dom.classList.add("v-hspace");
    this.dom.classList.toggle("v-hspace-fill", kind === "hspace" && pt === null);
    this.dom.setAttribute("aria-label", len ? `Space ${len}` : "Space");
    this.dom.title = len ? `Space (${len})` : "Space";
  }
}

/** Vertical space: a blank gap of the asked height. */
class VSpaceView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-vspace"), node, view, getPos, getEnv);
    this.dom.setAttribute("role", "separator");
    this.dom.addEventListener("dblclick", (e) => {
      e.preventDefault();
      editAtom({ getEnv: this.getEnv, view: this.view, node: this.node, getPos: this.getPos, dom: this.dom }, "Edit space");
    });
    this.paint();
  }
  protected paint() {
    const len = atomLength(this.node.attrs);
    const pt = len ? lengthPt(len) : null;
    this.dom.style.setProperty("--v-gap", pt !== null ? `calc(var(--v-pt, 1.333px) * ${Math.max(0, pt).toFixed(2)})` : "2em");
    this.dom.setAttribute("aria-label", len ? `Vertical space ${len}` : "Vertical space");
    this.dom.title = len ? `Vertical space (${len})` : "Vertical space";
  }
}

/** A page break, as Word draws one: a dashed rule labelled "Page break". */
class PageBreakView extends AtomView {
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, getEnv: GetEnv) {
    super(el("div", "v-page-break"), node, view, getPos, getEnv);
    this.dom.setAttribute("role", "separator");
    this.dom.setAttribute("aria-label", "Page break");
    this.dom.append(el("span", "v-page-break-label", "Page break"));
  }
  protected paint() {}
}

/** A spacer block: a page break when its attrs say so, else vertical space. */
const spacerView: ViewFactory = (g) => (n, v, p) => {
  const kind = String(n.attrs.kind ?? n.attrs.cmd ?? n.attrs.src ?? "");
  return /page|newpage|clearpage/i.test(kind) ? new PageBreakView(n, v, p, g) : new VSpaceView(n, v, p, g);
};

/** Paragraphs aligned left, centred or right; the content stays editable. */
class AlignView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  constructor(private node: PMNode) {
    this.dom = this.contentDOM = el("div", "v-align");
    this.paint();
  }
  private paint() {
    const a = alignOf(this.node.attrs);
    this.dom.className = `v-align${a ? ` v-align-${a}` : ""}`;
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.paint();
    return true;
  }
  ignoreMutation(m: ViewMutationRecord) {
    return m.type === "attributes" && m.target === this.dom;
  }
}

/* ---------- Registration ---------- */

// The names the core may use for each piece; the first one the schema has wins.
const NODE_FACTORIES: [string[], ViewFactory][] = [
  [["spacing", "hspace", "space_inline"], (g) => (n, v, p) => new HSpaceView(n, v, p, g)],
  [["spacer_block", "vspace", "spacer", "space_block"], spacerView],
  [["page_break", "pagebreak"], (g) => (n, v, p) => new PageBreakView(n, v, p, g)],
  [["align", "alignment", "align_block"], () => (n) => new AlignView(n)],
];

const MARK_FACTORIES: [string[], MarkViewConstructor][] = [
  [["size", "font_size", "fontsize"], sizeMark],
  [["color", "text_color", "textcolor"], colorMark],
];

/** Node views for whichever layout node types `schema` has. */
export function layoutNodeViews(schema: Schema, getEnv: GetEnv): Record<string, NodeViewConstructor> {
  const out: Record<string, NodeViewConstructor> = {};
  for (const [names, factory] of NODE_FACTORIES) {
    for (const name of names) if (schema.nodes[name] && !out[name]) out[name] = factory(getEnv);
  }
  return out;
}

/**
 * Mark views for whichever layout mark types `schema` has, when the core
 * doesn't draw them itself: a mark spec with its own toDOM (class and inline
 * style) is left to it, so the page and the clipboard agree.
 */
export function layoutMarkViews(schema: Schema): Record<string, MarkViewConstructor> {
  const out: Record<string, MarkViewConstructor> = {};
  for (const [names, factory] of MARK_FACTORIES) {
    for (const name of names) if (schema.marks[name] && !schema.marks[name].spec.toDOM) out[name] = factory;
  }
  return out;
}

export { HSpaceView, VSpaceView, PageBreakView, AlignView };
