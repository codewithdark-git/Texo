import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { createSession, helpersFor, schema, semEq, serializeNode, type Dialect } from "./index";
import { codecFor } from "./dialects";

const fixtures = import.meta.glob("./__fixtures__/*.{tex,md}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const texFixtures = Object.entries(fixtures).filter(([p]) => p.endsWith(".tex")).map(([, t]) => t);
const mdFixtures = Object.entries(fixtures).filter(([p]) => p.endsWith(".md")).map(([, t]) => t);

const LATEX_TOKENS: [number, string][] = [
  [20, "word "],
  [8, " "],
  [8, "\n"],
  [6, "\n\n"],
  [2, "\r\n"],
  [1, "\t"],
  [5, "{"],
  [5, "}"],
  [3, "["],
  [3, "]"],
  [4, "$"],
  [2, "$$"],
  [2, "\\["],
  [2, "\\]"],
  [2, "\\("],
  [2, "\\)"],
  [3, "% comment"],
  [3, "\\textbf{"],
  [2, "\\emph{"],
  [2, "{\\bf "],
  [2, "\\href{u}{"],
  [2, "\\cite{k}"],
  [2, "\\ref{r}"],
  [2, "\\label{l}"],
  [2, "\\footnote{"],
  [2, "\\section{"],
  [1, "\\subsection*[s]{"],
  [2, "\\begin{itemize}"],
  [2, "\\item "],
  [2, "\\end{itemize}"],
  [1, "\\begin{equation}"],
  [1, "\\end{equation}"],
  [1, "\\begin{quote}"],
  [1, "\\end{quote}"],
  [1, "\\begin{figure}\\includegraphics{a}\\caption{c}"],
  [1, "\\end{figure}"],
  [1, "\\begin{verbatim}"],
  [1, "\\end{verbatim}"],
  [1, "\\begin{document}"],
  [1, "\\end{document}"],
  [1, "\\verb|{|"],
  [2, "\\\\"],
  [2, "~"],
  [2, "--"],
  [2, "``"],
  [2, "''"],
  [2, "&"],
  [1, "#"],
  [1, "^"],
  [1, "_"],
  [2, "\\%"],
  [1, "\\LaTeX{}"],
  [1, "\\foo"],
  [1, "\\maketitle"],
  [1, "\\input{x}"],
  [1, "é"],
  [1, "中"],
  [1, "😀"],
  // Page look: spacing, breaks, sizes, colours and alignment.
  [2, "\\vspace{6pt}"],
  [1, "\\vspace*{"],
  [1, "\\hspace{1em}"],
  [2, "\\noindent"],
  [2, "\\quad"],
  [1, "\\qquad "],
  [1, "\\enspace"],
  [1, "\\,"],
  [1, "\\;"],
  [1, "\\!"],
  [2, "{,}"],
  [1, "\\newpage"],
  [1, "\\clearpage"],
  [1, "\\pagebreak[4]"],
  [1, "\\linebreak"],
  [1, "\\hfill"],
  [1, "\\medskip"],
  [1, "\\bigskip"],
  [2, "\\par"],
  [1, "\\\\[2pt]"],
  [2, "{\\LARGE\\bfseries "],
  [2, "{\\large "],
  [1, "{\\small "],
  [2, "\\textcolor{red}{"],
  [1, "{\\color{blue} "],
  [1, "\\textsc{"],
  [1, "\\begin{center}"],
  [1, "\\end{center}"],
  [1, "\\begin{flushright}"],
  [1, "\\end{flushright}"],
];

const MD_TOKENS: [number, string][] = [
  [20, "word "],
  [8, " "],
  [8, "\n"],
  [6, "\n\n"],
  [1, "\r\n"],
  [3, "*"],
  [3, "_"],
  [2, "**"],
  [2, "`"],
  [2, "~~"],
  [3, "# "],
  [1, "## "],
  [3, "- "],
  [2, "1. "],
  [2, "  "],
  [2, "> "],
  [2, "["],
  [2, "]"],
  [2, "(u)"],
  [1, "<http://a>"],
  [1, "![i](p.png)"],
  [1, "```\n"],
  [1, "$"],
  [1, "$$"],
  [1, "---"],
  [1, "| a | b |\n|---|---|\n"],
  [1, "<div>"],
  [1, "</div>"],
  [1, "\\*"],
  [1, "&amp;"],
  [1, "[r]: http://x\n"],
  [1, "😀"],
];

function soup(tokens: [number, string][]) {
  return fc
    .array(fc.oneof(...tokens.map(([w, t]) => ({ weight: w, arbitrary: fc.constant(t) }))), { maxLength: 80 })
    .map((xs) => xs.join(""));
}

/** Every node under `node` that is structured must serialize to exactly what its parent placed. */
function checkTree(dialect: Dialect, text: string) {
  const s = createSession(dialect, text);
  const v = s.verify();
  expect(v).toEqual({ ok: true });
  // Structural serialization (ignoring the registry) of every top-level child appears in order.
  const codec = codecFor(dialect);
  let pos = 0;
  s.doc.forEach((n: PMNode) => {
    if (n.type.name === "paragraph" && n.content.size === 0) return;
    const src = codec.serialize(n, { useSrc: false });
    const at = text.indexOf(src, pos);
    expect(at).toBeGreaterThanOrEqual(pos);
    expect(text.slice(pos, at).trim()).toBe("");
    expect(serializeNode(n, dialect)).toBe(src);
    pos = at + src.length;
  });
}

function mutate(text: string, ops: { at: number; kind: number; ch: string }[]): string {
  let t = text;
  for (const op of ops) {
    if (t.length === 0) break;
    const at = op.at % t.length;
    if (op.kind === 0) t = t.slice(0, at) + t.slice(at + 1);
    else if (op.kind === 1) t = t.slice(0, at) + op.ch + t.slice(at);
    else t = t.slice(0, at) + op.ch + t.slice(at + 1);
  }
  return t;
}

const opArb = fc.record({
  at: fc.nat(),
  kind: fc.integer({ min: 0, max: 2 }),
  ch: fc.constantFrom("{", "}", "$", "\\", "%", "\n", "\n\n", " ", "x", "*", "_", "`", "[", "]", "-", "#", ">", "&", "\r"),
});

describe("fuzz: parsing never throws and always tiles", () => {
  it("latex token soup", () => {
    fc.assert(fc.property(soup(LATEX_TOKENS), (text) => checkTree("latex", text)), { numRuns: 400 });
  });

  it("markdown token soup", () => {
    fc.assert(fc.property(soup(MD_TOKENS), (text) => checkTree("markdown", text)), { numRuns: 400 });
  });

  it("random mutations of latex fixtures", () => {
    fc.assert(
      fc.property(fc.constantFrom(...texFixtures), fc.array(opArb, { minLength: 1, maxLength: 6 }), (text, ops) => checkTree("latex", mutate(text, ops))),
      { numRuns: 200 },
    );
  });

  it("random mutations of markdown fixtures", () => {
    fc.assert(
      fc.property(fc.constantFrom(...mdFixtures), fc.array(opArb, { minLength: 1, maxLength: 6 }), (text, ops) => checkTree("markdown", mutate(text, ops))),
      { numRuns: 200 },
    );
  });
});

describe("fuzz: never reinterpret after deleting a brace or \\end", () => {
  it("keeps every structured node byte-exact", () => {
    const sites = (text: string) => {
      const out: [number, number][] = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "{" || text[i] === "}") out.push([i, 1]);
        if (text.startsWith("\\end", i)) out.push([i, 4]);
      }
      return out;
    };
    fc.assert(
      fc.property(fc.constantFrom(...texFixtures), fc.nat(), (text, k) => {
        const s = sites(text);
        const [at, len] = s[k % s.length];
        checkTree("latex", text.slice(0, at) + text.slice(at + len));
      }),
      { numRuns: 300 },
    );
  });
});

describe("fuzz: inbound edits", () => {
  it("syncFromText after random edits matches a fresh parse", () => {
    fc.assert(
      fc.property(fc.constantFrom(...texFixtures), fc.array(opArb, { minLength: 1, maxLength: 4 }), (text, ops) => {
        const s = createSession("latex", text);
        const next = mutate(text, ops);
        s.syncFromText(next);
        expect(s.verify()).toEqual({ ok: true });
        const fresh = createSession("latex", next);
        const a: string[] = [];
        const b: string[] = [];
        s.doc.forEach((n) => a.push(serializeNode(n, "latex")));
        fresh.doc.forEach((n) => b.push(serializeNode(n, "latex")));
        expect(a).toEqual(b);
      }),
      { numRuns: 200 },
    );
  });
});

describe("fuzz: outbound styling", () => {
  it("a size, colour or bold change either plans exactly or is refused", () => {
    const ctx = createSession("latex", "").context;
    const helpers = helpersFor("latex");
    const styles = [
      () => schema.marks.size.create(helpers.sizeMark("large", ctx)!),
      () => schema.marks.size.create(helpers.sizeMark("small", ctx)!),
      () => schema.marks.color.create(helpers.colorMark("red", ctx)!),
      () => schema.marks.bold.create(helpers.newMark("bold", ctx)!),
    ];
    const removable = [schema.marks.size, schema.marks.color, schema.marks.bold, schema.marks.italic];
    fc.assert(
      fc.property(fc.constantFrom(...texFixtures), fc.nat(), fc.nat(), fc.nat(), fc.nat({ max: 7 }), (text, k, x, y, op) => {
        const s = createSession("latex", text);
        const blocks: [number, number][] = [];
        s.doc.descendants((n, pos) => {
          if (n.isTextblock && !n.type.spec.code && n.content.size > 0) blocks.push([pos + 1, pos + 1 + n.content.size]);
          return true;
        });
        if (blocks.length === 0) return;
        const [lo, hi] = blocks[k % blocks.length];
        const a = lo + (x % (hi - lo));
        const b = a + 1 + (y % (hi - a));
        const tr = new Transform(s.doc);
        if (op < 4) tr.addMark(a, b, styles[op]());
        else tr.removeMark(a, b, removable[op - 4]);
        const res = s.plan(tr.doc);
        if (!res.ok) return;
        // Nothing outside the change moved, and the new text means what the doc shows.
        const fresh = createSession("latex", res.newText);
        const want: PMNode[] = [];
        const got: PMNode[] = [];
        tr.doc.forEach((n) => !(n.type.name === "paragraph" && n.content.size === 0) && want.push(n));
        fresh.doc.forEach((n) => !(n.type.name === "paragraph" && n.content.size === 0) && got.push(n));
        expect(got.length).toBe(want.length);
        got.forEach((n, i) => expect(semEq(n, want[i])).toBe(true));
        s.commit(tr.doc, res.newText);
        expect(s.verify()).toEqual({ ok: true });
      }),
      { numRuns: 300 },
    );
  });
});

describe("fuzz: outbound typing", () => {
  it("any planned edit re-parses to the doc it came from", () => {
    const all = [...texFixtures.map((t) => ["latex", t] as const), ...mdFixtures.map((t) => ["markdown", t] as const)];
    fc.assert(
      fc.property(
        fc.constantFrom(...all),
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom("a", " ", "%", "$", "{", "}", "\\", "_", "*", "-", "#", "`", "~", "&", "[") }),
        ([dialect, text], k, typed) => {
          const s = createSession(dialect, text);
          const spots: number[] = [];
          s.doc.descendants((n, pos) => {
            if (n.isTextblock && !n.type.spec.code) spots.push(pos + 1 + Math.floor(n.content.size / 2));
            return true;
          });
          if (spots.length === 0) return;
          const at = spots[k % spots.length];
          const $at = s.doc.resolve(at);
          if (!$at.parent.inlineContent) return;
          const doc = new Transform(s.doc).insert(at, schema.text(typed, $at.marks())).doc;
          const res = s.plan(doc);
          if (!res.ok) return;
          const fresh = createSession(dialect, res.newText);
          const a: PMNode[] = [];
          const b: PMNode[] = [];
          fresh.doc.forEach((n) => a.push(n));
          doc.forEach((n) => b.push(n));
          expect(a.length).toBe(b.length);
          a.forEach((n, i) => expect(semEq(n, b[i])).toBe(true));
          s.commit(doc, res.newText);
          expect(s.verify()).toEqual({ ok: true });
        },
      ),
      { numRuns: 300 },
    );
  });
});
