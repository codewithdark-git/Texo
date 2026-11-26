import { describe, expect, it } from "vitest";
import type { Issue } from "../lib/api";
import { consequenceSummary, groupIssues } from "./diagnostics";
import { isValidPackageName } from "../lib/texpkgApi";

const issue = (over: Partial<Issue>): Issue => ({ severity: "warning", message: "m", file: null, line: null, context: null, ...over });

describe("groupIssues", () => {
  it("keeps the stopping error first and moves consequences into their own group (E_L2R)", () => {
    const fatal = issue({ severity: "error", message: "auto expansion is only possible with scalable fonts.", fatal: true, explanation: "Install cm-super" });
    const cites = Array.from({ length: 23 }, (_, i) => issue({ message: `Citation \`k${i}' undefined`, citation: `k${i}`, consequence: true }));
    const ref = issue({ message: "Reference `fig:one' on page 1 undefined", consequence: true });
    const badbox = issue({ severity: "badbox", message: "Overfull \\hbox" });
    const { main, consequences } = groupIssues([fatal, badbox, ...cites, ref]);
    expect(main).toEqual([fatal, badbox]);
    expect(consequences).toHaveLength(24);
    expect(consequenceSummary(consequences)).toBe("23 undefined citations and 1 undefined cross-reference are only here because the compile stopped early");
  });

  it("leaves a complete run alone", () => {
    const cite = issue({ citation: "knuth" });
    expect(groupIssues([cite])).toEqual({ main: [cite], consequences: [] });
    expect(consequenceSummary([])).toBe("");
  });

  it("counts a citation used twice once, and reads in the singular", () => {
    const a = issue({ citation: "knuth", consequence: true });
    expect(consequenceSummary([a, { ...a }])).toBe("1 undefined citation is only here because the compile stopped early");
    expect(consequenceSummary([issue({ consequence: true }), issue({ consequence: true })])).toBe("2 warnings are only here because the compile stopped early");
  });

  it("counts an undefined label used several times once", () => {
    const ref = (line: number) => issue({ message: `Reference \`fig:one' on page 1 undefined on input line ${line}.`, consequence: true });
    const summary = consequenceSummary([ref(3), ref(4), ref(5), ref(6), issue({ message: "There were undefined references.", consequence: true })]);
    expect(summary).toBe("1 undefined cross-reference and 1 other warning are only here because the compile stopped early");
    const cite = issue({ citation: "knuth", consequence: true });
    expect(consequenceSummary([cite, ref(1), issue({ consequence: true })])).toBe("1 undefined citation, 1 undefined cross-reference and 1 other warning are only here because the compile stopped early");
  });
});

describe("isValidPackageName", () => {
  it("matches the backend's rule", () => {
    for (const ok of ["cm-super", "lm", "els-cas-templates", "a_b.c"]) expect(isValidPackageName(ok)).toBe(true);
    for (const bad of ["", "-rf", "--admin", ".x", "a b", "a;b", "a/b", "$(x)", "ä", "a".repeat(65)]) expect(isValidPackageName(bad)).toBe(false);
  });
});
