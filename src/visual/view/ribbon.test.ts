import { describe, expect, it } from "vitest";
import { createSession, cssColor, helpersFor, SIZE_COMMANDS } from "../core";
import { COLOR_MENU, fitGroups, SIZE_LABELS, SIZE_MENU } from "./ribbon";

describe("ribbon menus", () => {
  const ctx = createSession("latex", "x\n").context;
  const latex = helpersFor("latex");

  it("names every LaTeX size and offers Smaller to Huge in order", () => {
    expect(Object.keys(SIZE_LABELS).sort()).toEqual([...SIZE_COMMANDS].sort());
    expect(SIZE_MENU.map((s) => SIZE_LABELS[s])).toEqual(["Smaller", "Small", "Normal", "Large", "Larger", "Largest", "Huge"]);
    const order = SIZE_MENU.map((s) => SIZE_COMMANDS.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const s of SIZE_MENU) if (s !== "normalsize") expect(latex.sizeMark(s, ctx)).not.toBeNull();
  });

  it("offers only colours xcolor knows and the page can draw", () => {
    expect(COLOR_MENU[0]).toEqual({ name: null, label: "Automatic" });
    for (const c of COLOR_MENU.slice(1)) {
      expect(latex.colorMark(c.name!, ctx)).not.toBeNull();
      expect(cssColor(c.name!)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("folding the ribbon", () => {
  const groups = [
    { key: "style", priority: 1, width: 130 },
    { key: "size", priority: 5, width: 100 },
    { key: "marks", priority: 2, width: 100 },
    { key: "insert", priority: 3, width: 80 },
  ];

  it("shows everything when it fits, with no … menu", () => {
    const { shown, folded } = fitGroups(groups, 1000, 100);
    expect(shown.map((g) => g.key)).toEqual(["style", "size", "marks", "insert"]);
    expect(folded).toEqual([]);
  });

  it("folds the least important groups first and keeps ribbon order", () => {
    // All four need 410 > 500 - 100 reserved. With 40 for "…", 360 is left: style, marks and insert (310) fit; size doesn't.
    const { shown, folded } = fitGroups(groups, 500, 100);
    expect(shown.map((g) => g.key)).toEqual(["style", "marks", "insert"]);
    expect(folded.map((g) => g.key)).toEqual(["size"]);
  });

  it("folds everything on a very narrow pane", () => {
    const { shown, folded } = fitGroups(groups, 200, 100);
    expect(shown).toEqual([]);
    expect(folded).toHaveLength(4);
  });
});
