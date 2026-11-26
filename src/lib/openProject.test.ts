import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "./api";
import { describeCandidate, isMissing, lastKnownPlace, needsMainChoice, readOnlyMessage } from "./openProject";

const project = (extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "1",
  name: "Paper",
  path: "C:\\Papers\\Paper",
  mainDocument: "main.tex",
  engine: "pdflatex",
  createdAt: "2026-01-01T00:00:00Z",
  lastEdited: "2026-01-01T00:00:00Z",
  fileCount: 1,
  external: true,
  thumbnail: null,
  outputPdf: null,
  ...extra,
});

describe("open flow helpers", () => {
  it("recognises read-only errors from the backend", () => {
    expect(readOnlyMessage("[read-only] Texo can't save its own files")).toBe("Texo can't save its own files");
    expect(readOnlyMessage("You don't have permission to open this folder.")).toBeNull();
  });

  it("asks for a main document only when there is a real choice", () => {
    expect(needsMainChoice(project())).toBe(false);
    expect(needsMainChoice(project({ mainCandidates: ["a.tex"] }))).toBe(false);
    expect(needsMainChoice(project({ mainCandidates: ["a.tex", "b.tex"] }))).toBe(true);
  });

  it("splits candidates into file and folder", () => {
    expect(describeCandidate("main.tex")).toEqual({ name: "main.tex", folder: null });
    expect(describeCandidate("paper/conf/main.tex")).toEqual({ name: "main.tex", folder: "paper/conf" });
  });

  it("knows missing rows", () => {
    expect(isMissing(project())).toBe(false);
    expect(isMissing(project({ missing: true }))).toBe(true);
    expect(lastKnownPlace(project({ path: "/home/a/Paper/" }))).toBe("/home/a/Paper");
  });
});
