import { describe, expect, it } from "vitest";
import {
  attachmentsProblem,
  base64Of,
  canSaveIntoProject,
  defaultSaveAs,
  MAX_RUN_ATTACHMENTS,
  runAttachLimit,
  safeFileName,
  saveAsProblem,
  saveUnavailableReason,
  toStartAttachment,
  type RunAttachment,
} from "./runAttachments";

const text = (over: Partial<RunAttachment> = {}): RunAttachment => ({
  id: "1",
  name: "notes.md",
  mime: "text/markdown",
  kind: "text",
  text: "# Notes",
  note: "",
  save: false,
  saveAs: "notes.md",
  ...over,
});
const image = (over: Partial<RunAttachment> = {}): RunAttachment => ({
  id: "2",
  name: "plot.jpg",
  mime: "image/jpeg",
  kind: "image",
  dataUrl: "data:image/jpeg;base64,QUJD",
  note: "",
  save: false,
  saveAs: "figures/plot.jpg",
  ...over,
});

describe("run attachment rules", () => {
  it("limits the number of files like the backend", () => {
    expect(runAttachLimit(MAX_RUN_ATTACHMENTS - 1)).toBeNull();
    expect(runAttachLimit(MAX_RUN_ATTACHMENTS)).toMatch(/up to 12/);
  });

  it("saves only text into the project", () => {
    expect(canSaveIntoProject(text())).toBe(true);
    expect(canSaveIntoProject(image())).toBe(false);
    expect(canSaveIntoProject(text({ name: "paper.pdf", mime: "application/pdf" }))).toBe(false);
    expect(saveUnavailableReason(image())).toMatch(/Pictures/);
    expect(saveUnavailableReason(text())).toBeNull();
  });

  it("suggests where to save: pictures in figures/", () => {
    expect(defaultSaveAs({ kind: "image", name: "My plot (1).jpg" })).toBe("figures/My-plot-1.jpg");
    expect(defaultSaveAs({ kind: "text", name: "C:\\x\\refs.bib" })).toBe("refs.bib");
    expect(safeFileName("...")).toBe("attachment.txt");
    expect(safeFileName('a<b>:"c?.tex')).toBe("abc.tex");
  });

  it("refuses paths outside the project or in Texo's folder", () => {
    expect(saveAsProblem("figures/a.png")).toBeNull();
    expect(saveAsProblem("")).toMatch(/Type/);
    expect(saveAsProblem("../a.tex")).toMatch(/inside/);
    expect(saveAsProblem("/etc/a")).toMatch(/inside/);
    expect(saveAsProblem("C:\\a.tex")).toMatch(/inside/);
    expect(saveAsProblem(".texo/ai/x.md")).toMatch(/Texo's own/);
    expect(saveAsProblem("a//b.tex")).toMatch(/empty/);
  });

  it("builds start attachments", () => {
    expect(toStartAttachment(image())).toEqual({ name: "plot.jpg", mime: "image/jpeg", dataBase64: "QUJD" });
    expect(toStartAttachment(text())).toEqual({ name: "notes.md", mime: "text/markdown", text: "# Notes" });
    expect(toStartAttachment(text({ save: true, saveAs: "sec\\notes.md" }))).toEqual({
      name: "notes.md",
      mime: "text/markdown",
      text: "# Notes",
      saveAs: "sec/notes.md",
    });
    // A picture never carries saveAs, even if checked.
    expect(toStartAttachment(image({ save: true })).saveAs).toBeUndefined();
    expect(base64Of("abc")).toBe("abc");
  });

  it("blocks bad or duplicate save paths", () => {
    expect(attachmentsProblem([text({ save: true, saveAs: "../x" })])).toMatch(/notes.md/);
    expect(attachmentsProblem([text({ save: true }), text({ id: "3", save: true, saveAs: "Notes.md" })])).toMatch(/Two files/);
    expect(attachmentsProblem([text({ save: true }), image({ save: true })])).toBeNull();
  });
});
