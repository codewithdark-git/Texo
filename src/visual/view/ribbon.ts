// The ribbon's data and layout rules, kept free of React and the editor so
// they can be tested on their own: Word's names for LaTeX's sizes, the
// colours on offer, and which groups of tools fit in the pane's width.

import type { SizeCmd } from "../core";

/** Word-like names for LaTeX's sizes. "Normal" is the body text (no size mark). */
export const SIZE_LABELS: Record<SizeCmd, string> = {
  tiny: "Tiny",
  scriptsize: "Very small",
  footnotesize: "Smaller",
  small: "Small",
  normalsize: "Normal",
  large: "Large",
  Large: "Larger",
  LARGE: "Largest",
  huge: "Huge",
  Huge: "Giant",
};

/** The sizes the Font size menu offers, smallest first. */
export const SIZE_MENU: SizeCmd[] = ["footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge"];

/** The Text colour menu: xcolor names every TeX installation knows. null is Automatic. */
export const COLOR_MENU: { name: string | null; label: string }[] = [
  { name: null, label: "Automatic" },
  { name: "black", label: "Black" },
  { name: "red", label: "Red" },
  { name: "blue", label: "Blue" },
  { name: "teal", label: "Teal" },
  { name: "orange", label: "Orange" },
  { name: "violet", label: "Violet" },
  { name: "gray", label: "Gray" },
];

/** Which groups fit in `width` pixels: by priority, then drawn in ribbon order. */
export function fitGroups<T extends { priority: number; width: number }>(groups: T[], width: number, reserved: number, more = 40): { shown: T[]; folded: T[] } {
  const total = groups.reduce((n, g) => n + g.width, 0);
  if (total <= width - reserved) return { shown: groups, folded: [] };
  let room = width - reserved - more;
  const keep = new Set<T>();
  for (const g of [...groups].sort((a, b) => a.priority - b.priority)) {
    if (g.width > room) break;
    keep.add(g);
    room -= g.width;
  }
  return { shown: groups.filter((g) => keep.has(g)), folded: groups.filter((g) => !keep.has(g)) };
}
