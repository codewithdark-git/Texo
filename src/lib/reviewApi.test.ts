import { describe, expect, it } from "vitest";
import { checklistSummary, isReviewReport, scoreText, setupForPreset, sortChecks, type Check, type VenuePreset } from "./reviewApi";

const check = (id: string, status: Check["status"]): Check => ({ id, title: id, status, details: [], file: null, line: null });

describe("reviewApi helpers", () => {
  it("sorts the worst checks first and keeps order otherwise", () => {
    const sorted = sortChecks([check("a", "pass"), check("b", "warn"), check("c", "fail"), check("d", "warn")]);
    expect(sorted.map((c) => c.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("summarises the checklist in plain words", () => {
    expect(checklistSummary([check("a", "pass"), check("b", "pass")])).toBe("All 2 checks passed");
    expect(checklistSummary([check("a", "fail"), check("b", "warn"), check("c", "warn")])).toBe("1 problem, 2 warnings");
    expect(checklistSummary([])).toBe("No checks run");
  });

  it("labels scores", () => {
    const scale = { id: "rating", name: "Rating", min: 1, max: 10, step: null, labels: [{ value: 8, label: "accept" }], description: "" };
    expect(scoreText(scale, 8)).toBe("8 (accept)");
    expect(scoreText(scale, 6)).toBe("6");
    expect(scoreText(scale, null)).toBe("–");
  });

  it("builds a setup from a preset and recognises review reports", () => {
    const preset = { id: "neurips", rubric: { sections: [], scores: [], confidence: null, decisions: [] } } as unknown as VenuePreset;
    const s = setupForPreset(preset, 9);
    expect(s.reviewers).toBe(5);
    expect(s.venue).toBe("neurips");
    expect(isReviewReport({ kind: "review", reviews: [] })).toBe(true);
    expect(isReviewReport({ kind: "rebuttal" })).toBe(false);
    expect(isReviewReport(null)).toBe(false);
  });
});
