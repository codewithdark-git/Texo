import { describe, expect, it } from "vitest";
import { activeSources, webToolsSummary, type WebToolsStatus } from "./webToolsApi";

const allOn = { s2: true, crossref: true, arxiv: true, openalex: true };

const base: WebToolsStatus = {
  settings: { searchProvider: null, searxngUrl: null, contactEmail: null, sources: allOn },
  keys: [],
  activeSearch: null,
  webSearchAvailable: false,
  openalexEnabled: false,
  s2Key: false,
  sources: allOn,
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

describe("paper sources", () => {
  it("lists the sources in the summary in a stable order", () => {
    expect(webToolsSummary(base)).toContain("Paper search uses arXiv, Crossref and Semantic Scholar (no key needed).");
    expect(webToolsSummary({ ...base, openalexEnabled: true })).toContain(
      "Paper search uses arXiv, Crossref, Semantic Scholar and OpenAlex.",
    );
  });

  it("leaves out sources that are switched off, and OpenAlex without a key", () => {
    const s = { ...base, sources: { ...allOn, crossref: false } };
    expect(activeSources(s)).toEqual(["s2", "arxiv"]);
    expect(webToolsSummary(s)).toContain("Paper search uses arXiv and Semantic Scholar (no key needed).");
    expect(activeSources({ ...base, openalexEnabled: true })).toEqual(["s2", "crossref", "arxiv", "openalex"]);
  });

  it("says when every source is off", () => {
    const none = { s2: false, crossref: false, arxiv: false, openalex: false };
    expect(activeSources({ ...base, sources: none })).toEqual([]);
    expect(webToolsSummary({ ...base, sources: none })).toContain("Paper search is off");
  });

  it("treats a status without switches (an older backend) as all on", () => {
    const old = { ...base, sources: undefined } as unknown as WebToolsStatus;
    expect(activeSources(old)).toEqual(["s2", "crossref", "arxiv"]);
  });
});
