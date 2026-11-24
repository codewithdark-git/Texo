import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { createSession, dialectFor, readContext, serializeNode, type DocContext } from "./index";
import { thesis } from "./__fixtures__/thesis";

const fixtures = import.meta.glob("./__fixtures__/*.{tex,md}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const templates = import.meta.glob("../../../src-tauri/templates/**/*.tex", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Rebuilds the text from the tiling: gaps from the text, blocks from serializeNode. */
function tiled(text: string, dialect: "latex" | "markdown"): string {
  const s = createSession(dialect, text);
  expect(s.verify()).toEqual({ ok: true });
  let joined = "";
  s.doc.forEach((n: PMNode) => (joined += serializeNode(n, dialect)));
  // Every block's own source appears, in order, in the file.
  let pos = 0;
  s.doc.forEach((n: PMNode) => {
    const src = serializeNode(n, dialect);
    const at = text.indexOf(src, pos);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(text.slice(pos, at).trim()).toBe("");
    pos = at + src.length;
  });
  expect(text.slice(pos).trim()).toBe("");
  return joined;
}

/**
 * For a template's \input file: the theorems and other context of its
 * main.tex, as the app supplies them when it opens a chapter on its own.
 */
function templateMainContext(path: string, text: string): Partial<DocContext> | undefined {
  if (/\\begin\s*\{document\}/.test(text)) return undefined;
  const dir = path.slice(0, path.indexOf("/", "../../../src-tauri/templates/".length));
  const main = templates[`${dir}/main.tex`];
  if (main === undefined) return undefined;
  const ctx = readContext("latex", main);
  return {
    docClass: ctx.docClass,
    hasChapters: ctx.hasChapters,
    packages: ctx.packages,
    macros: ctx.macros,
    macrosHash: ctx.macrosHash,
    theorems: ctx.theorems,
    graphicsPaths: ctx.graphicsPaths,
  };
}

function kinds(text: string, dialect: "latex" | "markdown") {
  const s = createSession(dialect, text);
  const counts: Record<string, number> = {};
  s.doc.forEach((n: PMNode) => (counts[n.type.name] = (counts[n.type.name] ?? 0) + 1));
  return { rawRatio: Math.round(s.rawRatio * 100) / 100, counts };
}

describe("golden corpus round trip", () => {
  for (const [path, text] of Object.entries(fixtures)) {
    const dialect = dialectFor(path)!;
    it(`${path} tiles byte for byte`, () => {
      tiled(text, dialect);
      expect(kinds(text, dialect)).toMatchSnapshot();
    });
  }

  for (const [path, text] of Object.entries(templates)) {
    it(`template ${path} round-trips with no raw blocks except image placeholders`, () => {
      tiled(text, "latex");
      // A figure without an image (a placeholder box) stays raw until the
      // user adds a picture; nothing else may.
      const raw: string[] = [];
      createSession("latex", text, { context: templateMainContext(path, text) }).doc.forEach((n) => {
        if (n.type.name === "raw_block" && n.attrs.label !== "Figure") raw.push(String(n.attrs.src).slice(0, 60));
      });
      expect(raw).toEqual([]);
    });
  }

  it("the synthetic thesis round-trips", () => {
    const text = thesis();
    expect(text.length).toBeGreaterThan(240_000);
    tiled(text, "latex");
    expect(kinds(text, "latex")).toMatchSnapshot();
  });
});

describe("structure", () => {
  it("splits the example template into the expected blocks", () => {
    const text = templates["../../../src-tauri/templates/example/main.tex"];
    const s = createSession("latex", text);
    const names: string[] = [];
    s.doc.forEach((n) => names.push(n.type.name));
    expect(names[0]).toBe("preamble");
    expect(names[names.length - 1]).toBe("postamble");
    expect(names).toContain("math_display");
    expect(names).toContain("table_block");
    expect(names.filter((n) => n === "heading")).toHaveLength(4);
  });

  it("parses an \\input chapter with no preamble as body", () => {
    const s = createSession("latex", fixtures["./__fixtures__/chapter-input.tex"]);
    expect(s.doc.firstChild!.type.name).toBe("heading");
    expect(s.doc.firstChild!.attrs.trail).toBe("\\label{ch:bg}");
    const cmds: string[] = [];
    s.doc.forEach((n) => n.type.name === "command_block" && cmds.push(`${n.attrs.kind}:${n.attrs.target}`));
    expect(cmds).toEqual(["input:sections/more"]);
    // \clearpage is a page break the view draws, not a command chip.
    const spacers: string[] = [];
    s.doc.forEach((n) => n.type.name === "spacer_block" && spacers.push(`${n.attrs.kind}:${n.attrs.src}`));
    expect(spacers).toEqual(["pagebreak:\\clearpage"]);
  });

  it("keeps CRLF, a BOM and astral characters exactly", () => {
    const text = fixtures["./__fixtures__/crlf-unicode.tex"];
    expect(text.startsWith("﻿")).toBe(true);
    expect(text.includes("\r\n")).toBe(true);
    const s = createSession("latex", text);
    expect(s.context.eol).toBe("\r\n");
    expect(s.verify()).toEqual({ ok: true });
  });

  it("makes lists, a figure and a table from structured sources", () => {
    const lists = createSession("latex", fixtures["./__fixtures__/lists.tex"]);
    const ln: string[] = [];
    lists.doc.forEach((n) => ln.push(n.type.name));
    expect(ln.filter((n) => n === "list")).toHaveLength(2);
    expect(ln).toContain("comment_block");
    const floats = createSession("latex", fixtures["./__fixtures__/floats.tex"]);
    const fn: string[] = [];
    floats.doc.forEach((n) => fn.push(n.type.name + (n.type.name === "raw_block" ? ":" + n.attrs.label : "")));
    expect(fn).toContain("figure");
    expect(fn).toContain("raw_block:Figure");
    expect(fn).toContain("table_block");
  });

  it("dialectFor picks by extension", () => {
    expect(dialectFor("a/b.TEX")).toBe("latex");
    expect(dialectFor("x.ltx")).toBe("latex");
    expect(dialectFor("README.md")).toBe("markdown");
    expect(dialectFor("notes.markdown")).toBe("markdown");
    expect(dialectFor("refs.bib")).toBeNull();
  });
});
