import { describe, expect, it } from "vitest";
import { plainCell, plainRows } from "./tableCells";

describe("table cells in Visual mode", () => {
  it("shows simple escapes as the reader sees them", () => {
    expect(plainCell("9{,}577")).toBe("9,577");
    expect(plainCell("50\\% of A \\& B")).toBe("50% of A & B");
    expect(plainCell("Fig.~3, 2--4")).toBe("Fig. 3, 2–4");
  });

  it("refuses cells that still hold code", () => {
    expect(plainCell("\\confirmatoryCalSkin")).toBeNull();
    expect(plainCell("$0.979 \\pm 0.011$")).toBeNull();
    expect(plainCell("\\textbf{Skin}")).toBeNull();
    expect(plainRows([["Skin", "9{,}577"], ["Retina", "\\macro"]])).toBeNull();
    expect(plainRows([["Skin", "9{,}577"]])).toEqual([["Skin", "9,577"]]);
  });
});
