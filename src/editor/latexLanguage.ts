import type { languages } from "monaco-editor/editor";

// Monarch grammars for LaTeX and BibTeX. Token names map to theme colours in
// themes.ts.

export const latexConfig: languages.LanguageConfiguration = {
  comments: { lineComment: "%" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "$", close: "$", notIn: ["comment"] },
    { open: "`", close: "'", notIn: ["comment"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "$", close: "$" },
  ],
  // Lets double-click select a whole command such as `\section`.
  wordPattern: /\\?[a-zA-Z@]+\*?|-?\d*\.\d\w*|[^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+/,
  folding: {
    markers: {
      start: /^\s*%\s*#?region\b|\\begin\{/,
      end: /^\s*%\s*#?endregion\b|\\end\{/,
    },
  },
  onEnterRules: [
    // Keep `\item` lists going when pressing Enter after an item.
    {
      beforeText: /^\s*\\item\b.*\S/,
      action: { indentAction: 0, appendText: "\\item " },
    },
  ],
};

export const latexTokens: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".latex",
  sectioning: [
    "part",
    "chapter",
    "section",
    "subsection",
    "subsubsection",
    "paragraph",
    "subparagraph",
  ],
  structural: ["documentclass", "usepackage", "RequirePackage", "input", "include", "includeonly", "bibliography", "bibliographystyle", "addbibresource"],
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [/(\\(?:begin|end))(\s*)(\{)([a-zA-Z*@]+)(\})/, ["keyword.control", "", "delimiter.curly", "type.environment", "delimiter.curly"]],
      [/\\(?:verb\*?)(\|)/, { token: "keyword", next: "@verbBar" }],
      [/\$\$/, { token: "delimiter.math", next: "@displayMath" }],
      [/\\\[/, { token: "delimiter.math", next: "@displayMathBracket" }],
      [/\\\(/, { token: "delimiter.math", next: "@inlineMathParen" }],
      [/\$/, { token: "delimiter.math", next: "@inlineMath" }],
      [/(\\(?:label|ref|eqref|pageref|autoref|cref|Cref|cite[a-zA-Z]*))(\s*)(\{)([^}]*)(\})/, ["keyword", "", "delimiter.curly", "string.reference", "delimiter.curly"]],
      [
        /\\([a-zA-Z@]+)(\*?)/,
        {
          cases: {
            "$1@sectioning": { token: "keyword.section" },
            "$1@structural": { token: "keyword.structural" },
            "@default": "keyword",
          },
        },
      ],
      [/\\./, "keyword.escape"],
      [/[{}]/, "delimiter.curly"],
      [/[[\]]/, "delimiter.square"],
      [/&/, "delimiter.alignment"],
      [/\d+(\.\d+)?(pt|em|ex|cm|mm|in|bp|pc|sp|\\[a-z]+)?/, "number"],
    ],
    inlineMath: [
      [/\$/, { token: "delimiter.math", next: "@pop" }],
      { include: "@math" },
    ],
    inlineMathParen: [
      [/\\\)/, { token: "delimiter.math", next: "@pop" }],
      { include: "@math" },
    ],
    displayMath: [
      [/\$\$/, { token: "delimiter.math", next: "@pop" }],
      { include: "@math" },
    ],
    displayMathBracket: [
      [/\\\]/, { token: "delimiter.math", next: "@pop" }],
      { include: "@math" },
    ],
    math: [
      [/%.*$/, "comment"],
      [/\\[a-zA-Z@]+/, "keyword.math"],
      [/\\./, "keyword.math"],
      [/[{}]/, "delimiter.curly.math"],
      [/[\^_]/, "operator.math"],
      [/[^\\${}^_%)\]]+/, "string.math"],
      [/./, "string.math"],
    ],
    verbBar: [
      [/[^|]+/, "string.verbatim"],
      [/\|/, { token: "keyword", next: "@pop" }],
    ],
  },
} as languages.IMonarchLanguage;

export const bibtexConfig: languages.LanguageConfiguration = {
  comments: { lineComment: "%" },
  brackets: [
    ["{", "}"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: '"', close: '"' },
  ],
};

export const bibtexTokens: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".bib",
  ignoreCase: true,
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [/(@[a-zA-Z]+)(\s*)(\{)(\s*)([^,\s]+)(,)/, ["keyword.entry", "", "delimiter.curly", "", "string.key", "delimiter"]],
      [/@[a-zA-Z]+/, "keyword.entry"],
      [/([a-zA-Z_-]+)(\s*)(=)/, ["attribute.name", "", "delimiter"]],
      [/\{/, { token: "string.value", next: "@braced" }],
      [/"/, { token: "string.value", next: "@quoted" }],
      [/\d+/, "number"],
      [/[{}(),#]/, "delimiter"],
    ],
    braced: [
      [/\{/, { token: "string.value", next: "@push" }],
      [/\}/, { token: "string.value", next: "@pop" }],
      [/[^{}]+/, "string.value"],
    ],
    quoted: [
      [/"/, { token: "string.value", next: "@pop" }],
      [/[^"]+/, "string.value"],
    ],
  },
} as languages.IMonarchLanguage;
