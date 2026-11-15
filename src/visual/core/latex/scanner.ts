// A lossless LaTeX tokenizer: every character of the input belongs to exactly
// one token, and offsets are UTF-16 indices. It never throws. \verb and the
// bodies of verbatim-like environments are single opaque tokens.

export const T = {
  /** \name, with an optional trailing "*" included. */
  Word: 0,
  /** \ followed by one non-letter character. */
  Symbol: 1,
  LBrace: 2,
  RBrace: 3,
  LBracket: 4,
  RBracket: 5,
  Dollar: 6,
  DoubleDollar: 7,
  /** \( \) \[ \] */
  ParenOpen: 8,
  ParenClose: 9,
  BracketOpen: 10,
  BracketClose: 11,
  /** % to the end of the line, excluding the line break. */
  Comment: 12,
  /** Spaces and tabs (and a lone \r). */
  Space: 13,
  /** One \n or \r\n. */
  Newline: 14,
  /** A line break followed by one or more whitespace-only lines, through the last line break. */
  Parbreak: 15,
  /** ~ & # ^ _ */
  Special: 16,
  /** Runs of ` or ' or - */
  Punct: 17,
  /** \verb|..| */
  Verb: 18,
  /** The body of verbatim, Verbatim, lstlisting, minted or comment. */
  Opaque: 19,
  Text: 20,
} as const;
export type TokType = (typeof T)[keyof typeof T];

export interface Token {
  t: TokType;
  s: number;
  e: number;
}

export const OPAQUE_ENVS = /^\{(verbatim|Verbatim|lstlisting|minted|comment)\}/;

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64; // A-Z a-z @
}

/** Text runs stop at any ASCII character with a meaning of its own (a lookup table for speed). */
const SPECIAL_ASCII = new Uint8Array(128);
for (const ch of "\\{}[]$%~&#^_`'-* \t\n\r") SPECIAL_ASCII[ch.charCodeAt(0)] = 1;

function isPlain(c: number): boolean {
  return c >= 128 || SPECIAL_ASCII[c] === 0;
}

/** Index just past a newline at i (\n or \r\n), or -1. */
function newlineAt(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === 10) return i + 1;
  if (c === 13 && text.charCodeAt(i + 1) === 10) return i + 2;
  return -1;
}

export function scan(text: string, from = 0, to = text.length): Token[] {
  const out: Token[] = [];
  let i = from;
  const push = (t: TokType, e: number) => {
    out.push({ t, s: i, e });
    i = e;
  };
  while (i < to) {
    const c = text.charCodeAt(i);
    if (c === 92) {
      if (i + 1 >= to) {
        push(T.Text, i + 1);
        continue;
      }
      const d = text.charCodeAt(i + 1);
      // "\@" alone is the spacing command; "\@name" is an internal control word.
      if (isLetter(d) && !(d === 64 && !isLetter(text.charCodeAt(i + 2)))) {
        let j = i + 2;
        while (j < to && isLetter(text.charCodeAt(j))) j++;
        const len = j - i - 1;
        if (len === 4 && text.startsWith("verb", i + 1)) {
          const end = verbEnd(text, j, to);
          if (end !== -1) {
            push(T.Verb, end);
            continue;
          }
        }
        const isBegin = len === 5 && text.startsWith("begin", i + 1);
        if (text.charCodeAt(j) === 42 && j < to) j++;
        push(T.Word, j);
        if (isBegin) {
          const m = OPAQUE_ENVS.exec(text.slice(i, Math.min(to, i + 16)));
          if (m) scanOpaque(text, m[1], to, out, i, (e) => (i = e));
        }
        continue;
      }
      if (d === 40) push(T.ParenOpen, i + 2);
      else if (d === 41) push(T.ParenClose, i + 2);
      else if (d === 91) push(T.BracketOpen, i + 2);
      else if (d === 93) push(T.BracketClose, i + 2);
      else if (d === 13 && text.charCodeAt(i + 2) === 10) push(T.Symbol, i + 3);
      else if (d >= 0xd800 && d <= 0xdbff && i + 2 < to) push(T.Symbol, i + 3);
      else push(T.Symbol, i + 2);
      continue;
    }
    switch (c) {
      case 123:
        push(T.LBrace, i + 1);
        continue;
      case 125:
        push(T.RBrace, i + 1);
        continue;
      case 91:
        push(T.LBracket, i + 1);
        continue;
      case 93:
        push(T.RBracket, i + 1);
        continue;
      case 36:
        push(text.charCodeAt(i + 1) === 36 && i + 1 < to ? T.DoubleDollar : T.Dollar, text.charCodeAt(i + 1) === 36 && i + 1 < to ? i + 2 : i + 1);
        continue;
      case 37: {
        let j = i + 1;
        while (j < to && text.charCodeAt(j) !== 10 && !(text.charCodeAt(j) === 13 && text.charCodeAt(j + 1) === 10)) j++;
        push(T.Comment, j);
        continue;
      }
      case 126:
      case 38:
      case 35:
      case 94:
      case 95:
        push(T.Special, i + 1);
        continue;
      case 96:
      case 39:
      case 45: {
        let j = i + 1;
        while (j < to && text.charCodeAt(j) === c) j++;
        push(T.Punct, j);
        continue;
      }
      case 32:
      case 9: {
        let j = i + 1;
        while (j < to && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
        push(T.Space, j);
        continue;
      }
    }
    const nl = newlineAt(text, i);
    if (nl !== -1 && nl <= to) {
      // A parbreak: this newline, then whitespace-only lines ending in newlines.
      let j = nl;
      let last = -1;
      for (;;) {
        let k = j;
        while (k < to && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
        const n2 = newlineAt(text, k);
        if (n2 === -1 || n2 > to) break;
        last = n2;
        j = n2;
      }
      push(last === -1 ? T.Newline : T.Parbreak, last === -1 ? nl : last);
      continue;
    }
    if (c === 13) {
      push(T.Space, i + 1);
      continue;
    }
    if (c === 42) {
      push(T.Text, i + 1); // its own token, so the star of \\* is easy to find
      continue;
    }
    let j = i + 1;
    while (j < to && isPlain(text.charCodeAt(j))) j++;
    push(T.Text, j);
  }
  return out;
}

/** End of \verb<d>..<d> starting just after "verb", or -1 if unterminated on the line. */
function verbEnd(text: string, j: number, to: number): number {
  let k = j;
  if (text.charCodeAt(k) === 42) k++;
  if (k >= to) return -1;
  const d = text[k];
  if (d === " " || d === "\n" || d === "\r" || /[A-Za-z]/.test(d)) return -1;
  for (let m = k + 1; m < to; m++) {
    const ch = text[m];
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === d) return m + 1;
  }
  return -1;
}

/** After \begin of a verbatim-like env: tokens for {name}, then one opaque body token. */
function scanOpaque(text: string, name: string, to: number, out: Token[], at: number, setI: (e: number) => void) {
  let i = at;
  out.push({ t: T.LBrace, s: i, e: i + 1 });
  out.push({ t: T.Text, s: i + 1, e: i + 1 + name.length });
  out.push({ t: T.RBrace, s: i + 1 + name.length, e: i + 2 + name.length });
  i += name.length + 2;
  const close = text.indexOf("\\end{" + name + "}", i);
  const end = close === -1 || close > to ? to : close;
  if (end > i) out.push({ t: T.Opaque, s: i, e: end });
  setI(end);
}
