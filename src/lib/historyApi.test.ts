import { describe, expect, it } from "vitest";
import { historyStatusText, type HistoryStatus } from "./historyApi";

const base: HistoryStatus = {
  enabled: true,
  active: true,
  readOnly: false,
  error: null,
  notice: null,
  sizeBytes: 0,
  count: 1,
  offerGitExclude: false,
};

describe("historyStatusText", () => {
  it("counts versions", () => {
    expect(historyStatusText(base)).toBe("History on · 1 version");
    expect(historyStatusText({ ...base, count: 42 })).toBe("History on · 42 versions");
  });

  it("explains why history is off", () => {
    expect(historyStatusText({ ...base, enabled: false, active: false })).toBe("History off");
    expect(historyStatusText({ ...base, active: false, readOnly: true })).toBe("History off (read-only folder)");
    expect(historyStatusText({ ...base, active: false, error: "x" })).toBe("History unavailable");
    expect(historyStatusText(null)).toBe("");
  });
});
