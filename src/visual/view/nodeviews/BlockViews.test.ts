import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { createSession } from "../../core";
import { safeUrl } from "../commands";
import { beginTitle, frameTitle } from "./BlockViews";

function containers(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((n) => {
    if (n.type.name === "container") out.push(n);
    return true;
  });
  return out;
}

describe("Beamer frames and blocks", () => {
  it("reads a title from the \\begin arguments, skipping options and overlays", () => {
    expect(beginTitle("\\begin{frame}{Outline}")).toBe("Outline");
    expect(beginTitle("\\begin{frame}[fragile]{Code}{Sub}")).toBe("Code");
    expect(beginTitle("\\begin{frame}<2->[t]{\\textbf{Bold} title}")).toBe("Bold title");
    expect(beginTitle("\\begin{block}{Note}")).toBe("Note");
    expect(beginTitle("\\begin{frame}")).toBe("");
  });

  it("falls back to \\frametitle inside the frame", () => {
    const text = [
      "\\documentclass{beamer}",
      "\\begin{document}",
      "",
      "\\begin{frame}",
      "  \\frametitle{Results}",
      "  Some text.",
      "\\end{frame}",
      "",
      "\\begin{frame}{Direct}",
      "  \\begin{alertblock}{Careful}",
      "    Hot.",
      "  \\end{alertblock}",
      "\\end{frame}",
      "",
      "\\end{document}",
      "",
    ].join("\n");
    const s = createSession("latex", text);
    const frames = containers(s.doc).filter((n) => n.attrs.kind === "frame");
    expect(frames.map(frameTitle)).toEqual(["Results", "Direct"]);
    const block = containers(s.doc).find((n) => n.attrs.kind === "block")!;
    expect(block.attrs.env).toBe("alertblock");
    expect(beginTitle(block.attrs.begin as string)).toBe("Careful");
  });
});

describe("links", () => {
  it("opens only web and mail links", () => {
    expect(safeUrl("https://example.com/a")).toBe(true);
    expect(safeUrl("http://example.com")).toBe(true);
    expect(safeUrl("mailto:a@b.c")).toBe(true);
    expect(safeUrl("javascript:alert(1)")).toBe(false);
    expect(safeUrl("file:///etc/passwd")).toBe(false);
    expect(safeUrl("data:text/html,x")).toBe(false);
    expect(safeUrl("relative/path")).toBe(false);
  });
});
