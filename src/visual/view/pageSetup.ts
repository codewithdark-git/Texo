// Page setup for Visual mode: reads the paper, margins, font and spacing a
// LaTeX preamble asks for, and writes a change back as the smallest edit to
// the preamble's own text. Only the options and \usepackage lines a setting
// owns are touched; everything else (other options, comments, spacing,
// unrelated packages) stays byte for byte as it was.
//
// Pure string functions: no DOM, no editor. The dialog and the page canvas
// both build on them.

export type PaperSize = "a4" | "letter" | "legal" | "a5" | "b5";
export type Orientation = "portrait" | "landscape";
export type FontChoice = "cm" | "lmodern" | "times" | "palatino" | "helvetica" | "charter";
export type LineSpacing = "single" | "1.15" | "1.5" | "double";
export type ParStyle = "indent" | "space";
export type MarginPreset = "default" | "normal" | "narrow" | "moderate" | "wide" | "custom";

/** Margins in centimetres. */
export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PageSetup {
  paper: PaperSize;
  orientation: Orientation;
  /** Null: the class's own margins (no geometry margins set). */
  margins: Margins | null;
  fontSize: 10 | 11 | 12;
  font: FontChoice;
  lineSpacing: LineSpacing;
  columns: 1 | 2;
  parStyle: ParStyle;
}

/** What the dialog may change for this document, with a reason when it can't. */
export interface PageSetupLimits {
  /** Paper, orientation, margins and columns are fixed by the class. */
  layout: string | null;
  /** Fonts are chosen some other way (fontspec, or a fixed class). */
  font: string | null;
}

export interface PageSetupInfo {
  settings: PageSetup;
  docClass: string | null;
  limits: PageSetupLimits;
}

export const PAPER_SIZES: Record<PaperSize, { label: string; width: number; height: number; option: string }> = {
  a4: { label: "A4", width: 21, height: 29.7, option: "a4paper" },
  letter: { label: "Letter", width: 21.59, height: 27.94, option: "letterpaper" },
  legal: { label: "Legal", width: 21.59, height: 35.56, option: "legalpaper" },
  a5: { label: "A5", width: 14.8, height: 21, option: "a5paper" },
  b5: { label: "B5", width: 17.6, height: 25, option: "b5paper" },
};

export const MARGIN_PRESETS: Record<Exclude<MarginPreset, "default" | "custom">, { label: string; margins: Margins }> = {
  normal: { label: "Normal (2.5 cm)", margins: { top: 2.5, bottom: 2.5, left: 2.5, right: 2.5 } },
  narrow: { label: "Narrow (1.27 cm)", margins: { top: 1.27, bottom: 1.27, left: 1.27, right: 1.27 } },
  moderate: { label: "Moderate (2.5 × 1.9 cm)", margins: { top: 2.5, bottom: 2.5, left: 1.9, right: 1.9 } },
  wide: { label: "Wide (2.5 × 5 cm)", margins: { top: 2.5, bottom: 2.5, left: 5, right: 5 } },
};

export const FONTS: Record<FontChoice, { label: string; css: string }> = {
  cm: { label: "Computer Modern (default)", css: 'KaTeX_Main, "Latin Modern Roman", "CMU Serif", Cambria, Georgia, serif' },
  lmodern: { label: "Latin Modern", css: '"Latin Modern Roman", KaTeX_Main, "CMU Serif", Cambria, Georgia, serif' },
  times: { label: "Times", css: '"Times New Roman", Times, "Nimbus Roman", serif' },
  palatino: { label: "Palatino", css: '"Palatino Linotype", Palatino, "Book Antiqua", "TeX Gyre Pagella", serif' },
  helvetica: { label: "Helvetica (sans serif)", css: 'Helvetica, Arial, "Nimbus Sans", "Liberation Sans", sans-serif' },
  charter: { label: "Charter", css: '"Bitstream Charter", Charter, "XCharter", Georgia, serif' },
};

export const DEFAULT_SETUP: PageSetup = {
  paper: "letter",
  orientation: "portrait",
  margins: null,
  fontSize: 10,
  font: "cm",
  lineSpacing: "single",
  columns: 1,
  parStyle: "indent",
};

// Classes that set their own page layout, as a journal or slide format requires.
const FIXED_LAYOUT = /^(IEEEtran|IEEEconf|acmart|acmsmall|sig-alternate|sigconf|llncs|svjour3?|revtex4(-[12])?|aastex\d*|mnras|aa|elsarticle|jss|beamer|powerdot|prosper|moderncv)$/;
const FIXED_FONT = /^(IEEEtran|acmart|beamer|moderncv)$/;

/* ---------- Low-level text helpers ---------- */

/** Blanks out % comments (keeping offsets) so commands inside them are ignored. */
export function maskComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, (m, pre: string) => pre + " ".repeat(m.length - pre.length));
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Index of the "]" or "}" closing the group that opens at `at`, or -1. */
function closeOf(text: string, at: number): number {
  const open = text[at];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}") {
      if (close === "}" && --depth === 0) return i;
      if (close === "]") depth--;
    } else if (c === close && depth === 0) return i;
  }
  return -1;
}

interface Item {
  /** Offsets in the whole text. */
  start: number;
  end: number;
  text: string;
  key: string;
  value: string | null;
}

/**
 * Splits a key=value option list at top-level commas. Works on the
 * comment-masked text, so a `% note` inside a multi-line list is neither
 * part of an item nor a place where commas count.
 */
function splitItems(src: string, from: number, to: number): Item[] {
  const text = maskComments(src);
  const items: Item[] = [];
  let depth = 0;
  let segStart = from;
  const push = (end: number) => {
    const raw = text.slice(segStart, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) {
      const eq = trimmed.indexOf("=");
      items.push({
        start: segStart + lead,
        end: segStart + lead + trimmed.length,
        text: trimmed,
        key: (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim(),
        value: eq === -1 ? null : trimmed.slice(eq + 1).trim(),
      });
    }
  };
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      push(i);
      segStart = i + 1;
    }
  }
  push(to);
  return items;
}

type SiteKind = "class" | "geometry-pkg" | "geometry-cmd";

/** An option list we may edit: the class options, geometry's package options or a \geometry{..}. */
interface Site {
  kind: SiteKind;
  /** The whole command, for removing it. */
  cmdStart: number;
  cmdEnd: number;
  /** Where the options' inner text is; for a package without [..], where "[" would go. */
  innerStart: number;
  innerEnd: number;
  bracketed: boolean;
  items: Item[];
}

interface PackageUse {
  cmdStart: number;
  cmdEnd: number;
  optStart: number;
  optEnd: number;
  bracketed: boolean;
  /** The {..} list. */
  listStart: number;
  listEnd: number;
  names: Item[];
  options: Item[];
}

/** Every \usepackage / \RequirePackage, in order. */
function packageUses(src: string): PackageUse[] {
  const masked = maskComments(src);
  const out: PackageUse[] = [];
  const re = /\\(?:usepackage|RequirePackage)\b\s*/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    let at = m.index + m[0].length;
    let optStart = at;
    let optEnd = at;
    let bracketed = false;
    if (masked[at] === "[") {
      const close = closeOf(masked, at);
      if (close === -1) continue;
      bracketed = true;
      optStart = at + 1;
      optEnd = close;
      at = close + 1;
      while (/\s/.test(masked[at] ?? "")) at++;
    }
    if (masked[at] !== "{") continue;
    const close = closeOf(masked, at);
    if (close === -1) continue;
    out.push({
      cmdStart: m.index,
      cmdEnd: close + 1,
      optStart,
      optEnd,
      bracketed,
      listStart: at + 1,
      listEnd: close,
      names: splitItems(src, at + 1, close),
      options: bracketed ? splitItems(src, optStart, optEnd) : [],
    });
    re.lastIndex = close + 1;
  }
  return out;
}

function findPackage(src: string, pkg: string): PackageUse | null {
  return packageUses(src).find((u) => u.names.some((n) => n.key === pkg)) ?? null;
}

export function hasPackage(src: string, pkg: string): boolean {
  return findPackage(src, pkg) !== null;
}

interface ClassUse {
  cmdStart: number;
  cmdEnd: number;
  name: string;
  /** Inner option offsets; for no [..], both at the place "[" would go. */
  optStart: number;
  optEnd: number;
  bracketed: boolean;
}

function classUse(src: string): ClassUse | null {
  const masked = maskComments(src);
  const m = /\\documentclass\b\s*/.exec(masked);
  if (!m) return null;
  let at = m.index + m[0].length;
  const site = { optStart: at, optEnd: at, bracketed: false };
  if (masked[at] === "[") {
    const close = closeOf(masked, at);
    if (close === -1) return null;
    site.optStart = at + 1;
    site.optEnd = close;
    site.bracketed = true;
    at = close + 1;
    while (/\s/.test(masked[at] ?? "")) at++;
  }
  if (masked[at] !== "{") return null;
  const close = closeOf(masked, at);
  if (close === -1) return null;
  return { cmdStart: m.index, cmdEnd: close + 1, name: src.slice(at + 1, close).trim(), ...site };
}

/** The class options, geometry package options and \geometry commands, in document order. */
function sites(src: string): Site[] {
  const out: Site[] = [];
  const cls = classUse(src);
  if (cls) {
    out.push({
      kind: "class",
      cmdStart: cls.cmdStart,
      cmdEnd: cls.cmdEnd,
      innerStart: cls.optStart,
      innerEnd: cls.optEnd,
      bracketed: cls.bracketed,
      items: cls.bracketed ? splitItems(src, cls.optStart, cls.optEnd) : [],
    });
  }
  for (const u of packageUses(src)) {
    // Options of a multi-package line belong to all its packages; only a line of its own is geometry's.
    if (u.names.length === 1 && u.names[0].key === "geometry") {
      out.push({ kind: "geometry-pkg", cmdStart: u.cmdStart, cmdEnd: u.cmdEnd, innerStart: u.optStart, innerEnd: u.optEnd, bracketed: u.bracketed, items: u.options });
    }
  }
  const masked = maskComments(src);
  const re = /\\geometry\s*(?=\{)/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const open = m.index + m[0].length;
    const close = closeOf(masked, open);
    if (close === -1) continue;
    out.push({ kind: "geometry-cmd", cmdStart: m.index, cmdEnd: close + 1, innerStart: open + 1, innerEnd: close, bracketed: true, items: splitItems(src, open + 1, close) });
  }
  return out.sort((a, b) => a.cmdStart - b.cmdStart);
}

/** Removes [start, end), and the whole line when nothing else is left on it. */
function removeSpan(src: string, start: number, end: number): string {
  const lineStart = src.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = src.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = src.length;
  const rest = src.slice(lineStart, start) + src.slice(end, lineEnd);
  if (!rest.trim()) {
    // Take the line's own line break with it (or the one before, on the last line).
    if (lineEnd < src.length) return src.slice(0, lineStart) + src.slice(lineEnd + 1);
    const prev = lineStart > 0 ? lineStart - (src[lineStart - 2] === "\r" ? 2 : 1) : 0;
    return src.slice(0, prev) + src.slice(lineEnd);
  }
  return src.slice(0, start) + src.slice(end);
}

/** The text between items in a list, to reuse when adding one ("," or ", " or ",\n  "). */
function separatorOf(src: string, items: Item[]): string {
  if (items.length < 2) return ",";
  const gap = src.slice(items[items.length - 2].end, items[items.length - 1].start);
  if (!gap.includes("%")) return gap;
  // The gap holds a comment: reuse only the comma and the next line's indent, not the comment.
  const nl = gap.lastIndexOf("\n");
  return nl === -1 ? "," : "," + eolOf(src) + gap.slice(nl + 1);
}

/** Adds items at the end of a site's list (creating the [..] when needed). */
function appendToSite(src: string, site: Site, texts: string[]): string {
  if (!texts.length) return src;
  if (site.items.length) {
    const sep = separatorOf(src, site.items);
    const last = site.items[site.items.length - 1];
    return src.slice(0, last.end) + texts.map((t) => sep + t).join("") + src.slice(last.end);
  }
  const joined = texts.join(",");
  if (site.bracketed) return src.slice(0, site.innerStart) + joined + src.slice(site.innerEnd);
  return src.slice(0, site.innerStart) + "[" + joined + "]" + src.slice(site.innerStart);
}

/** Removes one item from its site; an emptied list loses its [..] (a \geometry{} loses its line). */
function removeItem(src: string, site: Site, item: Item): string {
  const idx = site.items.indexOf(item);
  if (site.items.length === 1) {
    if (site.kind === "geometry-cmd") return removeSpan(src, site.cmdStart, site.cmdEnd);
    // The [..] goes with its last option.
    return src.slice(0, site.innerStart - 1) + src.slice(site.innerEnd + 1);
  }
  // A comment between the items belongs to its line: take only the comma and the item.
  const gapFrom = idx === 0 ? item.end : site.items[idx - 1].end;
  const gapTo = idx === 0 ? site.items[1].start : item.start;
  const gap = src.slice(gapFrom, gapTo);
  const live = maskComments(src).slice(gapFrom, gapTo);
  if (gap !== live && live.includes(",")) {
    const comma = gapFrom + live.indexOf(",");
    if (idx === 0) return src.slice(0, item.start) + src.slice(item.end, comma) + src.slice(comma + 1);
    return src.slice(0, comma) + src.slice(comma + 1, item.start) + src.slice(item.end);
  }
  if (idx === 0) return src.slice(0, item.start) + src.slice(site.items[1].start);
  return src.slice(0, site.items[idx - 1].end) + src.slice(item.end);
}

function replaceItem(src: string, item: Item, texts: string[], sep: string): string {
  return src.slice(0, item.start) + texts.join(sep) + src.slice(item.end);
}

/** Where a new preamble line goes: after the last \usepackage, else after \documentclass. */
function insertionPoint(src: string): number {
  const uses = packageUses(src);
  const after = uses.length ? uses[uses.length - 1].cmdEnd : (classUse(src)?.cmdEnd ?? 0);
  const nl = src.indexOf("\n", after);
  return nl === -1 ? src.length : nl + 1;
}

/** Inserts a whole line at `at` (a line start, or the end of the text). */
function insertLine(src: string, at: number, line: string): string {
  const eol = eolOf(src);
  if (at >= src.length && src.length && !src.endsWith("\n")) return src + eol + line;
  return src.slice(0, at) + line + eol + src.slice(at);
}

/** The offset just past the line holding `at`. */
function lineAfter(src: string, at: number): number {
  const nl = src.indexOf("\n", at);
  return nl === -1 ? src.length : nl + 1;
}

/* ---------- Packages ---------- */

/**
 * Makes sure the preamble loads `pkg` with at least `options`. Adds a
 * \usepackage line after the last one when it's missing, or merges the
 * missing options into its existing line. Returns the text unchanged when
 * nothing is needed.
 */
export function ensurePackage(src: string, pkg: string, options: string[] = []): string {
  const use = findPackage(src, pkg);
  const line = `\\usepackage${options.length ? `[${options.join(",")}]` : ""}{${pkg}}`;
  if (!use) return insertLine(src, insertionPoint(src), line);
  const have = new Set(use.options.map((o) => o.text));
  const missing = options.filter((o) => !have.has(o));
  if (!missing.length) return src;
  if (use.names.length === 1) {
    const site: Site = { kind: "geometry-pkg", cmdStart: use.cmdStart, cmdEnd: use.cmdEnd, innerStart: use.optStart, innerEnd: use.optEnd, bracketed: use.bracketed, items: use.options };
    return appendToSite(src, site, missing);
  }
  // Options on a shared line would apply to every package there: give it a line of its own.
  const without = removePackage(src, pkg);
  return insertLine(without, lineAfter(without, Math.min(use.cmdStart, without.length - 1)), line);
}

/** Drops `pkg` from the \usepackage line(s) loading it; an emptied line goes. */
export function removePackage(src: string, pkg: string): string {
  for (;;) {
    const use = findPackage(src, pkg);
    if (!use) return src;
    if (use.names.length === 1) {
      src = removeSpan(src, use.cmdStart, use.cmdEnd);
      continue;
    }
    const idx = use.names.findIndex((n) => n.key === pkg);
    const name = use.names[idx];
    src = idx === 0 ? src.slice(0, name.start) + src.slice(use.names[1].start) : src.slice(0, use.names[idx - 1].end) + src.slice(name.end);
  }
}

/* ---------- Units ---------- */

const PT_CM = 2.54 / 72.27;
const UNIT_CM: Record<string, number> = { cm: 1, mm: 0.1, in: 2.54, pt: PT_CM, bp: 2.54 / 72, pc: 12 * PT_CM, ex: 0.43 * 0.3515, em: 1 * 0.3515 };

/** "2.5cm" → 2.5; "1in" → 2.54; null when it isn't a plain length. */
export function lengthCm(value: string): number | null {
  const m = /^\{?\s*(-?\d*\.?\d+)\s*([a-z]{2})\s*\}?$/i.exec(value.trim());
  if (!m) return null;
  const f = UNIT_CM[m[2].toLowerCase()];
  return f === undefined ? null : Number(m[1]) * f;
}

/** 2.5 → "2.5cm"; 1.2700001 → "1.27cm". */
export function formatCm(cm: number): string {
  return `${Math.round(cm * 100) / 100}cm`;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

export function sameMargins(a: Margins | null, b: Margins | null): boolean {
  if (!a || !b) return a === b;
  return near(a.top, b.top) && near(a.bottom, b.bottom) && near(a.left, b.left) && near(a.right, b.right);
}

/** Which preset these margins are, for the dialog's choice. */
export function marginPreset(m: Margins | null): MarginPreset {
  if (!m) return "default";
  for (const [k, p] of Object.entries(MARGIN_PRESETS)) if (sameMargins(m, p.margins)) return k as MarginPreset;
  return "custom";
}

/* ---------- Reading ---------- */

const PAPER_BY_OPTION: Record<string, PaperSize> = Object.fromEntries(
  Object.entries(PAPER_SIZES).map(([k, v]) => [v.option, k as PaperSize]),
) as Record<string, PaperSize>;

/** The paper an option names (`a4paper`, `paper=a4paper`, `papername=a4`), if any. */
function paperOf(item: Item): PaperSize | null {
  if (item.value === null) return PAPER_BY_OPTION[item.key] ?? null;
  if (item.key === "paper" || item.key === "papername") {
    const v = item.value.replace(/[{}\s]/g, "");
    return PAPER_BY_OPTION[v] ?? PAPER_BY_OPTION[v + "paper"] ?? null;
  }
  return null;
}

const MARGIN_KEYS = new Set(["margin", "hmargin", "vmargin", "left", "right", "top", "bottom", "lmargin", "rmargin", "tmargin", "bmargin", "inner", "outer"]);

/** Applies one geometry margin key to `m`. */
function applyMarginKey(m: Partial<Margins>, item: Item) {
  const v = item.value ?? "";
  const pair = /^\{([^,{}]*),([^,{}]*)\}$/.exec(v.trim());
  const one = lengthCm(v);
  const set = (k: keyof Margins, x: number | null) => {
    if (x !== null) m[k] = x;
  };
  switch (item.key) {
    case "margin":
      if (pair) {
        // margin={h,v}
        set("left", lengthCm(pair[1]));
        set("right", lengthCm(pair[1]));
        set("top", lengthCm(pair[2]));
        set("bottom", lengthCm(pair[2]));
      } else for (const k of ["top", "bottom", "left", "right"] as const) set(k, one);
      break;
    case "hmargin":
      set("left", pair ? lengthCm(pair[1]) : one);
      set("right", pair ? lengthCm(pair[2]) : one);
      break;
    case "vmargin":
      set("top", pair ? lengthCm(pair[1]) : one);
      set("bottom", pair ? lengthCm(pair[2]) : one);
      break;
    case "left":
    case "lmargin":
    case "inner":
      set("left", one);
      break;
    case "right":
    case "rmargin":
    case "outer":
      set("right", one);
      break;
    case "top":
    case "tmargin":
      set("top", one);
      break;
    case "bottom":
    case "bmargin":
      set("bottom", one);
      break;
  }
}

/** The class's own margins (no geometry), roughly: what the page canvas draws. */
export function classMargins(setup: Pick<PageSetup, "paper" | "orientation" | "fontSize" | "columns">): Margins {
  const p = paperDims(setup.paper, setup.orientation);
  // LaTeX's standard classes: \textwidth 345/360/390pt for 10/11/12pt, wider in two columns.
  const textPt = setup.columns === 2 ? 469 : { 10: 345, 11: 360, 12: 390 }[setup.fontSize];
  const text = Math.min(p.width * 0.8, textPt * PT_CM);
  const side = (p.width - text) / 2;
  return { top: 3.5, bottom: 3.5, left: side, right: side };
}

export function paperDims(paper: PaperSize, orientation: Orientation): { width: number; height: number } {
  const { width, height } = PAPER_SIZES[paper];
  return orientation === "landscape" ? { width: height, height: width } : { width, height };
}

const FONT_PACKAGES: Record<string, FontChoice> = {
  lmodern: "lmodern",
  mathptmx: "times",
  times: "times",
  newtxtext: "times",
  newtxmath: "times",
  tgtermes: "times",
  mathpazo: "palatino",
  palatino: "palatino",
  newpxtext: "palatino",
  newpxmath: "palatino",
  tgpagella: "palatino",
  helvet: "helvetica",
  tgheros: "helvetica",
  charter: "charter",
  XCharter: "charter",
};

const SANS_DEFAULT = /\\renewcommand\s*\{?\s*\\familydefault\s*\}?\s*\{?\s*\\sfdefault\s*\}?/;

const SPACING_CMD = /\\(singlespacing|onehalfspacing|doublespacing)\b|\\(setstretch|linespread)\s*\{\s*([\d.]+)\s*\}/g;

/**
 * Spacing commands that apply to the whole document: those at brace depth 0
 * of the preamble. One inside a macro body (`\newcommand{\draft}{\doublespacing}`)
 * only runs when that macro does, so it's neither read nor removed.
 */
function topLevelSpacing(masked: string): RegExpExecArray[] {
  const depthAt: number[] = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    depthAt[i] = depth;
    const c = masked[i];
    if (c === "\\") {
      depthAt[++i] = depth;
    } else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
  }
  const re = new RegExp(SPACING_CMD.source, "g");
  const out: RegExpExecArray[] = [];
  for (let m = re.exec(masked); m; m = re.exec(masked)) if (!depthAt[m.index]) out.push(m);
  return out;
}

// Font packages the dialog doesn't offer. With one loaded, the Font control
// is disabled rather than adding a second font package that fights it.
const OTHER_FONT_PACKAGES = new Set([
  "libertine", "libertinus", "libertinust1math", "fourier", "kpfonts", "mathpple", "ebgaramond", "garamondx", "cochineal",
  "baskervald", "baskervillef", "librebaskerville", "crimson", "crimsonpro", "utopia", "erewhon", "bookman", "newcent",
  "avant", "mathdesign", "tgbonum", "tgschola", "tgadventor", "tgcursor", "tgchorus", "gentium", "sourceserifpro",
  "sourcesanspro", "sourcecodepro", "FiraSans", "roboto", "opensans", "lato", "plex-serif", "plex-sans", "mlmodern",
  "cmbright", "arev", "bera", "beraserif", "DejaVuSerif", "DejaVuSans", "stix", "stix2", "newtx", "notomath", "noto",
  "alegreya", "mathpple", "eulervm", "concrete", "ccfonts", "fouriernc", "quattrocento", "merriweather", "ETbb",
]);

/** KOMA-Script classes default to 11pt and take `fontsize=..`; the standard classes default to 10pt. */
const isKoma = (docClass: string | null) => !!docClass && /^scr/.test(docClass);

function defaultSize(docClass: string | null): 10 | 11 | 12 {
  return isKoma(docClass) ? 11 : 10;
}

/** The font size a class option sets: `11pt`, or KOMA's `fontsize=11pt`. */
function sizeOf(item: Item): 10 | 11 | 12 | null {
  const plain = /^(10|11|12)pt$/.exec(item.text);
  if (plain) return Number(plain[1]) as 10 | 11 | 12;
  if (item.key === "fontsize" && item.value !== null) {
    const koma = /^\{?\s*(10|11|12)(?:pt)?\s*\}?$/.exec(item.value);
    if (koma) return Number(koma[1]) as 10 | 11 | 12;
  }
  return null;
}

/** A custom margin the user typed, in cm; null while it's empty, partial or out of range. */
export function parseMarginCm(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const cm = Number(t);
  return Number.isFinite(cm) && cm >= 0 && cm <= 15 ? cm : null;
}

function spacingFrom(cmd: string | undefined, fn: string | undefined, value: string | undefined): LineSpacing {
  if (cmd === "onehalfspacing") return "1.5";
  if (cmd === "doublespacing") return "double";
  if (cmd === "singlespacing") return "single";
  const x = Number(value);
  // \linespread scales the font's own baseline; setspace's \onehalfspacing is about \linespread{1.25}.
  const v = fn === "linespread" ? x * (x >= 1.5 ? 1.25 : 1.2) : x;
  if (v >= 1.75) return "double";
  if (v >= 1.35) return "1.5";
  if (v >= 1.08) return "1.15";
  return "single";
}

/** Reads the page setup a preamble asks for. */
export function readPageSetup(src: string): PageSetupInfo {
  const settings: PageSetup = { ...DEFAULT_SETUP };
  const masked = maskComments(src);
  const cls = classUse(src);
  const docClass = cls?.name ?? null;
  if (docClass && /^(scr|beamer)/.test(docClass)) settings.paper = "a4";
  if (docClass === "beamer") settings.orientation = "landscape";
  settings.fontSize = defaultSize(docClass);

  let margins: Partial<Margins> | null = null;
  for (const site of sites(src)) {
    for (const item of site.items) {
      const paper = paperOf(item);
      if (paper) settings.paper = paper;
      else if (item.text === "landscape") settings.orientation = "landscape";
      else if (item.text === "portrait") settings.orientation = "portrait";
      else if (site.kind === "class") {
        const pt = sizeOf(item);
        if (pt) settings.fontSize = pt;
        if (item.text === "twocolumn") settings.columns = 2;
        if (item.text === "onecolumn") settings.columns = 1;
      } else if (MARGIN_KEYS.has(item.key) && item.value !== null) {
        margins ??= {};
        applyMarginKey(margins, item);
      }
    }
  }
  if (margins) {
    const fallback = classMargins(settings);
    settings.margins = { ...fallback, ...margins };
  }

  const pkgs = new Set(packageUses(src).flatMap((u) => u.names.map((n) => n.key)));
  for (const [pkg, font] of Object.entries(FONT_PACKAGES)) if (pkgs.has(pkg)) settings.font = font;
  if (SANS_DEFAULT.test(masked) && (settings.font === "cm" || settings.font === "lmodern")) settings.font = "helvetica";

  const setspace = findPackage(src, "setspace");
  for (const o of setspace?.options ?? []) {
    if (/^(singlespacing|onehalfspacing|doublespacing)$/.test(o.text)) settings.lineSpacing = spacingFrom(o.text, undefined, undefined);
  }
  for (const m of topLevelSpacing(masked)) settings.lineSpacing = spacingFrom(m[1], m[2], m[3]);

  if (pkgs.has("parskip") || /\\setlength\s*\{?\s*\\parindent\s*\}?\s*\{\s*0\s*(pt|em|cm|mm|in)?\s*\}/.test(masked)) settings.parStyle = "space";

  // A font package the dialog can't offer: choosing one of ours would load a second, clashing font.
  const otherFont = [...pkgs].find((p) => OTHER_FONT_PACKAGES.has(p));
  const fixed = docClass && FIXED_LAYOUT.test(docClass);
  const limits: PageSetupLimits = {
    layout: fixed ? `The ${docClass} class sets its own paper, margins and columns, as its publisher requires.` : null,
    font:
      docClass && FIXED_FONT.test(docClass)
        ? `The ${docClass} class chooses its own fonts.`
        : pkgs.has("fontspec") || pkgs.has("unicode-math")
          ? "This document picks its fonts with fontspec; change them in the preamble."
          : otherFont
            ? `This document picks its fonts with the ${otherFont} package; change them in the preamble.`
            : null,
  };
  return { settings, docClass, limits };
}

/* ---------- Writing ---------- */

function marginItems(m: Margins): string[] {
  if (near(m.top, m.bottom) && near(m.left, m.right) && near(m.top, m.left)) return [`margin=${formatCm(m.top)}`];
  return [`top=${formatCm(m.top)}`, `bottom=${formatCm(m.bottom)}`, `left=${formatCm(m.left)}`, `right=${formatCm(m.right)}`];
}

/** Every item matching `test`, across sites of the given kinds, as [siteIndex, item] in document order. */
function occurrences(src: string, test: (item: Item, site: Site) => boolean): { site: Site; item: Item }[] {
  const out: { site: Site; item: Item }[] = [];
  for (const site of sites(src)) for (const item of site.items) if (test(item, site)) out.push({ site, item });
  return out;
}

/** Removes every matching item, one at a time (offsets change after each). */
function removeAll(src: string, test: (item: Item, site: Site) => boolean, skip?: { start: number }): string {
  for (;;) {
    const hit = occurrences(src, test).filter((o) => o.item.start !== skip?.start).pop();
    if (!hit) return src;
    src = removeItem(src, hit.site, hit.item);
  }
}

/**
 * Replaces the last (effective) matching item with `texts` and removes the
 * other matches. Returns null when nothing matched.
 */
function replaceEffective(src: string, test: (item: Item, site: Site) => boolean, texts: string[]): string | null {
  const count = occurrences(src, test).length;
  if (!count) return null;
  // Remove the earlier ones from the back, so the indexes of those still to go don't shift.
  let out = src;
  for (let i = count - 2; i >= 0; i--) {
    const now = occurrences(out, test);
    out = removeItem(out, now[i].site, now[i].item);
  }
  const last = occurrences(out, test).pop()!;
  return replaceItem(out, last.item, texts, separatorOf(out, last.site.items));
}

/** Adds options to geometry: the last \geometry{..}, else geometry's own line, else a new line. */
function addGeometryOptions(src: string, texts: string[]): string {
  const geo = sites(src).filter((s) => s.kind !== "class");
  const cmd = geo.filter((s) => s.kind === "geometry-cmd").pop();
  if (cmd) return appendToSite(src, cmd, texts);
  const pkg = geo.find((s) => s.kind === "geometry-pkg");
  if (pkg) return appendToSite(src, pkg, texts);
  const shared = findPackage(src, "geometry");
  if (shared) return insertLine(src, lineAfter(src, shared.cmdEnd), `\\geometry{${texts.join(",")}}`);
  return insertLine(src, insertionPoint(src), `\\usepackage[${texts.join(",")}]{geometry}`);
}

/** Removes geometry when it's left with nothing to do (no options, no \geometry{..}). */
function dropIdleGeometry(src: string): string {
  const all = sites(src).filter((s) => s.kind !== "class");
  if (all.length === 1 && all[0].kind === "geometry-pkg" && all[0].items.length === 0) return removeSpan(src, all[0].cmdStart, all[0].cmdEnd);
  return src;
}

function setClassOption(src: string, test: (t: string) => boolean, text: string | null): string {
  const cls = sites(src).find((s) => s.kind === "class");
  if (!cls) return src;
  const hits = cls.items.filter((i) => test(i.text));
  if (text === null) return removeAll(src, (i, s) => s.kind === "class" && test(i.text));
  if (!hits.length) return appendToSite(src, cls, [text]);
  const out = replaceEffective(src, (i, s) => s.kind === "class" && test(i.text), [text]);
  return out ?? src;
}

function writePaper(src: string, paper: PaperSize): string {
  const option = PAPER_SIZES[paper].option;
  const isPaper = (i: Item) => paperOf(i) !== null;
  const hits = occurrences(src, isPaper);
  if (!hits.length) {
    if (sites(src).some((s) => s.kind === "class")) return setClassOption(src, () => false, option);
    return addGeometryOptions(src, [option]);
  }
  const last = hits[hits.length - 1].item;
  const text = last.value === null ? option : `${last.key}=${last.key === "papername" ? option.replace(/paper$/, "") : option}`;
  return replaceEffective(src, isPaper, [text]) ?? src;
}

function writeOrientation(src: string, o: Orientation): string {
  const isOrient = (i: Item) => i.text === "landscape" || i.text === "portrait";
  if (o === "portrait") {
    const out = removeAll(src, isOrient);
    return dropIdleGeometry(out);
  }
  // Landscape through geometry, which also sets the PDF's page size.
  const out = removeAll(src, (i, s) => isOrient(i) && s.kind === "class");
  if (occurrences(out, (i, s) => s.kind !== "class" && i.text === "landscape").length) return removeAll(out, (i, s) => s.kind !== "class" && i.text === "portrait");
  return addGeometryOptions(removeAll(out, (i, s) => s.kind !== "class" && i.text === "portrait"), ["landscape"]);
}

function writeMargins(src: string, m: Margins | null): string {
  const isMargin = (i: Item, s: Site) => s.kind !== "class" && MARGIN_KEYS.has(i.key) && i.value !== null;
  if (!m) return dropIdleGeometry(removeAll(src, isMargin));
  const items = marginItems(m);
  const replaced = replaceEffective(src, isMargin, items) ?? addGeometryOptions(src, items);
  // Four margins fix the text block; a text size left beside them would
  // over-specify the page and geometry would drop part of the user's choice.
  return removeAll(replaced, (i, s) => s.kind !== "class" && TEXT_SIZE_KEYS.has(i.key));
}

// geometry keys that set the text block's size (or split the page) directly.
const TEXT_SIZE_KEYS = new Set(["textwidth", "width", "hscale", "textheight", "height", "vscale", "scale", "total", "body", "text", "hdivide", "vdivide", "divide"]);

function writeFontSize(src: string, size: 10 | 11 | 12): string {
  const cls = sites(src).find((s) => s.kind === "class");
  if (!cls) return src;
  const docClass = classUse(src)?.name ?? null;
  const sizes = cls.items.filter((i) => sizeOf(i) !== null);
  // The class's default size is only spelled out when replacing another size.
  if (size === defaultSize(docClass) && !sizes.length) return src;
  // KOMA-Script wants fontsize=..; keep whichever form the document already uses.
  const last = sizes[sizes.length - 1];
  const koma = last ? last.key === "fontsize" : isKoma(docClass);
  const texts = new Set(sizes.map((i) => i.text));
  return setClassOption(src, (t) => texts.has(t), koma ? `fontsize=${size}pt` : `${size}pt`);
}

function writeColumns(src: string, columns: 1 | 2): string {
  const isCols = (t: string) => t === "twocolumn" || t === "onecolumn";
  return setClassOption(src, isCols, columns === 2 ? "twocolumn" : null);
}

const FONT_LINES: Record<Exclude<FontChoice, "cm">, { pkg: string; options?: string[] }> = {
  lmodern: { pkg: "lmodern" },
  times: { pkg: "mathptmx" },
  palatino: { pkg: "mathpazo" },
  helvetica: { pkg: "helvet", options: ["scaled"] },
  charter: { pkg: "charter" },
};

function writeFont(src: string, font: FontChoice): string {
  let out = src;
  for (const pkg of Object.keys(FONT_PACKAGES)) {
    if (font !== "cm" && pkg === FONT_LINES[font].pkg) continue;
    out = removePackage(out, pkg);
  }
  const sans = SANS_DEFAULT.exec(maskComments(out));
  if (font !== "helvetica" && sans) out = removeSpan(out, sans.index, sans.index + sans[0].length);
  if (font === "cm") return out;
  const want = FONT_LINES[font];
  if (!hasPackage(out, want.pkg)) out = ensurePackage(out, want.pkg, want.options);
  if (font === "helvetica" && !SANS_DEFAULT.test(maskComments(out))) {
    const use = findPackage(out, "helvet")!;
    out = insertLine(out, lineAfter(out, use.cmdEnd), "\\renewcommand{\\familydefault}{\\sfdefault}");
  }
  return out;
}

const SPACING_LINE: Record<Exclude<LineSpacing, "single">, string> = {
  "1.15": "\\setstretch{1.15}",
  "1.5": "\\onehalfspacing",
  double: "\\doublespacing",
};

function writeSpacing(src: string, spacing: LineSpacing): string {
  let out = src;
  // Drop every spacing command and setspace's spacing options; the new one is written once.
  for (;;) {
    const m = topLevelSpacing(maskComments(out))[0];
    if (!m) break;
    out = removeSpan(out, m.index, m.index + m[0].length);
  }
  for (;;) {
    const use = findPackage(out, "setspace");
    const opt = use?.options.find((o) => /^(singlespacing|onehalfspacing|doublespacing)$/.test(o.text));
    if (!use || !opt) break;
    const site: Site = { kind: "geometry-pkg", cmdStart: use.cmdStart, cmdEnd: use.cmdEnd, innerStart: use.optStart, innerEnd: use.optEnd, bracketed: use.bracketed, items: use.options };
    out = removeItem(out, site, opt);
  }
  if (spacing === "single") return out;
  out = ensurePackage(out, "setspace");
  const use = findPackage(out, "setspace")!;
  return insertLine(out, lineAfter(out, use.cmdEnd), SPACING_LINE[spacing]);
}

const PARINDENT_ZERO = /\\setlength\s*\{?\s*\\parindent\s*\}?\s*\{\s*0\s*(pt|em|cm|mm|in)?\s*\}/;

function writeParStyle(src: string, style: ParStyle): string {
  if (style === "space") return ensurePackage(src, "parskip");
  let out = removePackage(src, "parskip");
  const m = PARINDENT_ZERO.exec(maskComments(out));
  if (m) out = removeSpan(out, m.index, m.index + m[0].length);
  return out;
}

/**
 * The preamble with `next` applied. Only settings that differ from what the
 * preamble already says are written, so applying the current settings is a
 * no-op and each change touches just its own options and lines.
 */
export function writePageSetup(src: string, next: PageSetup): string {
  const info = readPageSetup(src);
  const cur = info.settings;
  let out = src;
  if (!info.limits.layout) {
    if (next.paper !== cur.paper) out = writePaper(out, next.paper);
    if (next.orientation !== cur.orientation) out = writeOrientation(out, next.orientation);
    if (!sameMargins(next.margins, cur.margins)) out = writeMargins(out, next.margins);
    if (next.columns !== cur.columns) out = writeColumns(out, next.columns);
  }
  if (next.fontSize !== cur.fontSize) out = writeFontSize(out, next.fontSize);
  if (!info.limits.font && next.font !== cur.font) out = writeFont(out, next.font);
  if (next.lineSpacing !== cur.lineSpacing) out = writeSpacing(out, next.lineSpacing);
  if (next.parStyle !== cur.parStyle) out = writeParStyle(out, next.parStyle);
  return out;
}

/** The page the canvas draws: paper size and margins in cm, falling back to the class's own. */
export function pageGeometry(setup: PageSetup): { width: number; height: number; margins: Margins } {
  const dims = paperDims(setup.paper, setup.orientation);
  return { ...dims, margins: setup.margins ?? classMargins(setup) };
}

// Line heights for the page's line spacing (LaTeX's own baseline is 1.2 at 10pt).
const LINE_HEIGHTS: Record<PageSetup["lineSpacing"], number> = { single: 1.3, "1.15": 1.5, "1.5": 1.9, double: 2.5 };
const PX_PER_CM = 96 / 2.54;
// The page keeps a little grey canvas around it, like a word processor.
const GUTTER = 48;

/**
 * The page's size, margins and type as CSS variables: the paper at its real
 * size (times the editor zoom), scaled down to fit the pane when needed.
 */
export function pageStyle(setup: PageSetup, paneWidth: number, zoom: number): Record<string, string> {
  const g = pageGeometry(setup);
  const full = g.width * PX_PER_CM * zoom;
  const fit = Math.min(1, Math.max(0.3, (paneWidth - GUTTER) / full));
  const cm = PX_PER_CM * zoom * fit;
  const px = (n: number) => `${Math.round(n * 10) / 10}px`;
  // Type shrinks with the page, but not below what stays readable.
  const fontPx = setup.fontSize * (96 / 72.27) * zoom * Math.max(fit, 0.8);
  return {
    "--v-page-width": px(g.width * cm),
    "--v-page-min-height": px(g.height * cm),
    "--v-pad-top": px(Math.min(g.margins.top, 3.5) * cm),
    "--v-pad-bottom": px(Math.min(g.margins.bottom, 3.5) * cm),
    "--v-pad-left": px(g.margins.left * cm),
    "--v-pad-right": px(g.margins.right * cm),
    "--v-doc-font-size": px(fontPx),
    "--v-line-height": String(LINE_HEIGHTS[setup.lineSpacing]),
    "--v-doc-font": FONTS[setup.font].css,
    // One PDF point in pixels, for pictures taken from the PDF.
    "--v-pt": px((96 / 72) * zoom * fit),
  };
}
