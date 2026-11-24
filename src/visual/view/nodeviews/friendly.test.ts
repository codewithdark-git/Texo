import { describe, expect, it } from "vitest";
import { commandLabel, commandName, humanize, readableInline } from "./friendly";

describe("commandLabel", () => {
  it("names known commands without a backslash", () => {
    expect(commandLabel("\\maketitle")).toBe("Title");
    expect(commandLabel("\\tableofcontents")).toBe("Table of contents");
    expect(commandLabel("\\newpage")).toBe("Page break");
    expect(commandLabel("\\input{sec}", "input")).toBe("Included file");
  });

  it("humanizes unknown commands", () => {
    expect(commandLabel("\\printacronyms")).toBe("Print acronyms");
    expect(commandLabel("\\myCustomThing")).toBe("My custom thing");
    expect(commandLabel("{}")).toBe("Layout");
    for (const s of ["\\foo", "\\printacronyms", "\\x@y"]) expect(commandLabel(s)).not.toContain("\\");
    expect(humanize("makeglossaries")).toBe("Make glossaries");
    expect(commandName("  \\section*{x}")).toBe("section");
  });
});

describe("readableInline", () => {
  it("keeps the printed text", () => {
    expect(readableInline("\\textcolor{red}{warning}")).toBe("warning");
    expect(readableInline("\\href{https://x.org}{the site}")).toBe("the site");
    expect(readableInline("\\mbox{New York}")).toBe("New York");
    expect(readableInline("\\LaTeX{}")).toBe("LaTeX");
    expect(readableInline("100\\%")).toBe("100%");
  });

  it("is empty for spacing and invisible commands", () => {
    expect(readableInline("\\hspace{1cm}")).toBe("");
    expect(readableInline("\\vspace*{2em}")).toBe("");
    expect(readableInline("\\foo")).toBe("");
    expect(readableInline("\\label{x}")).toBe("");
  });
});
