// A light model of a tabular environment for grid editing: cell spans, row
// terminators and the column spec. Edits splice only the affected spans and
// copy the spacing style of neighbouring rows and cells.

import type { TabularModel, TabularOp } from "../types";
import { readBraced } from "../context";
import { escapeLatex } from "./escape";
import { parseLatexInline } from "./inline";

interface Row {
  start: number;
  /** Where the "\\" terminator begins, or the content end for a last row without one. */
  termStart: number;
  /** End of "\\" and its optional [len]. */
  termEnd: number;
  /** End of the terminator including following rules and whitespace. */
  end: number;
  cells: { start: number; end: number; text: string }[];
  terminator: string;
}

interface Parsed {
  model: TabularModel;
  rows: Row[];
  specStart: number;
  specEnd: number;
  bodyStart: number;
  bodyEnd: number;
}

const RULES = /^(\s|\\hline\b|\\toprule\b|\\midrule\b|\\bottomrule\b|\\cline\s*\{[^}]*\}|\\cmidrule\s*(\([^)]*\))?\s*\{[^}]*\}|\\addlinespace\b(\[[^\]]*\])?)*/;
const ALLOWED_RULES = /^(\s|\\hline\b|\\toprule\b|\\midrule\b|\\bottomrule\b|\\cline\s*\{[^}]*\})*$/;

function parseFull(src: string): Parsed | null {
  const begin = /\\begin\{(tabular\*?|tabularx)\}/.exec(src);
  if (!begin) return null;
  const env = begin[1];
  let at = begin.index + begin[0].length;
  while (src[at] === " ") at++;
  if (src[at] === "[") {
    const e = src.indexOf("]", at);
    if (e === -1) return null;
    at = e + 1;
  }
  if (env !== "tabular") {
    const w = readBraced(src, at);
    if (!w) return null;
    at = w[1];
  }
  const spec = readBraced(src, at);
  if (!spec) return null;
  const specStart = at + 1;
  const specEnd = spec[1] - 1;
  const bodyStart = spec[1];
  const endTag = `\\end{${env}}`;
  const bodyEnd = src.indexOf(endTag, bodyStart);
  if (bodyEnd === -1) return null;

  let simple = !/\\multicolumn|\\multirow/.test(src.slice(bodyStart, bodyEnd)) && !/\\begin\{tabular/.test(src.slice(bodyStart, bodyEnd));
  const rows: Row[] = [];
  const lead = RULES.exec(src.slice(bodyStart, bodyEnd))![0];
  if (!ALLOWED_RULES.test(lead)) simple = false;
  let rowStart = bodyStart + lead.length;
  let depth = 0;
  let math = false;
  let cellStart = rowStart;
  let cells: Row["cells"] = [];
  const pushCell = (s: number, e: number) => {
    let a = s;
    let b = e;
    while (a < b && /\s/.test(src[a])) a++;
    while (b > a && /\s/.test(src[b - 1])) b--;
    cells.push({ start: a, end: b, text: src.slice(a, b) });
  };
  for (let i = rowStart; i < bodyEnd; i++) {
    const c = src[i];
    if (c === "%") {
      while (i < bodyEnd && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\\" && depth === 0 && !math) {
      pushCell(cellStart, i);
      let termEnd = i + 2;
      if (src[termEnd] === "*") termEnd++;
      const opt = /^\s*\[[^\]]*\]/.exec(src.slice(termEnd, bodyEnd));
      if (opt) termEnd += opt[0].length;
      const rules = RULES.exec(src.slice(termEnd, bodyEnd))![0];
      if (!ALLOWED_RULES.test(rules)) simple = false;
      const end = termEnd + rules.length;
      rows.push({ start: rowStart, termStart: i, termEnd, end, cells, terminator: src.slice(i, end) });
      cells = [];
      rowStart = end;
      cellStart = end;
      i = end - 1;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "$") math = !math;
    else if (c === "&") {
      if (depth !== 0 || math) simple = false;
      else {
        pushCell(cellStart, i);
        cellStart = i + 1;
      }
    }
  }
  if (src.slice(rowStart, bodyEnd).trim() !== "") {
    pushCell(cellStart, bodyEnd);
    let e = bodyEnd;
    while (e > rowStart && /\s/.test(src[e - 1])) e--;
    rows.push({ start: rowStart, termStart: e, termEnd: e, end: bodyEnd, cells, terminator: "" });
  }
  for (const r of rows) for (const cell of r.cells) if (parseLatexInline(cell.text, { gid: 1 }) === null) simple = false;
  const cap = /\\caption\s*(?:\[[^\]]*\])?\s*(?=\{)/.exec(src);
  const caption = cap ? (readBraced(src, cap.index + cap[0].length)?.[0] ?? null) : null;
  return {
    model: { colspec: src.slice(specStart, specEnd), rows: rows.map((r) => ({ cells: r.cells, terminator: r.terminator })), caption, simple },
    rows,
    specStart,
    specEnd,
    bodyStart,
    bodyEnd,
  };
}

/** Start of the line containing `i` (after its "\n"). */
function lineStart(src: string, i: number): number {
  const nl = src.lastIndexOf("\n", i - 1);
  return nl + 1;
}

function indentOf(src: string, i: number): string {
  const ls = lineStart(src, i);
  const m = /^[ \t]*/.exec(src.slice(ls, i));
  return m && m[0].length === i - ls ? m[0] : "";
}

function eolOf(src: string): string {
  return src.includes("\r\n") ? "\r\n" : "\n";
}

/** Separator spelling between cells of a row, e.g. " & ". */
function sepOf(src: string, row: Row): string {
  if (row.cells.length < 2) return " & ";
  return src.slice(row.cells[0].end, row.cells[1].start);
}

function splice(src: string, edits: { at: number; del: number; ins: string }[]): string {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.ins + out.slice(e.at + e.del);
  return out;
}

/** Positions of column tokens in a spec like "|l|c|p{2cm}|". */
function specColumns(spec: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /[lcrXSJLCR]|[pmb]\{[^}]*\}|@\{[^}]*\}|>\{[^}]*\}|<\{[^}]*\}|\*\{\d+\}\{[^}]*\}/g;
  for (const m of spec.matchAll(re)) {
    if (/^[@<>]/.test(m[0])) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

function apply(src: string, op: TabularOp): string {
  const p = parseFull(src);
  if (!p) return src;
  const rows = p.rows;
  const eol = eolOf(src);
  switch (op.kind) {
    case "setCell": {
      const cell = rows[op.r]?.cells[op.c];
      if (!cell) return src;
      return splice(src, [{ at: cell.start, del: cell.end - cell.start, ins: escapeLatex(op.text) }]);
    }
    case "insertRow": {
      const ref = rows[op.at - 1] ?? rows[op.at];
      if (!ref) return src;
      const n = Math.max(1, ref.cells.length);
      const lastCell = ref.cells[ref.cells.length - 1];
      const beforeTerm = lastCell ? src.slice(lastCell.end, ref.termStart) : " ";
      const term = ref.terminator === "" ? "\\\\" : src.slice(ref.termStart, ref.termEnd);
      const row = Array(n).fill("").join(sepOf(src, ref)) + beforeTerm + term;
      const indent = indentOf(src, ref.start);
      if (op.at < rows.length) {
        const at = lineStart(src, rows[op.at].start);
        if (src.slice(at, rows[op.at].start).trim() === "") return splice(src, [{ at, del: 0, ins: indent + row + eol }]);
        return splice(src, [{ at: rows[op.at].start, del: 0, ins: row + " " }]);
      }
      const last = rows[rows.length - 1];
      if (last.terminator === "") return splice(src, [{ at: last.termEnd, del: 0, ins: " \\\\" + eol + indent + row }]);
      return splice(src, [{ at: last.termEnd, del: 0, ins: eol + indent + row }]);
    }
    case "deleteRow": {
      const r = rows[op.r];
      if (!r) return src;
      const ls = lineStart(src, r.start);
      const startsLine = src.slice(ls, r.start).trim() === "";
      const nl = src.indexOf("\n", r.termEnd);
      const restBlank = nl !== -1 && src.slice(r.termEnd, nl).trim() === "";
      if (startsLine && restBlank) return splice(src, [{ at: ls, del: nl + 1 - ls, ins: "" }]);
      return splice(src, [{ at: r.start, del: r.termEnd - r.start, ins: "" }]);
    }
    case "insertCol": {
      const edits: { at: number; del: number; ins: string }[] = [];
      for (const r of rows) {
        const sep = sepOf(src, r);
        if (r.cells.length === 0) continue;
        if (op.at < r.cells.length) edits.push({ at: r.cells[op.at].start, del: 0, ins: sep });
        else edits.push({ at: r.cells[r.cells.length - 1].end, del: 0, ins: sep });
      }
      const cols = specColumns(p.model.colspec);
      if (cols.length > 0) {
        const ref = cols[Math.min(op.at, cols.length - 1)];
        const tok = p.model.colspec.slice(ref.start, ref.end);
        const bar = p.model.colspec[ref.end] === "|" ? "|" : "";
        const at = op.at < cols.length ? ref.start : ref.end + bar.length;
        edits.push({ at: p.specStart + at, del: 0, ins: tok + bar });
      }
      return splice(src, edits);
    }
    case "deleteCol": {
      const edits: { at: number; del: number; ins: string }[] = [];
      for (const r of rows) {
        const cells = r.cells;
        if (op.c >= cells.length || cells.length < 2) continue;
        if (op.c < cells.length - 1) edits.push({ at: cells[op.c].start, del: cells[op.c + 1].start - cells[op.c].start, ins: "" });
        else edits.push({ at: cells[op.c - 1].end, del: cells[op.c].end - cells[op.c - 1].end, ins: "" });
      }
      const cols = specColumns(p.model.colspec);
      const col = cols[op.c];
      if (col && cols.length > 1) {
        const bar = p.model.colspec[col.end] === "|" ? 1 : 0;
        edits.push({ at: p.specStart + col.start, del: col.end - col.start + bar, ins: "" });
      }
      return splice(src, edits);
    }
    case "setCaption": {
      const cap = /\\caption\s*(?:\[[^\]]*\])?\s*(?=\{)/.exec(src);
      if (cap) {
        const at = cap.index + cap[0].length;
        const arg = readBraced(src, at);
        if (!arg) return src;
        return splice(src, [{ at, del: arg[1] - at, ins: "{" + escapeLatex(op.text) + "}" }]);
      }
      const end = /\\end\{table\*?\}/.exec(src);
      if (!end) return src;
      const ls = lineStart(src, end.index);
      return splice(src, [{ at: ls, del: 0, ins: "  \\caption{" + escapeLatex(op.text) + "}" + eol }]);
    }
  }
}

export const tabular = {
  parse(src: string): TabularModel | null {
    return parseFull(src)?.model ?? null;
  },
  apply,
};
