import { describe, expect, it } from "vitest";
import type { ChangesetFile, Hunk } from "../../lib/agentsApi";
import {
  applyHunks,
  carryPicks,
  changesetStale,
  decisionFor,
  hasConflictMarkers,
  hunkLabel,
  hunkPicking,
  hunkRevealLine,
  initialPick,
  lineCounts,
  pickedText,
  pickProblem,
  reasonNotes,
  selectedDecisions,
  splitLines,
} from "./hunks";

const h = (index: number, oldStart: number, oldLines: number, newStart: number, newLines: number): Hunk => ({ index, oldStart, oldLines, newStart, newLines });

// Hunks as libgit2 reports them (context 0), the same cases as the Rust test
// `hunks_and_partial_application` in src-tauri/src/agents/changeset.rs.
describe("applyHunks mirrors Rust's apply_hunks", () => {
  const base = "a\nb\nc\nd\ne\n";
  const next = "a\nB\nc\nd\nE\nf\n";
  const hunks = [h(0, 2, 1, 2, 1), h(1, 5, 1, 5, 2)];

  it("applies all, none, or some hunks", () => {
    expect(applyHunks(base, next, hunks, [0, 1])).toBe(next);
    expect(applyHunks(base, next, hunks, [])).toBe(base);
    expect(applyHunks(base, next, hunks, [0])).toBe("a\nB\nc\nd\ne\n");
    expect(applyHunks(base, next, hunks, [1])).toBe("a\nb\nc\nd\nE\nf\n");
  });

  it("handles insertions at the top and pure deletions", () => {
    const next2 = "top\na\nc\nd\ne\n";
    const h2 = [h(0, 0, 0, 1, 1), h(1, 2, 1, 2, 0)];
    expect(applyHunks(base, next2, h2, [0, 1])).toBe(next2);
    expect(applyHunks(base, next2, h2, [0])).toBe("top\na\nb\nc\nd\ne\n");
    expect(applyHunks(base, next2, h2, [1])).toBe("a\nc\nd\ne\n");
  });

  it("keeps a missing final newline and CRLF", () => {
    expect(applyHunks("x", "x\ny\n", [h(0, 1, 1, 1, 2)], [0])).toBe("x\ny\n");
    expect(applyHunks("x", "x\ny\n", [h(0, 1, 1, 1, 2)], [])).toBe("x");
    expect(applyHunks("a\r\nb\r\n", "a\r\nB\r\n", [h(0, 2, 1, 2, 1)], [0])).toBe("a\r\nB\r\n");
    expect(applyHunks("", "new\n", [h(0, 0, 0, 1, 1)], [0])).toBe("new\n");
  });

  it("doesn't depend on the order hunks arrive in", () => {
    expect(applyHunks(base, next, [...hunks].reverse(), [1])).toBe("a\nb\nc\nd\nE\nf\n");
  });

  it("splits lines like split_inclusive", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\nb")).toEqual(["a\n", "b"]);
    expect(splitLines("\n\n")).toEqual(["\n", "\n"]);
  });
});

describe("hunk labels and markers", () => {
  it("describes hunks in plain words", () => {
    expect(hunkLabel(h(0, 2, 1, 2, 1))).toBe("Changes line 2");
    expect(hunkLabel(h(0, 2, 3, 2, 1))).toBe("Changes lines 2–4");
    expect(hunkLabel(h(0, 0, 0, 1, 2))).toBe("Adds 2 lines at the top");
    expect(hunkLabel(h(0, 7, 0, 8, 1))).toBe("Adds 1 line after line 7");
    expect(hunkLabel(h(0, 4, 2, 3, 0))).toBe("Removes lines 4–5");
  });

  it("finds conflict markers only at line starts", () => {
    expect(hasConflictMarkers("a\n<<<<<<< yours\nb\n=======\nc\n>>>>>>> agent\n")).toBe(true);
    expect(hasConflictMarkers("a\n=======\n")).toBe(true);
    expect(hasConflictMarkers("text with <<<<<<< inside")).toBe(false);
    expect(hasConflictMarkers("%=========== a rule\n")).toBe(false);
  });
});

function file(over: Partial<ChangesetFile> = {}): ChangesetFile {
  return {
    file: "main.tex",
    baseText: "a\nb\nc\nd\ne\n",
    newText: "a\nB\nc\nd\nE\nf\n",
    status: "modified",
    conflict: false,
    changedOnDisk: false,
    baseHash: "0",
    reason: "Fix typos",
    state: "pending",
    hunks: [h(0, 2, 1, 2, 1), h(1, 5, 1, 5, 2)],
    ...over,
  };
}

describe("picks and decisions", () => {
  it("starts with every hunk of a pending file", () => {
    const f = file();
    expect(initialPick(f)).toEqual({ include: true, hunks: [0, 1], edited: null, reason: "" });
    // A conflict starts in but unresolved: no decision until the user picks.
    const conflict = file({ state: "conflict" });
    expect(initialPick(conflict).include).toBe(true);
    expect(decisionFor(conflict, initialPick(conflict))).toBeNull();
    expect(initialPick(file({ state: "applied" })).include).toBe(false);
  });

  it("turns a full pick into a plain accept and a partial one into hunks", () => {
    const f = file();
    expect(decisionFor(f, initialPick(f))).toEqual({ file: "main.tex", accept: true });
    expect(decisionFor(f, { ...initialPick(f), hunks: [1] })).toEqual({ file: "main.tex", accept: true, hunks: [1] });
    expect(pickedText(f, { ...initialPick(f), hunks: [1] })).toBe("a\nb\nc\nd\nE\nf\n");
  });

  it("rejects a file left out or with no hunks picked, carrying the reason", () => {
    const f = file();
    expect(decisionFor(f, { ...initialPick(f), include: false, reason: "  keep British spelling " })).toEqual({
      file: "main.tex",
      accept: false,
      reason: "keep British spelling",
    });
    expect(decisionFor(f, { ...initialPick(f), hunks: [] })).toEqual({ file: "main.tex", accept: false });
  });

  it("uses edited text over hunks", () => {
    const f = file();
    expect(decisionFor(f, { ...initialPick(f), hunks: [0], edited: "mine\n" })).toEqual({ file: "main.tex", accept: true, editedText: "mine\n" });
    expect(pickedText(f, { ...initialPick(f), edited: "mine\n" })).toBe("mine\n");
  });

  it("needs a resolution for a conflict and refuses leftover markers", () => {
    const f = file({ state: "conflict", conflict: true, mergedText: "<<<<<<< yours\nx\n=======\ny\n>>>>>>> agent\n" });
    const pick = initialPick(f);
    expect(pickProblem(f, pick)).toMatch(/Pick a version/);
    expect(decisionFor(f, pick)).toBeNull();
    expect(pickProblem(f, { ...pick, edited: f.mergedText! })).toMatch(/conflict markers/);
    expect(decisionFor(f, { ...pick, edited: "y\n" })).toEqual({ file: "main.tex", accept: true, editedText: "y\n" });
    // Leaving it out keeps the user's version.
    expect(decisionFor(f, { ...pick, include: false })).toEqual({ file: "main.tex", accept: false });
  });

  it("picks whole files for added, deleted and one-hunk files", () => {
    const added = file({ file: "new.tex", baseText: null, newText: "x\ny\n", status: "added", hunks: [h(0, 0, 0, 1, 2)] });
    const deleted = file({ file: "old.tex", newText: null, status: "deleted", hunks: [h(0, 1, 5, 0, 0)] });
    expect(hunkPicking(added)).toBe(false);
    expect(hunkPicking(deleted)).toBe(false);
    expect(hunkPicking(file({ hunks: [h(0, 2, 1, 2, 1)] }))).toBe(false);
    expect(pickedText(deleted, initialPick(deleted))).toBeNull();
    expect(pickedText(added, initialPick(added))).toBe("x\ny\n");
    expect(decisionFor(deleted, initialPick(deleted))).toEqual({ file: "old.tex", accept: true });
  });

  it("builds the decisions for Apply selected, skipping decided files", () => {
    const a = file();
    const b = file({ file: "b.tex", state: "applied" });
    const c = file({ file: "c.tex" });
    const d = selectedDecisions([a, b, c], { "c.tex": { ...initialPick(c), include: false, reason: "No" } });
    expect(d).toEqual([
      { file: "main.tex", accept: true },
      { file: "c.tex", accept: false, reason: "No" },
    ]);
    expect(reasonNotes([a, b, c], d)).toEqual(["Rejected a change to c.tex (Fix typos): No"]);
  });

  it("counts lines", () => {
    expect(lineCounts(file())).toEqual({ added: 3, removed: 2 });
  });
});

describe("review stays in step with the run", () => {
  it("reveals a hunk where the picked text shows it (FE-6)", () => {
    // Hunk 0 adds 10 lines at the top; hunk 1 changes old line 5 (new line 15).
    const hs = [h(0, 0, 0, 1, 10), h(1, 5, 1, 15, 1)];
    expect(hunkRevealLine(hs[1])).toBe(15);
    expect(hunkRevealLine(hs[1], hs, [0, 1])).toBe(15);
    // Hunk 0 unchecked: its 10 lines aren't shown, so hunk 1 sits at line 5.
    expect(hunkRevealLine(hs[1], hs, [1])).toBe(5);
    // A removed block that's kept (unchecked) pushes later hunks down.
    const del = [h(0, 2, 3, 1, 0), h(1, 9, 1, 6, 1)];
    expect(hunkRevealLine(del[1], del, [1])).toBe(9);
    expect(hunkRevealLine(del[0], del, [])).toBe(1);
  });

  it("drops picks for a file the agent wrote again (FE-1)", () => {
    const before = { runId: "r", files: [file()] };
    const picked = { "main.tex": { ...initialPick(before.files[0]), hunks: [1] } };
    // Same change: the pick stays.
    expect(carryPicks({ runId: "r", files: [file()] }, picked, before)["main.tex"].hunks).toEqual([1]);
    // New text and hunks: start again with everything picked.
    const rewritten = file({ newText: "a\nB\nc\nD\nE\nf\n", hunks: [h(0, 2, 1, 2, 1), h(1, 4, 2, 4, 3)] });
    expect(carryPicks({ runId: "r", files: [rewritten] }, picked, before)["main.tex"].hunks).toEqual([0, 1]);
    // A file written after the dialog opened gets its own pick.
    const added = file({ file: "intro.tex", status: "added", baseText: null, newText: "x\n", hunks: [] });
    expect(carryPicks({ runId: "r", files: [file(), added] }, picked, before)["intro.tex"].include).toBe(true);
  });

  it("refetches when the run moves on", () => {
    const s = { status: "running" as const, stepCount: 3, pendingFiles: 1, changedFiles: 1, conflictFiles: 0 };
    expect(changesetStale(s, { ...s })).toBe(false);
    expect(changesetStale(s, { ...s, stepCount: 4 })).toBe(true);
    expect(changesetStale(s, { ...s, status: "awaiting_review" })).toBe(true);
    expect(changesetStale(undefined, s)).toBe(false);
  });
});
