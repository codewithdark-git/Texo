// A deterministic synthetic thesis (about 250 KB, roughly 50 pages) for the
// golden and performance tests: chapters, sections, lists, maths, figures,
// tables, citations and the occasional odd construct.

const WORDS =
  "the of model data results we show that this method approach analysis value system error rate figure section result effect sample test learning network field signal noise".split(
    " ",
  );

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function thesis(targetBytes = 250_000, seed = 7): string {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const sentence = () => {
    const n = 8 + Math.floor(r() * 14);
    const w: string[] = [];
    for (let i = 0; i < n; i++) {
      const roll = r();
      if (roll < 0.03) w.push(`\\textbf{${pick(WORDS)}}`);
      else if (roll < 0.06) w.push(`\\emph{${pick(WORDS)} ${pick(WORDS)}}`);
      else if (roll < 0.08) w.push(`$x_{${i}}^2$`);
      else if (roll < 0.09) w.push(`\\cite{ref${Math.floor(r() * 90)}}`);
      else if (roll < 0.1) w.push(`Fig.~\\ref{fig:${Math.floor(r() * 40)}}`);
      else w.push(pick(WORDS));
    }
    const s = w.join(" ");
    return s[0].toUpperCase() + s.slice(1) + ".";
  };
  const paragraph = () => {
    const lines: string[] = [];
    let line = "";
    for (let i = 0, n = 3 + Math.floor(r() * 5); i < n; i++) {
      for (const word of sentence().split(" ")) {
        if (line.length + word.length > 72) {
          lines.push(line);
          line = word;
        } else line = line ? line + " " + word : word;
      }
    }
    lines.push(line);
    return lines.join("\n");
  };
  const out: string[] = [
    "\\documentclass[12pt]{report}",
    "\\usepackage{amsmath,graphicx,booktabs}",
    "\\newcommand{\\vect}[1]{\\mathbf{#1}}",
    "\\title{A Synthetic Thesis}",
    "\\author{Test Author}",
    "\\begin{document}",
    "",
    "\\maketitle",
    "\\tableofcontents",
    "",
  ];
  let size = out.join("\n").length;
  let fig = 0;
  for (let ch = 1; size < targetBytes; ch++) {
    const blocks: string[] = [`\\chapter{Chapter ${ch}}\\label{ch:${ch}}`];
    for (let sec = 1; sec <= 5; sec++) {
      blocks.push(`\\section{Section ${ch}.${sec}}`);
      for (let p = 0; p < 4; p++) {
        blocks.push(paragraph());
        const roll = r();
        if (roll < 0.15) blocks.push(`\\begin{equation}\n  E_{${p}} = \\vect{v}^\\top A \\vect{v}\n  \\label{eq:${ch}-${sec}-${p}}\n\\end{equation}`);
        else if (roll < 0.25) blocks.push(`\\begin{itemize}\n  \\item ${sentence()}\n  \\item ${sentence()}\n\\end{itemize}`);
        else if (roll < 0.3)
          blocks.push(
            `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.6\\linewidth]{fig${fig}.pdf}\n  \\caption{${sentence()}}\n  \\label{fig:${fig++}}\n\\end{figure}`,
          );
        else if (roll < 0.33)
          blocks.push(`\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{lr}\n    \\toprule\n    a & 1 \\\\\n    b & 2 \\\\\n    \\bottomrule\n  \\end{tabular}\n  \\caption{Numbers.}\n\\end{table}`);
        else if (roll < 0.35) blocks.push(`% TODO: revise this part\n% (${ch}.${sec})`);
        else if (roll < 0.36) blocks.push(`\\begin{tikzpicture}\n  \\draw (0,0) -- (${p},1);\n\\end{tikzpicture}`);
      }
    }
    const chunk = blocks.join("\n\n");
    out.push(chunk, "");
    size += chunk.length + 2;
  }
  out.push("\\bibliographystyle{plain}", "\\bibliography{refs}", "", "\\end{document}", "");
  return out.join("\n");
}
