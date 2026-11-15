// LaTeX text escaping and the adjacency guards that keep new text from
// gluing onto the command or delimiter before it.

import type { Codec, Piece } from "../serialize";

const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "^": "\\^{}",
  "~": "\\~{}",
  "`": "\\textasciigrave{}",
};

/** A character that needs escaping, or the first "-" of "--". */
const SPECIAL = /[\\{}%$&#_^~`]|-(?=-)/g;

/** Escapes plain text for LaTeX, e.g. `50% & up` → `50\% \& up`. */
export function escapeLatex(text: string): string {
  return text.replace(SPECIAL, (c) => (c === "-" ? "-{}" : ESCAPES[c]));
}

function escapePieces(text: string, _lineStart: boolean, _inCode: boolean): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  SPECIAL.lastIndex = 0;
  for (let m = SPECIAL.exec(text); m; m = SPECIAL.exec(text)) {
    if (m.index > last) pieces.push({ s: text.slice(last, m.index), n: m.index - last });
    pieces.push({ s: m[0] === "-" ? "-{}" : ESCAPES[m[0]], n: 1 });
    last = m.index + 1;
  }
  if (last < text.length) pieces.push({ s: text.slice(last), n: text.length - last });
  return pieces;
}

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** Does `tail` end in a control word such as \LaTeX? */
function endsInControlWord(tail: string): boolean {
  let i = tail.length - 1;
  while (i >= 0 && (isLetter(tail.charCodeAt(i)) || tail.charCodeAt(i) === 64)) i--;
  return i < tail.length - 1 && i >= 0 && tail.charCodeAt(i) === 92;
}

/**
 * "{}" between a control word and a letter (\LaTeX{}x), between "$" and "$",
 * and between "-" and "-" (so new text never forms -- or $$ by accident).
 */
function guard(tail: string, next: string): string {
  if (tail === "" || next === "") return "";
  const a = tail.charCodeAt(tail.length - 1);
  const b = next.charCodeAt(0);
  if (a === 36 && b === 36) return "{}";
  if (a === 45 && b === 45) return "{}";
  if (isLetter(b) && (isLetter(a) || a === 64) && endsInControlWord(tail)) return "{}";
  return "";
}

export const latexCodec: Codec = { escapePieces, guard, escapeInCode: true };
