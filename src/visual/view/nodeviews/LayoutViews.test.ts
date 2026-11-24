import { describe, expect, it, vi } from "vitest";

// RawView colours code with Monaco, which needs a browser; these helpers don't.
vi.mock("../../../editor/monaco", () => ({ monaco: {} }));

import { Schema } from "prosemirror-model";
import { schema } from "../../core";
import { alignOf, atomLength, cssColor, layoutMarkViews, layoutNodeViews, lengthPt, markColor, sizeName } from "./LayoutViews";

describe("sizes and colours", () => {
  it("reads size names", () => {
    expect(sizeName({ cmd: "\\Large" })).toBe("Large");
    expect(sizeName({ size: "tiny" })).toBe("tiny");
    expect(sizeName({ cmd: "bogus" })).toBeNull();
  });

  it("turns xcolor specs into CSS", () => {
    expect(cssColor("red")).toBe("#ff0000");
    expect(cssColor("blue!40")).toBe("color-mix(in srgb, #0000ff 40%, #ffffff)");
    expect(cssColor("red!30!blue")).toBe("color-mix(in srgb, #ff0000 30%, #0000ff)");
    expect(cssColor("FF8800", "HTML")).toBe("#ff8800");
    expect(cssColor("1,0.5,0", "rgb")).toBe("rgb(255, 128, 0)");
    expect(cssColor("0.5", "gray")).toBe("rgb(128, 128, 128)");
    expect(cssColor("notacolour")).toBeNull();
    expect(markColor({ color: "ForestGreen" })).toBe("#009b55");
  });
});

describe("lengths and alignment", () => {
  it("converts lengths to points", () => {
    expect(lengthPt("1in")).toBeCloseTo(72);
    expect(lengthPt("{2.54cm}")).toBeCloseTo(72);
    expect(lengthPt("\\baselineskip")).toBe(12);
    expect(lengthPt("\\fill")).toBeNull();
    expect(atomLength({ src: "\\vspace{1cm}" })).toBe("1cm");
    expect(atomLength({ amount: "2em", src: "\\hspace{1cm}" })).toBe("2em");
  });

  it("reads alignment", () => {
    expect(alignOf({ align: "center" })).toBe("center");
    expect(alignOf({ env: "flushright" })).toBe("right");
    expect(alignOf({ kind: "raggedright" })).toBe("left");
    expect(alignOf({})).toBeNull();
  });
});

describe("registration", () => {
  it("registers only the types the schema has", () => {
    const views = layoutNodeViews(schema, () => null);
    for (const name of Object.keys(views)) expect(schema.nodes[name]).toBeTruthy();
    const marks = layoutMarkViews(schema);
    for (const name of Object.keys(marks)) expect(schema.marks[name]).toBeTruthy();
  });

  it("picks up the new types once they exist", () => {
    const s = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        page_break: { group: "block", atom: true },
        align: { group: "block", content: "block+" },
        spacing: { group: "inline", inline: true, atom: true },
        text: { group: "inline" },
      },
      marks: { size: {}, color: {} },
    });
    expect(Object.keys(layoutNodeViews(s, () => null)).sort()).toEqual(["align", "page_break", "spacing"]);
    expect(Object.keys(layoutMarkViews(s)).sort()).toEqual(["color", "size"]);
  });
});
