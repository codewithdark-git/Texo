import { describe, expect, it } from "vitest";
import type { Template } from "./api";
import { CATEGORIES, TEMPLATES, isTemplate, templateInfo } from "./templates";

// Every member of the Template union, and nothing else: adding or removing a
// template in api.ts without updating this object is a type error.
const ALL: Record<Template, true> = {
  blank: true,
  example: true,
  conference: true,
  report: true,
  thesis: true,
  lecture: true,
  homework: true,
  presentation: true,
  letter: true,
  cv: true,
};

describe("TEMPLATES", () => {
  it("lists every template exactly once, in gallery order", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(ALL).sort());
    expect(ids).toEqual([
      "blank",
      "example",
      "conference",
      "report",
      "thesis",
      "lecture",
      "homework",
      "presentation",
      "letter",
      "cv",
    ]);
  });

  it("gives every template a category, description, name and features", () => {
    for (const t of TEMPLATES) {
      expect(CATEGORIES, t.id).toContain(t.category);
      expect(t.title.trim(), t.id).not.toBe("");
      expect(t.description.trim(), t.id).not.toBe("");
      expect(t.name.trim(), t.id).not.toBe("");
      expect(t.features.length, t.id).toBeGreaterThan(0);
      expect(t.thumb, t.id).toBeTruthy();
    }
  });

  it("keeps each category's templates together", () => {
    const order = TEMPLATES.map((t) => CATEGORIES.indexOf(t.category));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const c of CATEGORIES) expect(TEMPLATES.some((t) => t.category === c), c).toBe(true);
  });

  it("looks templates up by id", () => {
    expect(templateInfo("cv").title).toBe("CV");
    expect(isTemplate("thesis")).toBe(true);
    expect(isTemplate("nope")).toBe(false);
    expect(isTemplate(null)).toBe(false);
  });
});
