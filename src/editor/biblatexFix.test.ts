import { describe, expect, it } from "vitest";
import { applyEdit, bibtexBackendEdit, parseHint } from "./biblatexFix";

/** The text after the fix, or null when there's nothing to fix. */
const fix = (text: string) => {
  const edit = bibtexBackendEdit(text);
  return edit && applyEdit(text, edit);
};

describe("parseHint", () => {
  it("splits off the fix marker", () => {
    expect(parseHint("[fix:biblatex-bibtex] Biber isn't installed.")).toEqual({ fix: "biblatex-bibtex", text: "Biber isn't installed." });
    expect(parseHint("Just a tip.")).toEqual({ fix: null, text: "Just a tip." });
  });

  it("reads a fix argument such as the package to install", () => {
    expect(parseHint("[fix:install-package:cm-super] TeX stopped.")).toEqual({ fix: "install-package", arg: "cm-super", text: "TeX stopped." });
    // Anything that isn't a plain package name stays in the text.
    expect(parseHint("[fix:install-package:a b] x").fix).toBeNull();
  });
});

describe("bibtexBackendEdit", () => {
  it("replaces another backend", () => {
    expect(fix("\\usepackage[backend=biber,style=apa]{biblatex}")).toBe("\\usepackage[backend=bibtex,style=apa]{biblatex}");
    expect(fix("\\usepackage[style=ieee, backend = biber]{biblatex}")).toBe("\\usepackage[style=ieee, backend=bibtex]{biblatex}");
  });

  it("adds the option when there is none (Biber is the default)", () => {
    expect(fix("\\usepackage{biblatex}")).toBe("\\usepackage[backend=bibtex]{biblatex}");
    expect(fix("\\usepackage[style=numeric]{biblatex}")).toBe("\\usepackage[backend=bibtex,style=numeric]{biblatex}");
    expect(fix("\\usepackage[]{biblatex}")).toBe("\\usepackage[backend=bibtex]{biblatex}");
    expect(fix("\\usepackage[\n  style=numeric,\n]{biblatex}")).toBe("\\usepackage[backend=bibtex,\n  style=numeric,\n]{biblatex}");
  });

  it("never puts the option inside a % comment", () => {
    // A trailing comment on the last option line would swallow an appended option.
    expect(fix("\\usepackage[\n  style=authoryear, % nice style\n]{biblatex}")).toBe(
      "\\usepackage[backend=bibtex,\n  style=authoryear, % nice style\n]{biblatex}",
    );
    // The last option line is itself commented out.
    expect(fix("\\usepackage[\n  style=apa,\n  % sorting=none\n]{biblatex}")).toBe(
      "\\usepackage[backend=bibtex,\n  style=apa,\n  % sorting=none\n]{biblatex}",
    );
    // A commented-out backend doesn't count, either as BibTeX or as the one to replace.
    expect(fix("\\usepackage[\n  % backend=bibtex,\n  style=apa\n]{biblatex}")).toBe(
      "\\usepackage[backend=bibtex,\n  % backend=bibtex,\n  style=apa\n]{biblatex}",
    );
    expect(fix("\\usepackage[style=apa, % backend=biber\n  backend=biber]{biblatex}")).toBe(
      "\\usepackage[style=apa, % backend=biber\n  backend=bibtex]{biblatex}",
    );
    // Only a comment between the brackets: the comment stays on its line.
    expect(fix("\\usepackage[% options\n]{biblatex}")).toBe("\\usepackage[backend=bibtex,% options\n]{biblatex}");
  });

  it("leaves BibTeX, comments and other packages alone", () => {
    expect(fix("\\usepackage[backend=bibtex]{biblatex}")).toBeNull();
    expect(fix("\\usepackage{natbib}")).toBeNull();
    expect(fix("% \\usepackage{biblatex}\n\\usepackage[backend=biber]{biblatex}")).toBe(
      "% \\usepackage{biblatex}\n\\usepackage[backend=bibtex]{biblatex}",
    );
    expect(fix("% \\usepackage{biblatex}")).toBeNull();
  });
});
