// One-time Monaco setup: worker, editor features, LaTeX/BibTeX languages,
// themes, and completions. Import `monaco` from here so the setup always
// runs first.
import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
// Markdown highlighting (register.all brings editor features, not languages).
import "monaco-editor/languages/definitions/markdown/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { registerLatexCompletions } from "./completions";
import { bibtexConfig, bibtexTokens, latexConfig, latexTokens } from "./latexLanguage";
import { texoDark, texoLight } from "./themes";
import { attachMathHover } from "./mathHover";
import { getEditorPrefs } from "../lib/editorPrefs";
import { onThemeChange, resolvedTheme, type Theme } from "../lib/theme";

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

// A rendered preview when the mouse rests on maths (Settings can turn it off).
const hovers = monaco.editor.onDidCreateEditor((ed) => {
  const hover = attachMathHover(ed, () => getEditorPrefs().mathHover);
  ed.onDidDispose(() => hover.dispose());
});
import.meta.hot?.dispose(() => hovers.dispose());

const editorTheme = (theme: Theme) => monaco.editor.setTheme(theme === "dark" ? "texo-dark" : "texo-light");
editorTheme(resolvedTheme());
const stopTheme = onThemeChange(editorTheme);
import.meta.hot?.dispose(stopTheme);

export function languageFor(path: string): string {
  const lower = path.toLowerCase();
  if (/\.(tex|ltx|sty|cls|tikz|dtx)$/.test(lower)) return "latex";
  if (lower.endsWith(".bib")) return "bibtex";
  if (/\.(md|markdown)$/.test(lower)) return "markdown";
  return "plaintext";
}

export { monaco };
