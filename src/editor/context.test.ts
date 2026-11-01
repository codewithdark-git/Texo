import { describe, expect, it } from "vitest";
import { completionContext, withoutExtension } from "./context";

describe("completionContext", () => {
  it.each([
    ["\\sec", { kind: "command", prefix: "sec", start: 1 }],
    ["text \\", { kind: "command", prefix: "", start: 6 }],
    ["\\section*", { kind: "command", prefix: "section*", start: 1 }],
    ["see \\ref{fig:", { kind: "label", prefix: "fig:", start: 9 }],
    ["\\cref{a, se", { kind: "label", prefix: "se", start: 9 }],
    ["\\cite{knu", { kind: "citation", prefix: "knu", start: 6 }],
    ["\\citep[p.~4]{a,b", { kind: "citation", prefix: "b", start: 15 }],
    ["\\parencite{", { kind: "citation", prefix: "", start: 11 }],
    ["\\begin{fig", { kind: "environment", prefix: "fig", start: 7 }],
    ["\\input{sec", { kind: "texFile", prefix: "sec", start: 7 }],
    ["\\include{", { kind: "includeFile", prefix: "", start: 9 }],
    ["\\includegraphics[width=3cm]{im", { kind: "image", prefix: "im", start: 28 }],
    ["\\bibliography{re", { kind: "bibFile", prefix: "re", start: 14 }],
    ["\\addbibresource{", { kind: "bibResource", prefix: "", start: 16 }],
  ])("%s", (line, expected) => {
    expect(completionContext(line)).toEqual(expected);
  });

  it("ignores comments, closed arguments, and plain text", () => {
    expect(completionContext("% \\sec")).toBeNull();
    expect(completionContext("\\ref{a} and more")).toBeNull();
    expect(completionContext("hello world")).toBeNull();
    expect(completionContext("\\textbf{bo")).toBeNull();
  });

  it("still completes after an escaped percent sign", () => {
    expect(completionContext("50\\% of \\ci")?.kind).toBe("command");
  });
});

describe("withoutExtension", () => {
  it("strips only the given extension", () => {
    expect(withoutExtension("chapters/One.TEX", ".tex")).toBe("chapters/One");
    expect(withoutExtension("refs.bib", ".tex")).toBe("refs.bib");
  });
});
