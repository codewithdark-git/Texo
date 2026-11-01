import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "./api";
import { filterProjects, formatRelative, sortProjects } from "./projects";

function project(name: string, lastEdited: string, createdAt = lastEdited): ProjectSummary {
  return {
    id: name,
    name,
    path: `C:\\Users\\me\\Documents\\Texo\\${name}`,
    mainDocument: "main.tex",
    engine: "pdflatex",
    createdAt,
    lastEdited,
    fileCount: 1,
    external: false,
    thumbnail: null,
  };
}

const list = [
  project("Thesis 10", "2026-10-01T00:00:00Z", "2026-01-01T00:00:00Z"),
  project("thesis 2", "2026-10-30T00:00:00Z", "2026-03-01T00:00:00Z"),
  project("Abstract", "2026-09-15T00:00:00Z", "2026-05-01T00:00:00Z"),
];

describe("filterProjects", () => {
  it("matches name case-insensitively and ignores blank queries", () => {
    expect(filterProjects(list, "THESIS").map((p) => p.name)).toEqual(["Thesis 10", "thesis 2"]);
    expect(filterProjects(list, "   ")).toHaveLength(3);
  });
});

describe("sortProjects", () => {
  it("sorts names naturally", () => {
    expect(sortProjects(list, "name", "asc").map((p) => p.name)).toEqual([
      "Abstract",
      "thesis 2",
      "Thesis 10",
    ]);
  });

  it("sorts by date in either direction without mutating the input", () => {
    const newest = sortProjects(list, "lastEdited", "desc").map((p) => p.name);
    expect(newest).toEqual(["thesis 2", "Thesis 10", "Abstract"]);
    expect(sortProjects(list, "createdAt", "asc")[0].name).toBe("Thesis 10");
    expect(list[0].name).toBe("Thesis 10");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  it.each([
    ["2026-10-31T11:59:30Z", "just now"],
    ["2026-10-31T11:55:00Z", "5 min ago"],
    ["2026-10-31T09:00:00Z", "3 h ago"],
    ["2026-10-30T10:00:00Z", "yesterday"],
    ["2026-10-27T12:00:00Z", "4 days ago"],
  ])("%s -> %s", (iso, expected) => {
    expect(formatRelative(iso, now)).toBe(expected);
  });
});
