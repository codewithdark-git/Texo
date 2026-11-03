// A quick word count for the status bar: the words a reader sees in the body
// text, leaving out comments, the preamble, commands, environments, and maths.

/** Commands whose argument isn't reader-facing text. */
const SKIP_ARGUMENT = /\\(?:label|ref|eqref|pageref|autoref|cref|Cref|cite[a-zA-Z]*|nocite|input|include|includegraphics|bibliography|bibliographystyle|usepackage|documentclass|begin|end|url|href|newcommand|renewcommand|setlength|vspace|hspace)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g;

export function countWords(tex: string): number {
  let text = tex.replace(/(^|[^\\])%.*$/gm, "$1"); // comments
  const body = text.indexOf("\\begin{document}");
  if (body !== -1) text = text.slice(body + "\\begin{document}".length);
  const end = text.indexOf("\\end{document}");
  if (end !== -1) text = text.slice(0, end);

  text = text
    // Display and inline maths.
    .replace(/\\begin\{(equation|align|gather|multline|eqnarray|displaymath|math)\*?\}[\s\S]*?\\end\{\1\*?\}/g, " ")
    .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$]*\$/g, " ")
    .replace(SKIP_ARGUMENT, " ")
    // Remaining commands disappear but keep their text arguments.
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, " ")
    .replace(/\\./g, " ")
    .replace(/[{}~&]/g, " ");

  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
