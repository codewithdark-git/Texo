import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../workspace/compileStore", () => ({ useCompile: { getState: () => ({ result: null, finishedAt: null }), subscribe: () => () => {} } }));
vi.mock("../../workspace/store", () => ({ useWorkspace: { getState: () => ({ project: null }), subscribe: () => () => {} }, getModel: () => undefined }));

import { cachedSnapshot, compiledRange, lineOf, lineRange, Lru, probeLines, regionFor, withoutEcho, snapshot, snapshotKey } from "./pdfSnapshot";

describe("lines", () => {
  const text = "a\nb\n\n\\begin{tikzpicture}\n\\draw;\n\\end{tikzpicture}\n\nz";
  it("counts lines from 1", () => {
    expect(lineOf(text, 0)).toBe(1);
    expect(lineOf(text, 2)).toBe(2);
    expect(lineOf(text, text.length)).toBe(8);
  });

  it("covers a block's non-blank lines", () => {
    const start = text.indexOf("\n\\begin");
    const end = text.indexOf("\n\nz") + 1;
    expect(lineRange(text, start, end)).toEqual([4, 6]);
    expect(lineRange(text, 0, 1)).toEqual([1, 1]);
  });
});

describe("regionFor", () => {
  it("joins the boxes on the page most lines land on, with padding", () => {
    const r = regionFor([
      { page: 2, rects: [{ x: 100, y: 200, width: 50, height: 10 }] },
      { page: 2, rects: [{ x: 80, y: 260, width: 100, height: 20 }] },
      { page: 3, rects: [{ x: 0, y: 0, width: 500, height: 500 }] },
    ]);
    expect(r).toEqual({ page: 2, rect: { x: 77, y: 197, width: 106, height: 86 } });
  });

  it("ignores a float's opening line that lands in the text before it", () => {
    const r = regionFor([
      { page: 4, rects: [{ x: 0, y: 0, width: 400, height: 40 }] },
      { page: 5, rects: [{ x: 100, y: 100, width: 50, height: 10 }] },
      { page: 5, rects: [{ x: 100, y: 120, width: 50, height: 10 }] },
    ], 0);
    expect(r).toEqual({ page: 5, rect: { x: 100, y: 100, width: 50, height: 30 } });
  });

  it("probes a block's inner lines", () => {
    expect(probeLines(7, 7)).toEqual([7]);
    expect(probeLines(7, 8)).toEqual([7, 8]);
    expect(probeLines(10, 14)).toEqual([11, 12, 13]);
    const many = probeLines(1, 200, 5);
    expect(many).toEqual([2, 51, 101, 150, 199]);
  });

  it("drops inner lines that only echo the text before a float", () => {
    const before = { page: 12, rects: [{ x: 0, y: 529, width: 400, height: 80 }] };
    const caption = { page: 12, rects: [{ x: 0, y: 628, width: 400, height: 24 }] };
    expect(withoutEcho([{ ...before }, caption], before)).toEqual([caption]);
    expect(withoutEcho([{ ...before }], before)).toEqual([before]);
    expect(withoutEcho([caption], null)).toEqual([caption]);
  });

  it("is null without boxes", () => {
    expect(regionFor([null, { page: 1, rects: [] }])).toBeNull();
    expect(regionFor([{ page: 1, rects: [{ x: 1, y: 1, width: 0, height: 0 }] }], 0)).toBeNull();
  });
});

describe("cache", () => {
  it("keys by compile, file and source", () => {
    expect(snapshotKey(1, "a.tex", "x")).not.toBe(snapshotKey(2, "a.tex", "x"));
    expect(snapshotKey(1, "a.tex", "x")).not.toBe(snapshotKey(1, "b.tex", "x"));
    // The same source at other compiled lines is another picture.
    expect(snapshotKey(1, "a.tex", "x", "4-6")).not.toBe(snapshotKey(1, "a.tex", "x", "9-11"));
  });

  it("evicts the least recently used entry", () => {
    const gone: number[] = [];
    const lru = new Lru<number>(2, (v) => gone.push(v));
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("a")).toBe(true);
    expect(gone).toEqual([2]);
    lru.clear();
    expect(lru.size).toBe(0);
  });

  it("has nothing before a compile", async () => {
    const req = { path: "main.tex", text: "x", start: 0, end: 1 };
    expect(cachedSnapshot(req)).toBeNull();
    await expect(snapshot(req)).resolves.toBeNull();
  });
});

describe("compiledRange", () => {
  const compiled = "intro\n\n\\begin{tikzpicture}\n\\draw;\n\\end{tikzpicture}\n\nend";
  const block = (text: string) => [text.indexOf("\\begin"), text.indexOf("picture}\n\nend") + 8] as const;

  it("keeps offsets when nothing changed, or only after the block", () => {
    const [s, e] = block(compiled);
    expect(compiledRange(compiled, compiled, s, e)).toEqual([s, e]);
    expect(compiledRange(compiled, compiled + "\n\nmore", s, e)).toEqual([s, e]);
  });

  it("maps a block after new paragraphs back to its compiled lines", () => {
    const current = "intro\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\n" + compiled.slice("intro\n\n".length);
    const [s, e] = block(current);
    const range = compiledRange(compiled, current, s, e);
    expect(range).toEqual(block(compiled));
    expect(lineRange(compiled, range![0], range![1])).toEqual([3, 5]);
    // The editor's own lines would point SyncTeX at the wrong place.
    expect(lineRange(current, s, e)).toEqual([13, 15]);
  });

  it("is null when the block itself was edited", () => {
    const current = compiled.replace("\\draw;", "\\draw (0,0) circle (1);");
    const [s, e] = block(current);
    expect(compiledRange(compiled, current, s, e)).toBeNull();
  });
});
