import { describe, expect, it, vi } from "vitest";
import { calledMacro, macroOutput, onTextMacros, setTextMacros } from "./macroText";

const defs = new Map([
  ["runs", "5"],
  ["acc", "$0.724 \\pm 0.009$"],
  ["alias", "\\runs"],
  ["missing", "--"],
  ["styled", "\\textbf{42}"],
  ["empty", "\\hspace{1em}"],
]);

describe("project text macros in Visual mode", () => {
  it("recognises a bare call", () => {
    expect(calledMacro("\\runs{}")).toBe("runs");
    expect(calledMacro(" \\runs ")).toBe("runs");
    expect(calledMacro("\\runs{x}")).toBeNull();
    expect(calledMacro("a \\runs")).toBeNull();
  });

  it("shows what the macro prints", () => {
    expect(macroOutput("\\runs{}", defs)).toEqual({ text: "5" });
    expect(macroOutput("\\alias", defs)).toEqual({ text: "5" });
    expect(macroOutput("\\acc{}", defs)).toEqual({ math: "0.724 \\pm 0.009" });
    expect(macroOutput("\\missing{}", defs)).toEqual({ text: "–" });
    expect(macroOutput("\\styled", defs)).toEqual({ text: "42" });
    const mixed = new Map([["epoch", "54.2 $\\pm$ 7.0"]]);
    expect(macroOutput("\\epoch{}", mixed)).toEqual({ math: "\\text{54.2 }{\\pm}\\text{ 7.0}" });
  });

  it("gives up on unknown or unreadable macros", () => {
    expect(macroOutput("\\nope{}", defs)).toBeNull();
    expect(macroOutput("\\empty", defs)).toBeNull();
    expect(macroOutput("\\a", new Map([["a", "\\b"], ["b", "\\a"]]))).toBeNull();
  });

  it("tells views when the definitions change", () => {
    const fn = vi.fn();
    const off = onTextMacros(fn);
    setTextMacros([{ name: "runs", body: "5" }]);
    setTextMacros([{ name: "runs", body: "5" }]);
    setTextMacros([{ name: "runs", body: "6" }]);
    off();
    setTextMacros([]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(macroOutput("\\runs")).toBeNull();
  });
});
