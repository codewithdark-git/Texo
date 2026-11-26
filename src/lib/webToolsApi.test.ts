import { describe, expect, it } from "vitest";
import { webToolsSummary, type WebToolsStatus } from "./webToolsApi";

const base: WebToolsStatus = {
  settings: { searchProvider: null, searxngUrl: null, contactEmail: null },
  keys: [],
  activeSearch: null,
  webSearchAvailable: false,
  openalexEnabled: false,
};

describe("webToolsSummary", () => {
  it("says web search is off without a service", () => {
    const s = webToolsSummary(base);
    expect(s).toContain("no key needed");
    expect(s).toContain("Web search is off");
  });

  it("names the active services", () => {
    const s = webToolsSummary({ ...base, activeSearch: "searxng", webSearchAvailable: true, openalexEnabled: true });
    expect(s).toContain("OpenAlex");
    expect(s).toContain("Web search uses SearXNG.");
  });
});
