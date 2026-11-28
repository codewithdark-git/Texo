import { describe, expect, it } from "vitest";
import { appendBibEntry, bibKeys, detectEol, diffRange, entryKey, insertBibEntry, undoBibInsert, type BibIo } from "./bibInsert";

const ENTRY = "@article{smith2020a,\n  title = {A paper},\n  year = {2020}\n}";

/** An in-memory BibIo: `open` holds the editor buffers, `disk` the files. */
function fakeIo(disk: Record<string, string>, open: Record<string, string> = {}) {
  const calls: string[] = [];
  const io: BibIo = {
    openText: async (f) => (f in open ? open[f] : null),
    editOpen: async (f, e) => {
      calls.push(`edit ${f}`);
      open[f] = open[f].slice(0, e.start) + e.text + open[f].slice(e.end);
    },
    readDisk: async (f) => disk[f] ?? "",
    writeDisk: async (f, t) => {
      calls.push(`write ${f}`);
      disk[f] = t;
    },
  };
  return { io, disk, open, calls };
}

describe("bibKeys", () => {
  it("lists entry keys and skips @string, @preamble and @comment", () => {
    const text = '@string{nat = "Nature"}\n@Article{ lecun2015 ,\n title={x}}\n@comment{hi, there}\n@book(knuth84, title={TAOCP})';
    expect(bibKeys(text)).toEqual(["lecun2015", "knuth84"]);
    expect(entryKey(ENTRY)).toBe("smith2020a");
    expect(entryKey("no entry here")).toBeNull();
  });

  it("detects the file's line ending", () => {
    expect(detectEol("a\r\nb")).toBe("\r\n");
    expect(detectEol("a\nb")).toBe("\n");
    expect(detectEol("")).toBe("\n");
  });
});

describe("appendBibEntry", () => {
  it("appends after one blank line, whatever whitespace the file ended with", () => {
    for (const text of ["@misc{a, title={A}}", "@misc{a, title={A}}\n", "@misc{a, title={A}}\n\n\n  "]) {
      const r = appendBibEntry(text, ENTRY);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.text).toBe(`@misc{a, title={A}}\n\n${ENTRY}\n`);
        expect(r.key).toBe("smith2020a");
      }
    }
  });

  it("starts an empty file with just the entry", () => {
    const r = appendBibEntry("", ENTRY);
    expect(r.ok && r.text).toBe(`${ENTRY}\n`);
  });

  it("keeps a CRLF file CRLF, the new entry included", () => {
    const r = appendBibEntry("@misc{a,\r\n  title={A}\r\n}\r\n", ENTRY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(`@misc{a,\r\n  title={A}\r\n}\r\n\r\n${ENTRY.replace(/\n/g, "\r\n")}\r\n`);
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("refuses a key the file already has, ignoring case", () => {
    const r = appendBibEntry("@article{Smith2020A, title={Old}}\n", ENTRY);
    expect(r).toEqual({ ok: false, reason: "The file already has an entry called smith2020a." });
    expect(appendBibEntry("", "just text").ok).toBe(false);
  });
});

describe("diffRange", () => {
  it("finds the smallest edit", () => {
    expect(diffRange("abc", "abXc")).toEqual({ start: 2, end: 2, text: "X" });
    expect(diffRange("abXc", "abc")).toEqual({ start: 2, end: 3, text: "" });
    expect(diffRange("same", "same")).toEqual({ start: 4, end: 4, text: "" });
    const before = "@misc{a}\n\n\n";
    const after = "@misc{a}\n\n@x{b,}\n";
    const d = diffRange(before, after);
    expect(before.slice(0, d.start) + d.text + before.slice(d.end)).toBe(after);
  });
});

describe("insertBibEntry", () => {
  it("targets the open buffer when the file is open, leaving the disk alone", async () => {
    const { io, disk, open, calls } = fakeIo({ "refs.bib": "@misc{old, title={On disk}}\n" }, { "refs.bib": "@misc{old, title={Unsaved edit}}\n" });
    const r = await insertBibEntry(io, "refs.bib", ENTRY);
    expect(r.target).toBe("buffer");
    expect(calls).toEqual(["edit refs.bib"]);
    expect(open["refs.bib"]).toBe(`@misc{old, title={Unsaved edit}}\n\n${ENTRY}\n`);
    expect(disk["refs.bib"]).toBe("@misc{old, title={On disk}}\n");
  });

  it("writes the file on disk when it isn't open", async () => {
    const { io, disk, calls } = fakeIo({ "refs.bib": "@misc{old,}\r\n" });
    const r = await insertBibEntry(io, "refs.bib", ENTRY);
    expect(r.target).toBe("disk");
    expect(calls).toEqual(["write refs.bib"]);
    expect(disk["refs.bib"]).toContain("\r\n\r\n@article{smith2020a,\r\n");
  });

  it("checks the key against the unsaved buffer", async () => {
    const { io, calls } = fakeIo({ "refs.bib": "" }, { "refs.bib": "@article{smith2020a, title={typed just now}}\n" });
    await expect(insertBibEntry(io, "refs.bib", ENTRY)).rejects.toThrow("already has an entry called smith2020a");
    expect(calls).toEqual([]);
  });

  it("undo takes the entry back, but not after the file changed again", async () => {
    const { io, open } = fakeIo({}, { "refs.bib": "@misc{old,}\n" });
    const r = await insertBibEntry(io, "refs.bib", ENTRY);
    expect(await undoBibInsert(io, r)).toBe(true);
    expect(open["refs.bib"]).toBe("@misc{old,}\n");

    const again = await insertBibEntry(io, "refs.bib", ENTRY);
    open["refs.bib"] += "% more typing\n";
    expect(await undoBibInsert(io, again)).toBe(false);
    expect(open["refs.bib"]).toContain("smith2020a");
  });
});
