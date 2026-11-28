// BibTeX fetched from a remote service (doi.org, arXiv) for "Add to
// bibliography" goes into the project's .bib file without a review step, so it
// must not carry TeX that could run programs when the project compiles.
//
// A denylist of dangerous spellings can be dodged (`\let\w=\write` then
// `\w18`, `^^` character codes, …), so this is an allowlist: every control
// word must be one that formatting, accents or math in an honest entry uses.
// Control symbols (`\'`, `\&`, `\\`) are always fine. The Rust command that
// builds the entry runs the same check (src-tauri/src/library/bibsafety.rs);
// this copy is a second line of defence. Keep the two lists in step.

const SAFE = new Set(
  (
    // accents and special letters
    "u v H c d b t r k i j o O l L aa AA ae AE oe OE ss SS dh DH th TH ng NG dj DJ " +
    // text formatting
    "textit textbf emph textsc textrm textsf texttt textsl textup textnormal textmd textsuperscript textsubscript " +
    "mbox hbox url doi nolinkurl href rm it bf em sc sf tt sl up small relax space nobreakspace quad qquad enspace " +
    "thinspace ensuremath text " +
    // text symbols
    "textendash textemdash textquotesingle textquotedbl textasciitilde textasciicircum textbackslash textbar " +
    "textless textgreater textregistered texttrademark textcopyright textdegree textmu textperiodcentered " +
    "textunderscore textellipsis textquoteleft textquoteright textquotedblleft textquotedblright guillemotleft " +
    "guillemotright dots ldots cdots vdots S P dag ddag pounds euro copyright textdagger textbullet " +
    // math alphabets
    "mathrm mathit mathbf mathcal mathsf mathtt mathbb mathfrak mathscr boldsymbol bm operatorname " +
    // greek
    "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho " +
    "varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi " +
    "Psi Omega " +
    // math symbols
    "times cdot pm mp le leq ge geq ll gg ne neq approx sim simeq equiv propto infty partial nabla to rightarrow " +
    "leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow mapsto in notin subset subseteq supset supseteq " +
    "cup cap setminus emptyset forall exists neg wedge vee oplus otimes sum prod int oint sqrt frac dfrac tfrac " +
    "binom log ln exp sin cos tan min max lim sup inf det ell hbar circ star ast bullet prime langle rangle left " +
    "right big Big bigg Bigg vert lvert rvert mid dagger sharp flat natural hat tilde bar vec dot ddot overline " +
    "underline widehat widetilde mathring colon"
  ).split(" "),
);

/**
 * BibTeX joins values before TeX reads them (`"\" # "write18"` becomes
 * `\write18`), so the control-word scan only sees what TeX will see when the
 * entry has no `@string`, `@preamble` or `#`, uses `{…}` delimiters, and no
 * field value ends in an unpaired backslash. Anything else is refused.
 */
function structureProblem(bibtex: string): string | null {
  for (const m of bibtex.toLowerCase().matchAll(/@\s*([a-z]*)\s*(\(?)/g)) {
    if (m[1] === "string" || m[1] === "preamble") return `@${m[1]}`;
    if (m[1] && m[2]) return "an entry in ( ) instead of { }";
  }
  const endsBadly = (v: string) => (/\\+$/.exec(v)?.[0].length ?? 0) % 2 === 1;
  // Exactly one `@type{…}` entry with only whitespace around it, so the depth
  // counted here is the depth BibTeX sees (text outside an entry is ignored by
  // BibTeX and could otherwise shift the count).
  const outside = "text outside the entry";
  const open = bibtex.indexOf("{");
  if (open < 0 || !/^\s*@\s*[A-Za-z]+\s*$/.test(bibtex.slice(0, open))) return outside;
  let depth = 0;
  let quoted = false;
  let start = 0;
  let closed = false;
  for (let i = 0; i < bibtex.length; i++) {
    const c = bibtex[i];
    if (closed) {
      if (!/\s/.test(c)) return outside;
      continue;
    }
    if (c === "{") {
      depth++;
      if (depth === 2 && !quoted) start = i + 1;
    } else if (c === "}") {
      if (depth === 2 && !quoted && endsBadly(bibtex.slice(start, i))) return "a backslash at the end of a field";
      if (depth === 0) return outside;
      depth--;
      closed = depth === 0;
    } else if (c === '"' && depth === 1) {
      if (quoted && endsBadly(bibtex.slice(start, i))) return "a backslash at the end of a field";
      quoted = !quoted;
      start = i + 1;
    } else if (c === "#" && depth === 1 && !quoted) {
      return "# (joining values)";
    }
  }
  return closed ? null : "an entry that isn't closed";
}

/** The first construct in `bibtex` that isn't plain formatting (with its backslash), or null when it is fine. */
export function unsafeConstruct(bibtex: string): string | null {
  if (bibtex.includes("^^")) return "^^";
  const problem = structureProblem(bibtex);
  if (problem) return problem;
  for (let i = 0; i < bibtex.length; i++) {
    if (bibtex[i] !== "\\") continue;
    const word = /^[A-Za-z]+/.exec(bibtex.slice(i + 1))?.[0];
    if (!word) {
      i++; // a control symbol such as \' or \\ takes its character with it
      continue;
    }
    if (!SAFE.has(word)) return `\\${word}`;
    i += word.length;
  }
  return null;
}

/** Why `bibtex` is unsafe to add to a project, or an empty list when it is fine. */
export function bibUnsafeReasons(bibtex: string): string[] {
  const what = unsafeConstruct(bibtex);
  return what ? [what] : [];
}

/** The message shown when an entry is refused (names the first reason only). */
export function unsafeEntryText(reasons: string[]): string {
  return `This paper's BibTeX from the online source uses ${reasons[0]}, which isn't plain formatting and could run code when the project compiles, so Texo didn't add it.`;
}
