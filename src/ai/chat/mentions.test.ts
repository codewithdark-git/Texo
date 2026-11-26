import { describe, expect, it } from "vitest";
import { findMentions } from "../../lib/chatApi";
import { applyMention, mentionableFiles, mentionQuery, suggestMentions } from "./mentions";

describe("mentionQuery", () => {
  it("finds the mention being typed", () => {
    expect(mentionQuery("look at @sec", 12)).toEqual({ start: 8, query: "sec" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("see @chapters/in", 16)).toEqual({ start: 4, query: "chapters/in" });
  });

  it("ignores e-mail addresses and finished words", () => {
    expect(mentionQuery("mail me@host", 12)).toBeNull();
    expect(mentionQuery("@main.tex and more", 18)).toBeNull();
    expect(mentionQuery("plain text", 5)).toBeNull();
  });
});

describe("mentionable files and suggestions", () => {
  const files = [
    { path: "main.tex", isDir: false, size: 1 },
    { path: "sections", isDir: true, size: 0 },
    { path: "sections/intro.tex", isDir: false, size: 1 },
    { path: "figures/plot.png", isDir: false, size: 1 },
    { path: "my notes.txt", isDir: false, size: 1 },
    { path: "refs.bib", isDir: false, size: 1 },
  ];

  it("offers text files without spaces", () => {
    expect(mentionableFiles(files)).toEqual(["main.tex", "sections/intro.tex", "refs.bib"]);
  });

  it("ranks by fuzzy match", () => {
    expect(suggestMentions(mentionableFiles(files), "intro")[0]).toBe("sections/intro.tex");
    expect(suggestMentions(mentionableFiles(files), "")).toHaveLength(3);
  });
});

describe("applyMention", () => {
  it("replaces the typed word and leaves a space", () => {
    const text = "check @int please";
    const q = mentionQuery(text, 10)!;
    const out = applyMention(text, q, 10, "sections/intro.tex");
    expect(out.text).toBe("check @sections/intro.tex please");
    expect(out.caret).toBe("check @sections/intro.tex ".length);
    expect(findMentions(out.text)).toEqual(["sections/intro.tex"]);
  });

  it("adds a space at the end of the text", () => {
    const out = applyMention("@ma", { start: 0, query: "ma" }, 3, "main.tex");
    expect(out.text).toBe("@main.tex ");
    expect(out.caret).toBe(10);
  });
});
