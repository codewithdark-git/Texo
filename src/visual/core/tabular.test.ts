import { describe, expect, it } from "vitest";
import { tabular } from "./index";

const SIMPLE = [
  "\\begin{table}[h]",
  "  \\centering",
  "  \\begin{tabular}{|l|r|}",
  "    \\hline",
  "    Name & Value \\\\",
  "    \\hline",
  "    a & 1 \\\\",
  "    b & 2 \\\\",
  "    \\hline",
  "  \\end{tabular}",
  "  \\caption{Numbers}",
  "\\end{table}",
].join("\n");

describe("tabular", () => {
  it("parses cells, terminators and the caption", () => {
    const m = tabular.parse(SIMPLE)!;
    expect(m.colspec).toBe("|l|r|");
    expect(m.simple).toBe(true);
    expect(m.caption).toBe("Numbers");
    expect(m.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ["Name", "Value"],
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(m.rows[0].terminator).toBe("\\\\\n    \\hline\n    ");
    const c = m.rows[1].cells[1];
    expect(SIMPLE.slice(c.start, c.end)).toBe("1");
  });

  it("setCell touches only the cell span and escapes", () => {
    const out = tabular.apply(SIMPLE, { kind: "setCell", r: 1, c: 1, text: "50%" });
    expect(out).toBe(SIMPLE.replace("a & 1", "a & 50\\%"));
  });

  it("insertRow copies the neighbouring row's style", () => {
    const out = tabular.apply(SIMPLE, { kind: "insertRow", at: 2 });
    expect(out).toBe(SIMPLE.replace("    b & 2 \\\\", "     &  \\\\\n    b & 2 \\\\"));
    const end = tabular.apply(SIMPLE, { kind: "insertRow", at: 3 });
    expect(end).toBe(SIMPLE.replace("    b & 2 \\\\", "    b & 2 \\\\\n     &  \\\\"));
    expect(tabular.parse(end)!.rows).toHaveLength(4);
  });

  it("deletes a row with its line", () => {
    expect(tabular.apply(SIMPLE, { kind: "deleteRow", r: 1 })).toBe(SIMPLE.replace("    a & 1 \\\\\n", ""));
  });

  it("inserts and deletes columns, updating the spec", () => {
    const ins = tabular.apply(SIMPLE, { kind: "insertCol", at: 1 });
    const m = tabular.parse(ins)!;
    expect(m.colspec).toBe("|l|r|r|");
    expect(m.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ["Name", "", "Value"],
      ["a", "", "1"],
      ["b", "", "2"],
    ]);
    const del = tabular.apply(SIMPLE, { kind: "deleteCol", c: 0 });
    const d = tabular.parse(del)!;
    expect(d.colspec).toBe("|r|");
    expect(d.rows.map((r) => r.cells.map((c) => c.text))).toEqual([["Value"], ["1"], ["2"]]);
  });

  it("sets the caption", () => {
    expect(tabular.apply(SIMPLE, { kind: "setCaption", text: "New & improved" })).toBe(SIMPLE.replace("{Numbers}", "{New \\& improved}"));
  });

  it("classifies complex tables", () => {
    expect(tabular.parse("\\begin{tabular}{cc}\\multicolumn{2}{c}{x} \\\\ a & b \\\\\\end{tabular}")!.simple).toBe(false);
    expect(tabular.parse("\\begin{tabular}{cc}{a & b} & c \\\\\\end{tabular}")!.simple).toBe(false);
    expect(tabular.parse("\\begin{tabular}{cc}$a & b$ & c \\\\\\end{tabular}")!.simple).toBe(false);
    expect(tabular.parse("\\begin{tabular}{ll}\\toprule a & b \\\\ \\midrule c & d \\\\ \\bottomrule\\end{tabular}")!.simple).toBe(true);
    expect(tabular.parse("no table here")).toBeNull();
  });
});
