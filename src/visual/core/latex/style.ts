// Page-look vocabulary shared by the LaTeX parser, the schema's DOM output and
// the Visual UI: font size commands, colour names, and the spacing and break
// commands with the CSS each one stands for. Pure data and small functions, so
// the view can render a real gap or size without knowing any LaTeX.

/** The standard LaTeX size switches, smallest first. */
export const SIZE_COMMANDS = [
  "tiny",
  "scriptsize",
  "footnotesize",
  "small",
  "normalsize",
  "large",
  "Large",
  "LARGE",
  "huge",
  "Huge",
] as const;

export type SizeCmd = (typeof SIZE_COMMANDS)[number];

/** Each size relative to \normalsize (the 10pt article class, rounded), in em. */
export const SIZE_SCALE: Record<string, number> = {
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

export function isSizeCmd(name: string): name is SizeCmd {
  return Object.prototype.hasOwnProperty.call(SIZE_SCALE, name);
}

/** xcolor's base colour names and the dvipsnames people use most, as CSS. */
const NAMED_COLORS: Record<string, string> = {
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
  Gray: "#949698",
};

/** A safe colour name as written in \textcolor{..} / \color{..}: letters, digits and xcolor's ! mixing. */
export const COLOR_NAME = /^[A-Za-z][A-Za-z0-9]*(?:![0-9]{1,3}(?:![A-Za-z][A-Za-z0-9]*)?)*$/;

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function rgbHex(r: number, g: number, b: number): string {
  return "#" + hex2(r) + hex2(g) + hex2(b);
}

function parseHex(css: string): [number, number, number] {
  return [parseInt(css.slice(1, 3), 16), parseInt(css.slice(3, 5), 16), parseInt(css.slice(5, 7), 16)];
}

/** "red!30" (30% red, rest white) and "red!30!blue": xcolor's mixing syntax. */
function mixed(spec: string): string | null {
  const parts = spec.split("!");
  let base = NAMED_COLORS[parts[0]];
  if (!base) return null;
  for (let i = 1; i < parts.length; i += 2) {
    const pct = Number(parts[i]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
    const other = parts[i + 1] === undefined ? "#ffffff" : NAMED_COLORS[parts[i + 1]];
    if (!other) return null;
    const a = parseHex(base);
    const b = parseHex(other);
    const t = pct / 100;
    base = rgbHex(a[0] * t + b[0] * (1 - t), a[1] * t + b[1] * (1 - t), a[2] * t + b[2] * (1 - t));
  }
  return base;
}

/**
 * The CSS colour for a LaTeX colour, or null when it is unknown (a colour the
 * document defines itself). Only ever returns "#rrggbb", so it is safe to put
 * in a style attribute whatever the document says.
 */
export function cssColor(spec: string, model = ""): string | null {
  const s = spec.trim();
  if (model === "") return COLOR_NAME.test(s) ? mixed(s) : null;
  if (model === "HTML") return /^[0-9A-Fa-f]{6}$/.test(s) ? "#" + s.toLowerCase() : null;
  const nums = s.split(",").map((x) => Number(x.trim()));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  switch (model) {
    case "rgb":
      return nums.length === 3 && nums.every((n) => n >= 0 && n <= 1) ? rgbHex(nums[0] * 255, nums[1] * 255, nums[2] * 255) : null;
    case "RGB":
      return nums.length === 3 && nums.every((n) => n >= 0 && n <= 255) ? rgbHex(nums[0], nums[1], nums[2]) : null;
    case "gray":
      return nums.length === 1 && nums[0] >= 0 && nums[0] <= 1 ? rgbHex(nums[0] * 255, nums[0] * 255, nums[0] * 255) : null;
    default:
      return null;
  }
}

/** Lengths LaTeX users write by name, as CSS. */
const NAMED_LENGTHS: Record<string, string> = {
  smallskipamount: "3pt",
  medskipamount: "6pt",
  bigskipamount: "12pt",
  baselineskip: "1.2em",
  fill: "fill",
  stretch: "fill",
};

/**
 * A CSS length for a TeX dimension: "6pt", "-0.5em", "2\baselineskip" or a
 * named skip. Returns "" when the argument is anything else (an expression or
 * a macro the document defines), so the view falls back to a default gap.
 */
export function cssLength(arg: string): string {
  const s = arg.trim();
  const dim = /^(-?(?:\d+\.?\d*|\.\d+))\s*(pt|em|ex|mm|cm|in|bp|px|pc)$/.exec(s);
  if (dim) {
    const n = Number(dim[1]);
    // CSS points are 1/72 in, the size of a TeX big point; a TeX point is a hair smaller.
    if (dim[2] === "bp") return `${n}pt`;
    if (dim[2] === "pc") return `${n * 12}pt`;
    return `${n}${dim[2]}`;
  }
  const named = /^(-?(?:\d+\.?\d*|\.\d+))?\s*\\([A-Za-z]+)(?:\{[^{}]*\})?$/.exec(s);
  if (named && NAMED_LENGTHS[named[2]] !== undefined) {
    const base = NAMED_LENGTHS[named[2]];
    if (named[1] === undefined || base === "fill") return base;
    const m = /^(-?[\d.]+)([a-z]+)$/.exec(base)!;
    return `${Math.round(Number(named[1]) * Number(m[1]) * 1000) / 1000}${m[2]}`;
  }
  return "";
}

export type SpacingKind = "hspace" | "vspace" | "noindent" | "break" | "pagebreak" | "thin";

/**
 * Spacing and break commands. `arg`: "brace" takes one {length} argument,
 * "opt" an optional [n] (\linebreak[3]), "none" nothing. `amount` is the CSS
 * length the command stands for when it has no argument.
 */
export const SPACING_WORDS: Record<string, { kind: SpacingKind; arg: "brace" | "opt" | "none"; amount: string }> = {
  hspace: { kind: "hspace", arg: "brace", amount: "" },
  "hspace*": { kind: "hspace", arg: "brace", amount: "" },
  vspace: { kind: "vspace", arg: "brace", amount: "" },
  "vspace*": { kind: "vspace", arg: "brace", amount: "" },
  quad: { kind: "hspace", arg: "none", amount: "1em" },
  qquad: { kind: "hspace", arg: "none", amount: "2em" },
  enspace: { kind: "hspace", arg: "none", amount: "0.5em" },
  enskip: { kind: "hspace", arg: "none", amount: "0.5em" },
  hfill: { kind: "hspace", arg: "none", amount: "fill" },
  hfil: { kind: "hspace", arg: "none", amount: "fill" },
  thinspace: { kind: "thin", arg: "none", amount: "0.1667em" },
  noindent: { kind: "noindent", arg: "none", amount: "" },
  smallskip: { kind: "vspace", arg: "none", amount: "3pt" },
  medskip: { kind: "vspace", arg: "none", amount: "6pt" },
  bigskip: { kind: "vspace", arg: "none", amount: "12pt" },
  vfill: { kind: "vspace", arg: "none", amount: "fill" },
  par: { kind: "break", arg: "none", amount: "" },
  newline: { kind: "break", arg: "none", amount: "" },
  linebreak: { kind: "break", arg: "opt", amount: "" },
  newpage: { kind: "pagebreak", arg: "none", amount: "" },
  clearpage: { kind: "pagebreak", arg: "none", amount: "" },
  cleardoublepage: { kind: "pagebreak", arg: "none", amount: "" },
  pagebreak: { kind: "pagebreak", arg: "opt", amount: "" },
};

/** Commands that, alone on their line, are a block of their own: a gap or a page break. */
export const SPACER_BLOCKS: Record<string, "vspace" | "pagebreak"> = {
  vspace: "vspace",
  "vspace*": "vspace",
  smallskip: "vspace",
  medskip: "vspace",
  bigskip: "vspace",
  vfill: "vspace",
  newpage: "pagebreak",
  clearpage: "pagebreak",
  cleardoublepage: "pagebreak",
  pagebreak: "pagebreak",
};

/**
 * The CSS amount for a spacing command's source, e.g. "\vspace{6pt}" -> "6pt",
 * "\bigskip" -> "12pt", "\\[2pt]" -> "2pt". "" when it has no fixed size.
 */
export function spacingAmount(src: string): string {
  const s = src.replace(/%.*$/s, "").trim();
  if (s.startsWith("\\\\")) {
    const m = /^\\\\\*?\s*\[([^\]]*)\]/.exec(s);
    return m ? cssLength(m[1]) : "";
  }
  const w = /^\\([A-Za-z]+\*?)/.exec(s);
  if (!w) return "";
  const spec = SPACING_WORDS[w[1]];
  if (!spec) return "";
  if (spec.arg !== "brace") return spec.amount;
  const a = /^\{(.*)\}$/s.exec(s.slice(w[0].length).trim());
  return a ? cssLength(a[1]) : "";
}
