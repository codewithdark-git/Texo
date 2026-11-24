// LaTeX inline parsing: the content of a paragraph, heading or caption becomes
// text with marks, glyphs, maths and chips. Anything not understood becomes a
// raw_inline chip holding its exact source. Every mark group is checked to
// serialize back to its own source; a group that does not is demoted to raw.

import type { Mark, Node as PMNode } from "prosemirror-model";
import { schema } from "../schema";
import { serializeInlineWith } from "../serialize";
import { latexCodec } from "./escape";
import { scan, T, type Token } from "./scanner";
import { COLOR_NAME, isSizeCmd, SPACING_WORDS, spacingAmount } from "./style";

/** Per-block state: mark group ids count from 1 in each block. */
export interface InlineState {
  gid: number;
}

/** Thrown internally when the content cannot be inline (unclosed maths or group). */
class InlineFail extends Error {}

const MARK_COMMANDS: Record<string, string> = {
  textbf: "bold",
  textit: "italic",
  emph: "italic",
  underline: "underline",
  uline: "underline",
  texttt: "code",
  textsc: "smallcaps",
  textsf: "sans",
  textsuperscript: "sup",
  textsubscript: "sub",
};

const DECLARATIONS: Record<string, string> = {
  bfseries: "bold",
  bf: "bold",
  itshape: "italic",
  it: "italic",
  em: "italic",
  ttfamily: "code",
  scshape: "smallcaps",
  sffamily: "sans",
};

const WORD_GLYPHS: Record<string, string> = {
  ldots: "…",
  dots: "…",
  textellipsis: "…",
  LaTeX: "LaTeX",
  TeX: "TeX",
  today: "today",
  textbackslash: "\\",
  textasciitilde: "~",
  textasciicircum: "^",
  textasciigrave: "`",
};

const SYMBOL_GLYPHS: Record<string, string> = {
  "\\%": "%",
  "\\&": "&",
  "\\#": "#",
  "\\_": "_",
  "\\$": "$",
  "\\{": "{",
  "\\}": "}",
  "\\,": " ",
  "\\ ": " ",
  "\\@": "",
  "\\/": "",
  "\\-": "",
  // A negative thin space: nothing to show.
  "\\!": "",
  "\\:": " ",
  "\\;": " ",
};

/** One declaration at the start of a {..} group: {\large ..}, {\bfseries ..}, {\color{red} ..}. */
interface Declaration {
  type: string;
  extra: Record<string, unknown>;
  /** Token range of the declaration and the one space after it. */
  a: number;
  b: number;
}

const CITE = /^(cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite|Cite|Parencite|Textcite|Autocite)\*?$/;
const REF = /^(ref|eqref|autoref|cref|Cref|pageref|nameref|vref)\*?$/;

/** An intermediate inline item, before marks are applied. */
type Item = { kind: "node"; node: PMNode } | { kind: "group"; mark: Mark; src: string; items: Item[]; label: string };

/** Index of the token closing the group opened at k (LBrace/RBrace), or -1. */
export function matchBrace(toks: Token[], k: number, end = toks.length): number {
  let depth = 0;
  for (let i = k; i < end; i++) {
    const t = toks[i].t;
    if (t === T.LBrace) depth++;
    else if (t === T.RBrace && --depth === 0) return i;
  }
  return -1;
}

/** Index of the "]" closing an optional argument opened at k, at brace depth 0, or -1. */
export function matchBracket(toks: Token[], k: number, end = toks.length): number {
  let depth = 0;
  for (let i = k + 1; i < end; i++) {
    const t = toks[i].t;
    if (t === T.LBrace) depth++;
    else if (t === T.RBrace) depth--;
    else if (t === T.RBracket && depth === 0) return i;
    else if (t === T.Parbreak) return -1;
  }
  return -1;
}

/** Index of the first token after a command and its directly adjacent [..] and {..} groups. */
export function skipArgs(toks: Token[], k: number, end = toks.length): number {
  let i = k;
  for (;;) {
    if (i < end && toks[i].t === T.LBracket) {
      const c = matchBracket(toks, i, end);
      if (c === -1) return i;
      i = c + 1;
    } else if (i < end && toks[i].t === T.LBrace) {
      const c = matchBrace(toks, i, end);
      if (c === -1) return i;
      i = c + 1;
    } else return i;
  }
}

/** The closing math token for an opener at k, at brace depth 0, or -1 (also on a parbreak). */
function matchMath(toks: Token[], k: number, close: number, end: number): number {
  let depth = 0;
  for (let i = k + 1; i < end; i++) {
    const t = toks[i].t;
    if (t === T.Parbreak) return -1;
    if (t === T.LBrace) depth++;
    else if (t === T.RBrace) depth--;
    else if (t === close && depth <= 0) return i;
  }
  return -1;
}

function atom(type: string, attrs: Record<string, unknown>): PMNode {
  // Inline atoms keep their exact source in attrs, so they need no SRC entry.
  return schema.nodes[type].create(attrs);
}

function raw(src: string, label: string): Item {
  return { kind: "node", node: atom("raw_inline", { src, label }) };
}

/** Appends text, merging it into a directly preceding text item. */
function pushText(items: Item[], s: string) {
  const last = items[items.length - 1];
  if (last && last.kind === "node" && last.node.isText) items[items.length - 1] = { kind: "node", node: schema.text(last.node.text + s) };
  else items.push({ kind: "node", node: schema.text(s) });
}

function splitKeys(s: string): string[] {
  return s
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
}

class Parser {
  toks: Token[];
  constructor(
    readonly src: string,
    readonly state: InlineState,
  ) {
    this.toks = scan(src);
  }

  s(t: Token) {
    return this.src.slice(t.s, t.e);
  }

  span(a: number, b: number) {
    // Source from the start of token a to the end of token b - 1.
    if (b <= a) return "";
    return this.src.slice(this.toks[a].s, this.toks[b - 1].e);
  }

  /** Parses tokens [k, end) into items; `marks` are the open mark types, for same-type nesting. */
  seq(k: number, end: number, marks: string[]): Item[] {
    const items: Item[] = [];
    const toks = this.toks;
    while (k < end) {
      const tok = toks[k];
      switch (tok.t) {
        case T.Text:
        case T.Space:
        case T.LBracket:
        case T.RBracket:
          pushText(items, this.s(tok));
          k++;
          continue;
        case T.Newline: {
          let e = k + 1;
          if (e < end && toks[e].t === T.Space) e++;
          items.push({ kind: "node", node: atom("softbreak", { src: this.span(k, e) }) });
          k = e;
          continue;
        }
        case T.Parbreak:
          items.push(raw(this.s(tok), "¶"));
          k++;
          continue;
        case T.Comment: {
          let e = k + 1;
          if (e < end && toks[e].t === T.Newline) {
            e++;
            if (e < end && toks[e].t === T.Space) e++;
          }
          items.push(raw(this.span(k, e), "%"));
          k = e;
          continue;
        }
        case T.Special: {
          const c = this.s(tok);
          if (c === "~") items.push({ kind: "node", node: atom("glyph", { src: "~", display: " " }) });
          else items.push(raw(c, c));
          k++;
          continue;
        }
        case T.Punct:
          this.punct(this.s(tok), items);
          k++;
          continue;
        case T.Dollar:
        case T.DoubleDollar:
        case T.ParenOpen:
        case T.BracketOpen: {
          const closeType = tok.t === T.ParenOpen ? T.ParenClose : tok.t === T.BracketOpen ? T.BracketClose : tok.t;
          const c = matchMath(toks, k, closeType, end);
          if (c === -1) throw new InlineFail("unclosed maths");
          const body = this.src.slice(tok.e, toks[c].s);
          items.push({ kind: "node", node: atom("math_inline", { open: this.s(tok), body, close: this.s(toks[c]) }) });
          k = c + 1;
          continue;
        }
        case T.LBrace:
          k = this.brace(k, end, marks, items);
          continue;
        case T.RBrace:
          throw new InlineFail("unbalanced }");
        case T.Word:
          k = this.word(k, end, marks, items);
          continue;
        case T.Symbol:
          k = this.symbol(k, end, items);
          continue;
        default: {
          // ParenClose, BracketClose, Verb, Opaque, DoubleDollar strays.
          const label = tok.t === T.Verb ? "\\verb" : this.s(tok);
          items.push(raw(this.s(tok), label));
          k++;
        }
      }
    }
    return items;
  }

  punct(p: string, items: Item[]) {
    const ch = p[0];
    let i = 0;
    while (i < p.length) {
      const left = p.length - i;
      if (ch === "-") {
        const n = left >= 3 ? 3 : left;
        if (n === 1) pushText(items, "-");
        else items.push({ kind: "node", node: atom("glyph", { src: "-".repeat(n), display: n === 3 ? "—" : "–" }) });
        i += n;
      } else {
        const n = left >= 2 ? 2 : 1;
        if (ch === "'" && n === 1) pushText(items, "'");
        else {
          const display = ch === "`" ? (n === 2 ? "“" : "‘") : "”";
          items.push({ kind: "node", node: atom("glyph", { src: ch.repeat(n), display }) });
        }
        i += n;
      }
    }
  }

  brace(k: number, end: number, marks: string[], items: Item[]): number {
    const toks = this.toks;
    const c = matchBrace(toks, k, end);
    if (c === -1) throw new InlineFail("unclosed {");
    if (c === k + 1) {
      items.push({ kind: "node", node: atom("glyph", { src: "{}", display: "" }) });
      return c + 1;
    }
    // {,} and {.}: a decimal mark kept tight in numbers such as 9{,}577.
    if (c === k + 2 && toks[k + 1].t === T.Text) {
      const ch = this.s(toks[k + 1]);
      if (ch === "," || ch === ".") {
        items.push({ kind: "node", node: atom("glyph", { src: "{" + ch + "}", display: ch }) });
        return c + 1;
      }
    }
    const run = this.declarations(k + 1, c);
    if (run && run[run.length - 1].b < c) {
      const types = run.map((d) => d.type);
      if (new Set(types).size === types.length && !types.some((t) => marks.includes(t))) {
        this.declGroups(run, k, c, marks, items);
        return c + 1;
      }
    }
    items.push(raw(this.span(k, c + 1), "{…}"));
    return c + 1;
  }

  /** The declarations that open a group at token i (up to its closing brace c), or null. */
  declarations(i: number, c: number): Declaration[] | null {
    const toks = this.toks;
    const run: Declaration[] = [];
    while (i < c && toks[i].t === T.Word) {
      const name = this.s(toks[i]).slice(1);
      let type: string;
      let extra: Record<string, unknown> = {};
      let e = i + 1;
      if (isSizeCmd(name)) {
        type = "size";
        extra = { cmd: name };
      } else if (DECLARATIONS[name]) type = DECLARATIONS[name];
      else if (name === "color") {
        const col = this.colorArgs(e, c);
        if (!col) break;
        type = "color";
        extra = { color: col.color, model: col.model };
        e = col.end;
      } else break;
      if (e < c && toks[e].t === T.Space) e++;
      run.push({ type, extra, a: i, b: e });
      i = e;
    }
    return run.length > 0 ? run : null;
  }

  /**
   * {\LARGE\bfseries Title}: one mark per declaration, nested in order. The
   * first carries the braces ("{\LARGE" .. "}"); the others open with their
   * own spelling and close with nothing, since the group's brace ends them.
   */
  declGroups(run: Declaration[], k: number, c: number, marks: string[], items: Item[]) {
    const gids = run.map(() => this.state.gid++);
    let inner = this.seq(run[run.length - 1].b, c, [...marks, ...run.map((d) => d.type)]);
    if (inner.length === 0) {
      items.push(raw(this.span(k, c + 1), "{…}"));
      return;
    }
    for (let j = run.length - 1; j >= 0; j--) {
      const d = run[j];
      const open = j === 0 ? this.span(k, d.b) : this.span(d.a, d.b);
      const attrs = { open, close: j === 0 ? "}" : "", gid: gids[j], depth: marks.length + j, ...d.extra };
      const src = j === 0 ? this.span(k, c + 1) : this.span(d.a, c);
      inner = [{ kind: "group", mark: schema.marks[d.type].create(attrs), src, items: inner, label: open.trim() }];
    }
    items.push(...inner);
  }

  /** The [model]{spec} arguments of \color or \textcolor at token i, or null when not a plain colour. */
  colorArgs(i: number, end: number): { model: string; color: string; end: number } | null {
    const toks = this.toks;
    let model = "";
    if (i < end && toks[i].t === T.LBracket) {
      const c = matchBracket(toks, i, end);
      if (c === -1) return null;
      model = this.src.slice(toks[i].e, toks[c].s);
      if (!/^[A-Za-z]+$/.test(model)) return null;
      i = c + 1;
    }
    if (i >= end || toks[i].t !== T.LBrace) return null;
    const c = matchBrace(toks, i, end);
    if (c === -1) return null;
    const color = this.src.slice(toks[i].e, toks[c].s);
    if (model === "" ? !COLOR_NAME.test(color) : !/^[A-Za-z0-9., ]+$/.test(color)) return null;
    return { model, color, end: c + 1 };
  }

  /** Builds a mark group over tokens [a, b), or a raw chip if it is empty or does not round-trip. */
  group(type: string, open: string, close: string, extra: Record<string, unknown> | null, a: number, b: number, marks: string[], items: Item[], src: string) {
    const depth = marks.length;
    const gid = this.state.gid++;
    const attrs: Record<string, unknown> = { open, close, gid, depth, ...extra };
    const inner = this.seq(a, b, [...marks, type]);
    if (inner.length === 0) {
      items.push(raw(src, open.trim()));
      return;
    }
    items.push({ kind: "group", mark: schema.marks[type].create(attrs), src, items: inner, label: open.trim() });
  }

  word(k: number, end: number, marks: string[], items: Item[]): number {
    const toks = this.toks;
    const tok = toks[k];
    const full = this.s(tok);
    const name = full.slice(1);
    const bare = name.endsWith("*") ? name.slice(0, -1) : name;
    const markType = MARK_COMMANDS[name];
    if (markType) {
      let b = k + 1;
      if (b < end && toks[b].t === T.Space) b++;
      if (b < end && toks[b].t === T.LBrace) {
        const c = matchBrace(toks, b, end);
        if (c === -1) throw new InlineFail("unclosed {");
        const src = this.span(k, c + 1);
        if (marks.includes(markType)) items.push(raw(src, full));
        else this.group(markType, this.span(k, b + 1), "}", null, b + 1, c, marks, items, src);
        return c + 1;
      }
    }
    if (name === "href" && k + 1 < end && toks[k + 1].t === T.LBrace) {
      const u = matchBrace(toks, k + 1, end);
      if (u !== -1 && u + 1 < end && toks[u + 1].t === T.LBrace) {
        const c = matchBrace(toks, u + 1, end);
        if (c !== -1) {
          const src = this.span(k, c + 1);
          const href = this.src.slice(toks[k + 1].e, toks[u].s);
          if (marks.includes("link")) items.push(raw(src, "\\href"));
          else this.group("link", this.span(k, u + 2), "}", { href }, u + 2, c, marks, items, src);
          return c + 1;
        }
      }
    }
    if (name === "textcolor") {
      const col = this.colorArgs(k + 1, end);
      if (col && col.end < end && toks[col.end].t === T.LBrace) {
        const c = matchBrace(toks, col.end, end);
        if (c !== -1) {
          const src = this.span(k, c + 1);
          if (marks.includes("color")) items.push(raw(src, "\\textcolor"));
          else this.group("color", this.span(k, col.end + 1), "}", { color: col.color, model: col.model }, col.end + 1, c, marks, items, src);
          return c + 1;
        }
      }
    }
    const spacing = SPACING_WORDS[name];
    if (spacing) {
      const e = this.spacingEnd(k + 1, end, spacing.arg);
      if (e !== -1) {
        const src = this.span(k, e);
        items.push({ kind: "node", node: atom("spacing", { src, kind: spacing.kind, amount: spacingAmount(src) }) });
        return e;
      }
    }
    if (WORD_GLYPHS[name] !== undefined) {
      let e = k + 1;
      if (e + 1 < end && toks[e].t === T.LBrace && toks[e + 1].t === T.RBrace) e += 2;
      items.push({ kind: "node", node: atom("glyph", { src: this.span(k, e), display: WORD_GLYPHS[name] }) });
      return e;
    }
    const e = skipArgs(toks, k + 1, end);
    const src = this.span(k, e);
    const argOf = (i: number) => this.src.slice(toks[i].e, toks[matchBrace(toks, i, end)].s);
    if (CITE.test(name) && e > k + 1 && toks[e - 1].t === T.RBrace) {
      // Up to two [..] then exactly one {keys}.
      let i = k + 1;
      let opts = 0;
      while (i < e && toks[i].t === T.LBracket) {
        i = matchBracket(toks, i, end) + 1;
        opts++;
      }
      if (opts <= 2 && toks[i].t === T.LBrace && matchBrace(toks, i, end) === e - 1) {
        items.push({ kind: "node", node: atom("cite", { src, cmd: bare, keys: splitKeys(argOf(i)) }) });
        return e;
      }
    }
    const oneArg = e > k + 1 && toks[k + 1].t === T.LBrace && matchBrace(toks, k + 1, end) === e - 1;
    if (REF.test(name) && oneArg) {
      items.push({ kind: "node", node: atom("ref", { src, cmd: bare, keys: splitKeys(argOf(k + 1)) }) });
      return e;
    }
    if (name === "label" && oneArg) {
      items.push({ kind: "node", node: atom("label", { src, key: argOf(k + 1) }) });
      return e;
    }
    if (name === "url" && oneArg) {
      items.push({ kind: "node", node: atom("url", { src, url: argOf(k + 1) }) });
      return e;
    }
    // \thanks (in a title block) is a footnote too, and keeps its name when edited.
    if ((name === "footnote" || name === "thanks") && e > k + 1 && toks[e - 1].t === T.RBrace) {
      let i = k + 1;
      if (toks[i].t === T.LBracket) i = matchBracket(toks, i, end) + 1;
      if (toks[i].t === T.LBrace && matchBrace(toks, i, end) === e - 1) {
        items.push({ kind: "node", node: atom("footnote", { src, body: argOf(i) }) });
        return e;
      }
    }
    items.push(raw(src, "\\" + bare));
    return e;
  }

  /**
   * The end of a spacing command's arguments starting at token i, or -1 when
   * a required {length} is missing. Without arguments, the spaces after it
   * belong to it too: TeX swallows them, so Visual mode must not show them.
   */
  spacingEnd(i: number, end: number, arg: "brace" | "opt" | "none"): number {
    const toks = this.toks;
    if (arg === "brace") {
      if (i >= end || toks[i].t !== T.LBrace) return -1;
      const c = matchBrace(toks, i, end);
      return c === -1 ? -1 : c + 1;
    }
    if (arg === "opt" && i < end && toks[i].t === T.LBracket) {
      const c = matchBracket(toks, i, end);
      if (c !== -1) return c + 1;
    }
    return this.eatSpace(i, end);
  }

  /** Token i, or the one after it when it is a space not followed by "[" (which would read as an argument). */
  eatSpace(i: number, end: number): number {
    const toks = this.toks;
    if (i < end && toks[i].t === T.Space && !(i + 1 < end && toks[i + 1].t === T.LBracket)) return i + 1;
    return i;
  }

  symbol(k: number, end: number, items: Item[]): number {
    const toks = this.toks;
    const sym = this.s(toks[k]);
    if (SYMBOL_GLYPHS[sym] !== undefined) {
      items.push({ kind: "node", node: atom("glyph", { src: sym, display: SYMBOL_GLYPHS[sym] }) });
      return k + 1;
    }
    if ((sym === "\\^" || sym === "\\~") && k + 2 < end && toks[k + 1].t === T.LBrace && toks[k + 2].t === T.RBrace) {
      items.push({ kind: "node", node: atom("glyph", { src: sym + "{}", display: sym[1] }) });
      return k + 3;
    }
    if (sym === "\\\\") {
      let e = k + 1;
      if (e < end && this.s(toks[e]) === "*") e++;
      if (e < end && toks[e].t === T.LBracket) {
        const c = matchBracket(toks, e, end);
        if (c !== -1) e = c + 1;
      } else e = this.eatSpace(e, end);
      const src = this.span(k, e);
      items.push({ kind: "node", node: atom("spacing", { src, kind: "break", amount: spacingAmount(src) }) });
      return e;
    }
    const e = skipArgs(toks, k + 1, end);
    items.push(raw(this.span(k, e), sym));
    return e;
  }
}

function serializeItems(nodes: PMNode[]): string {
  return serializeInlineWith(latexCodec, nodes, { useSrc: false }, false);
}

/** Replaces each group that does not serialize back to its own source with a raw chip. */
function demote(items: Item[]): Item[] {
  return items.map((it) => {
    if (it.kind === "node") return it;
    const inner = demote(it.items);
    const g: Item = { ...it, items: inner };
    return serializeItems(flatten([g])) === it.src ? g : raw(it.src, it.label);
  });
}

/** Applies mark groups: each node inside a group gets the group's mark. */
function flatten(items: Item[]): PMNode[] {
  const out: PMNode[] = [];
  for (const it of items) {
    if (it.kind === "node") out.push(it.node);
    else for (const n of flatten(it.items)) out.push(n.mark(it.mark.addToSet(n.marks)));
  }
  return out;
}

/**
 * Parses inline LaTeX into PM inline nodes, or returns null when the content
 * cannot be inline (an unclosed maths span or brace group).
 */
export function parseLatexInline(src: string, state: InlineState, info?: { exact: boolean }): PMNode[] | null {
  try {
    const p = new Parser(src, state);
    const items = p.seq(0, p.toks.length, []);
    const nodes = flatten(items);
    if (serializeItems(nodes) === src) {
      if (info) info.exact = true;
      return nodes;
    }
    // Something does not round-trip: demote just the groups that fail (I4 per construct).
    return flatten(demote(items));
  } catch (e) {
    if (e instanceof InlineFail) return null;
    throw e;
  }
}
