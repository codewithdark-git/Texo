import { describe, expect, it } from "vitest";
import { crossesBlankLine, findMathAt, scanStartLine } from "./mathHover";

/** findMathAt at the position of `|` in `marked` (the bar is removed). */
function at(marked: string) {
  const offset = marked.indexOf("|");
  return findMathAt(marked.slice(0, offset) + marked.slice(offset + 1), offset);
}

describe("findMathAt", () => {
  it("finds inline $..$ and \\(..\\)", () => {
    expect(at("Let $x^|2$ be")).toMatchObject({ body: "x^2", display: false, start: 4, end: 9 });
    expect(at("Let \\(a|+b\\) be")).toMatchObject({ body: "a+b", display: false });
  });

  it("finds display maths across lines", () => {
    expect(at("Text\n\\[\n  E = |mc^2\n\\]\nMore")).toMatchObject({ body: "\n  E = mc^2\n", display: true });
    expect(at("$$a|$$")).toMatchObject({ body: "a", display: true });
    expect(at("\\begin{align}\n  a &= |b \\\\\n  c &= d\n\\end{align}")).toMatchObject({ display: true, env: "align" });
  });

  it("respects escaped dollars and comments", () => {
    expect(at("It costs \\$5 and |\\$6.")).toBeNull();
    expect(at("Price \\$5, $x|$ here")).toMatchObject({ body: "x" });
    expect(at("% $not| maths$\nText")).toBeNull();
  });

  it("returns null outside maths and doesn't run inline maths over a blank line", () => {
    expect(at("Plain |text $x$")).toBeNull();
    expect(at("$x$ and |y")).toBeNull();
    expect(at("A $ dangling\n\nnext |$ par")).toBeNull();
  });

  it("ignores non-maths environments", () => {
    expect(at("\\begin{itemize}\n\\item |a\n\\end{itemize}")).toBeNull();
  });
});

describe("hover scan window", () => {
  // Line 39 opens $$, line 41 closes it, prose follows, and line 101 has $$ y $$.
  const lines: string[] = [];
  for (let n = 1; n <= 110; n++) lines.push(n === 39 || n === 41 ? "$$" : n === 40 ? "x^2" : n === 101 ? "$$ y $$" : n === 20 ? "" : `prose ${n}`);
  const lineAt = (n: number) => lines[n - 1];

  it("starts at a blank line, never inside a display formula", () => {
    const first = scanStartLine(100, lineAt);
    expect(first).toBe(20);
    const text = lines.slice(first - 1).join("\n");
    const offset = text.indexOf("prose 100") + 2;
    expect(findMathAt(text, offset)).toBeNull();
  });

  it("drops a span that runs over a blank line", () => {
    expect(crossesBlankLine("a\n\nb")).toBe(true);
    expect(crossesBlankLine("a\r\n \r\nb")).toBe(true);
    expect(crossesBlankLine("\n  E = mc^2\n")).toBe(false);
  });
});
