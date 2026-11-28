import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileEntry } from "../lib/api";
import type { HistoryStatus } from "../lib/historyApi";
import type { LibraryStatus } from "../lib/libraryApi";
import dialogSource from "./ProjectSettingsDialog.tsx?raw";
import {
  bibNames,
  bibScanSummary,
  hasDocumentClass,
  historyLine,
  libraryState,
  linkedBibFiles,
  mainDocCandidates,
  mainDocOptions,
  normalizeRel,
  PROJECT_SECTIONS,
  sizeText,
  texFilesToScan,
} from "./projectSettingsLogic";
import { ProjectSettingsSection, ProjectSettingsView, type ProjectSettingsModel } from "./ProjectSettingsDialog";

const file = (path: string, size = 100): FileEntry => ({ path, isDir: false, size });
const dir = (path: string): FileEntry => ({ path, isDir: true, size: 0 });

describe("mainDocCandidates", () => {
  it("returns only .tex files whose text has \\documentclass", () => {
    const files = [file("main.tex"), file("chapters/intro.tex"), file("notes.md"), file("refs.bib"), dir("chapters"), file("Paper.TEX")];
    const contents = {
      "main.tex": "\\documentclass[11pt]{article}\n\\begin{document}\\end{document}",
      "chapters/intro.tex": "\\section{Intro}",
      "notes.md": "\\documentclass{article}",
      "refs.bib": "\\documentclass{article}",
      "Paper.TEX": "\\documentclass{amsart}",
    };
    expect(mainDocCandidates(files, contents)).toEqual(["main.tex", "Paper.TEX"]);
  });

  it("ignores \\documentclass in comments and files that weren't read", () => {
    const contents = {
      "a.tex": "% \\documentclass{article}\n\\input{x}",
      "b.tex": "\\% \\documentclass{article}",
      "c.tex": "\\documentclass {report}",
    };
    // `\%` is a literal percent sign, not a comment.
    expect(mainDocCandidates(["a.tex", "b.tex", "c.tex", "d.tex"], contents)).toEqual(["b.tex", "c.tex"]);
    expect(hasDocumentClass("\\documentclassx")).toBe(false);
  });

  it("lists root files before files in folders", () => {
    const dc = "\\documentclass{article}";
    expect(mainDocCandidates(["z/main.tex", "b.tex", "a.tex"], { "z/main.tex": dc, "b.tex": dc, "a.tex": dc })).toEqual([
      "a.tex",
      "b.tex",
      "z/main.tex",
    ]);
  });

  it("keeps the current main document in the picker even when it no longer qualifies", () => {
    expect(mainDocOptions(["a.tex"], "old.tex")).toEqual(["old.tex", "a.tex"]);
    expect(mainDocOptions(["a.tex"], "a.tex")).toEqual(["a.tex"]);
    expect(mainDocOptions(["a.tex"], null)).toEqual(["a.tex"]);
  });

  it("reads only .tex files outside hidden and build folders, and not huge ones", () => {
    const files = [file("main.tex"), file(".texo/x.tex"), file("build/out.tex"), file("big.tex", 10 * 1024 * 1024), file("a.bib"), dir("sub.tex")];
    expect(texFilesToScan(files)).toEqual(["main.tex"]);
  });
});

describe("linkedBibFiles", () => {
  const files = [file("main.tex"), file("refs.bib"), file("paper/main.tex"), file("paper/lib.bib"), file("other.bib"), file(".git/x.bib")];

  it("uses the files the main document names, beside it first, then at the root", () => {
    expect(linkedBibFiles(files, "main.tex", "\\bibliography{refs, other}")).toEqual(["refs.bib", "other.bib"]);
    expect(linkedBibFiles(files, "paper/main.tex", "\\addbibresource[label=x]{lib.bib}\n\\bibliography{refs}")).toEqual([
      "paper/lib.bib",
      "refs.bib",
    ]);
  });

  it("falls back to every .bib file outside hidden folders when none named exists", () => {
    expect(linkedBibFiles(files, "main.tex", "% \\bibliography{refs}\n\\bibliography{missing}")).toEqual(["other.bib", "paper/lib.bib", "refs.bib"]);
    expect(linkedBibFiles(files, null, null)).toEqual(["other.bib", "paper/lib.bib", "refs.bib"]);
  });

  it("parses names and paths", () => {
    expect(bibNames("\\bibliography{a,b , a}\n%\\bibliography{c}")).toEqual(["a", "b"]);
    expect(normalizeRel("paper/../refs.bib")).toBe("refs.bib");
    expect(normalizeRel("./a//b.bib")).toBe("a/b.bib");
    expect(normalizeRel("../outside.bib")).toBeNull();
  });
});

describe("summaries", () => {
  const status = (s: Partial<HistoryStatus>): HistoryStatus => ({
    enabled: true,
    active: true,
    readOnly: false,
    error: null,
    notice: null,
    sizeBytes: 0,
    count: 0,
    offerGitExclude: false,
    ...s,
  });

  it("describes the history state", () => {
    expect(historyLine(null).text).toBe("Checking history…");
    expect(historyLine(null, "Couldn't read the history.")).toEqual({ text: "Couldn't read the history.", tone: "warning" });
    expect(historyLine(status({ count: 1, sizeBytes: 2048 })).text).toBe("1 version saved · 2 KB");
    expect(historyLine(status({ count: 42, sizeBytes: 1.5 * 1024 * 1024 })).text).toBe("42 versions saved · 1.5 MB");
    expect(historyLine(status({ enabled: false })).tone).toBe("muted");
    expect(historyLine(status({ readOnly: true })).tone).toBe("warning");
    expect(historyLine(status({ active: false, error: "Locked." })).text).toBe("Locked.");
    expect(sizeText(12)).toBe("12 bytes");
  });

  it("summarises a re-scan", () => {
    expect(bibScanSummary({ files: [], entries: 0, matched: 0, added: 0, removed: 0 })).toBe("No .bib files found.");
    expect(bibScanSummary({ files: ["a.bib", "b.bib"], entries: 40, matched: 31, added: 9, removed: 0 })).toBe(
      "Read 2 files: 40 entries, 31 already in the library, 9 added.",
    );
    expect(bibScanSummary({ files: ["a.bib"], entries: 1, matched: 0, added: 0, removed: 2 })).toBe("Read 1 file: 1 entry, 2 no longer cited.");
  });

  it("says when the library is unavailable", () => {
    const lib = (s: Partial<LibraryStatus>): LibraryStatus => ({
      available: true,
      warning: null,
      papers: 0,
      saved: 0,
      cacheEntries: 0,
      cacheBytes: 0,
      fileBytes: 0,
      ...s,
    });
    expect(libraryState(null)).toEqual({ ready: false, note: null });
    expect(libraryState(lib({}))).toEqual({ ready: true, note: null });
    expect(libraryState(lib({ available: false, warning: "The file is locked." })).note).toBe(
      "The paper library is unavailable: The file is locked. Your .bib files still work as usual.",
    );
    expect(libraryState("error")).toEqual({ ready: false, note: "The paper library is unavailable. Your .bib files still work as usual." });
  });
});

describe("ProjectSettingsView markup", () => {
  // Modal reads the focused element on its first render.
  beforeEach(() => vi.stubGlobal("document", { activeElement: null }));
  afterEach(() => vi.unstubAllGlobals());

  const model = (patch: Partial<ProjectSettingsModel> = {}): ProjectSettingsModel => ({
    name: "Thesis",
    path: "C:/Projects/Thesis",
    external: false,
    mainDocument: "main.tex",
    mainCandidates: ["main.tex", "draft.tex"],
    setMainDocument: () => {},
    engine: "xelatex",
    setEngine: () => {},
    history: {
      enabled: true,
      active: true,
      readOnly: false,
      error: null,
      notice: null,
      sizeBytes: 4096,
      count: 3,
      offerGitExclude: true,
    },
    historyError: null,
    setHistoryEnabled: () => {},
    keepHistoryOutOfGit: () => {},
    bibFiles: ["refs.bib"],
    library: { available: true, warning: null, papers: 2, saved: 1, cacheEntries: 0, cacheBytes: 0, fileBytes: 0 },
    rescanning: false,
    lastScan: null,
    rescan: () => {},
    aiEnabled: true,
    memorySize: "1 KB of 8 KB",
    projectProfiles: 2,
    openSettings: () => {},
    ...patch,
  });

  const section = (s: (typeof PROJECT_SECTIONS)[number][0], m = model()) =>
    renderToStaticMarkup(createElement(ProjectSettingsSection, { section: s, model: m }));

  it("renders a modal dialog with a nav listing all five sections", () => {
    const html = renderToStaticMarkup(createElement(ProjectSettingsView, { model: model(), onClose: () => {} }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Project settings"');
    for (const [, label] of PROJECT_SECTIONS) expect(html).toContain(`> ${label}</button>`);
    expect(PROJECT_SECTIONS.map(([id]) => id)).toEqual(["general", "compile", "history", "references", "ai"]);
    expect(html.split('aria-current="page"').length - 1).toBe(1);
    // The dialog is the shared Modal, which traps Tab and closes on Escape.
    expect(dialogSource).toMatch(/<Modal title="Project settings"/);
  });

  it("renders every section", () => {
    const general = section("general");
    expect(general).toContain("Main document");
    expect(general).toContain('<option value="draft.tex">draft.tex</option>');
    expect(general).toContain("C:/Projects/Thesis");

    const compile = section("compile");
    expect(compile).toContain('aria-label="Engine"');
    expect(compile).toMatch(/aria-checked="true"[^>]*>XeLaTeX/);
    expect(compile).toContain("Compile settings");

    const history = section("history");
    expect(history).toContain('role="switch"');
    expect(history).toContain('aria-checked="true"');
    expect(history).toContain("3 versions saved");
    expect(history).toContain("Keep history out of git");

    const refs = section("references");
    expect(refs).toContain("refs.bib");
    expect(refs).toMatch(/<button[^>]*>.*Re-scan<\/button>/);
    expect(refs).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Re-scan/);

    const ai = section("ai");
    expect(ai).toContain("Project memory");
    expect(ai).toContain("1 KB of 8 KB used.");
    expect(ai).toContain("2 profiles just for this project.");
  });

  it("degrades gracefully when the library is unavailable", () => {
    const html = section("references", model({ library: { available: false, warning: "Couldn't open library.db.", papers: 0, saved: 0, cacheEntries: 0, cacheBytes: 0, fileBytes: 0 } }));
    expect(html).toContain("refs.bib");
    expect(html).toContain("The paper library is unavailable: Couldn&#x27;t open library.db. Your .bib files still work as usual.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Re-scan/);
  });

  it("shows loading and empty states, hides the git offer when not offered, and points to Settings when AI is off", () => {
    expect(section("general", model({ mainCandidates: null }))).toContain("Looking…");
    expect(section("general", model({ mainCandidates: [], mainDocument: null }))).toContain("None found");
    expect(section("references", model({ bibFiles: [] }))).toContain("No .bib files in this project yet.");
    expect(section("history", model({ history: null }))).toContain("Checking history…");
    const failed = section("history", model({ history: null, historyError: "History is locked by another program." }));
    expect(failed).toContain("History is locked by another program.");
    expect(failed).not.toContain("Checking history…");
    expect(section("history", model({ history: { ...model().history!, offerGitExclude: false } }))).not.toContain("Keep history out of git");
    const ai = section("ai", model({ aiEnabled: false }));
    expect(ai).toContain("The AI helper is off.");
    expect(ai).not.toContain("Project memory");
  });

  it("loads the store-backed part only when opened", () => {
    expect(dialogSource).toMatch(/lazy\(\(\) => import\("\.\/ProjectSettingsConnected"\)\)/);
    expect(dialogSource).not.toMatch(/from "\.\.\/workspace\//);
    expect(dialogSource).not.toMatch(/from "\.\.\/history\/historyStore"/);
  });
});
