// One-time Monaco setup: worker, editor features, LaTeX/BibTeX languages,
// themes, and completions. Import `monaco` from here so the setup always
// runs first.
import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { registerLatexCompletions } from "./completions";
import { bibtexConfig, bibtexTokens, latexConfig, latexTokens } from "./latexLanguage";
import { texoDark, texoLight } from "./themes";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.languages.register({ id: "latex", extensions: [".tex", ".ltx", ".sty", ".cls", ".tikz"], aliases: ["LaTeX"] });
monaco.languages.setLanguageConfiguration("latex", latexConfig);
monaco.languages.setMonarchTokensProvider("latex", latexTokens);

monaco.languages.register({ id: "bibtex", extensions: [".bib"], aliases: ["BibTeX"] });
monaco.languages.setLanguageConfiguration("bibtex", bibtexConfig);
monaco.languages.setMonarchTokensProvider("bibtex", bibtexTokens);

monaco.editor.defineTheme("texo-dark", texoDark);
monaco.editor.defineTheme("texo-light", texoLight);

const completions = registerLatexCompletions();
// In development, drop the old provider when this module hot-reloads.
import.meta.hot?.dispose(() => completions.dispose());

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => monaco.editor.setTheme(darkQuery.matches ? "texo-dark" : "texo-light");
applyTheme();
darkQuery.addEventListener("change", applyTheme);

export function languageFor(path: string): string {
  const lower = path.toLowerCase();
  if (/\.(tex|ltx|sty|cls|tikz|dtx)$/.test(lower)) return "latex";
  if (lower.endsWith(".bib")) return "bibtex";
  return "plaintext";
}

export { monaco };
