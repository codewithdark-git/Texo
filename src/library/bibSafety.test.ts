import { describe, expect, it } from "vitest";
import { bibUnsafeReasons, unsafeConstruct, unsafeEntryText } from "./bibSafety";

const entry = (title: string) => `@article{smith2020,\n  title={${title}},\n  author={Smith, Jo and M{\\"u}ller, A}\n}`;

describe("remote BibTeX safety (allowlist)", () => {
  it("passes ordinary entries, accents and math", () => {
    for (const t of [
      "On the {\\'e}tude of $x^2$ and \\textit{Na}\\textsubscript{2}",
      "A \\emph{write} up of 18 inputs | outputs \\& more",
      "$\\alpha$-helices in $\\mathbb{R}^n$, $\\sqrt{2}\\times 10^{-3}$",
      "Line\\\\break and {\\o}re {\\ss} \\url{https://x.org/a_b}",
    ]) {
      expect(bibUnsafeReasons(entry(t)), t).toEqual([]);
    }
  });

  it("refuses commands that run programs or Lua", () => {
    expect(unsafeConstruct(entry("\\immediate\\write18{rm -rf ~}"))).toBe("\\immediate");
    expect(unsafeConstruct(entry("\\write18{x}"))).toBe("\\write");
    expect(unsafeConstruct(entry("\\directlua{os.execute('x')}"))).toBe("\\directlua");
    expect(unsafeConstruct(entry("\\input{|curl x}"))).toBe("\\input");
    expect(unsafeConstruct(entry("\\openout3=latexmkrc"))).toBe("\\openout");
  });

  it("refuses aliases and hidden commands", () => {
    expect(unsafeConstruct(entry("\\let\\w=\\write \\w18{x}"))).toBe("\\let");
    expect(unsafeConstruct(entry("\\def\\x{\\write}"))).toBe("\\def");
    expect(unsafeConstruct(entry("\\csname directlua\\endcsname{x}"))).toBe("\\csname");
    expect(unsafeConstruct(entry("\\expandafter\\x"))).toBe("\\expandafter");
    expect(unsafeConstruct(entry("\\catcode`\\|=0"))).toBe("\\catcode");
    expect(unsafeConstruct(entry("^^5cdirectlua{x}"))).toBe("^^");
    expect(unsafeConstruct(entry("^^Z"))).toBe("^^");
    expect(unsafeConstruct('@PREAMBLE{"x"}')).toBe("@preamble");
    expect(unsafeConstruct(entry("\\'\\write18"))).toBe("\\write");
    expect(unsafeConstruct('@ preamble{"x"}')).toBe("@preamble");
  });

  it("refuses values BibTeX joins before TeX reads them", () => {
    expect(unsafeConstruct('@article{k, title = "\\" # "write18{x}"}')).toBe("a backslash at the end of a field");
    expect(unsafeConstruct('@article{k, title = "a" # "b"}')).toBe("# (joining values)");
    expect(unsafeConstruct('@string{w = "write"}\n@article{k, title = {x}}')).toBe("@string");
    expect(unsafeConstruct("@article{k, title = {a\\}}")).toBe("a backslash at the end of a field");
    expect(unsafeConstruct("@article(k, title = {a})")).toBe("an entry in ( ) instead of { }");
    expect(unsafeConstruct('{{ @article{k, title = "\\" # "write18{x}"}')).toBe("text outside the entry");
    expect(unsafeConstruct("@misc{a, title = {x}}\n@misc{b, title = {y}}")).toBe("text outside the entry");
    expect(unsafeConstruct("@misc{a, title = {x}")).toBe("an entry that isn't closed");
    expect(unsafeConstruct("@misc{a, title = {x}}}")).toBe("text outside the entry");
    expect(unsafeConstruct("  @ARTICLE{a, title = {x}}\n")).toBeNull();
    expect(unsafeConstruct('@misc{k, url = {https://x.org/a#b}, note = {say "hi" \\\\}}')).toBeNull();
    expect(unsafeConstruct('@misc{k, title = "M{\\"u}ller"}')).toBeNull();
  });

  it("words the refusal plainly", () => {
    expect(unsafeEntryText(bibUnsafeReasons(entry("\\directlua{x}")))).toBe(
      "This paper's BibTeX from the online source uses \\directlua, which isn't plain formatting and could run code when the project compiles, so Texo didn't add it.",
    );
  });
});
