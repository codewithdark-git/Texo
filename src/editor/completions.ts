import * as monaco from "monaco-editor/editor";
import type { Symbols } from "../lib/api";
import { completionContext, withoutExtension, type CompletionKind } from "./context";
import { COMMANDS, ENVIRONMENTS, ENVIRONMENT_BODIES } from "./latexData";

const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages;

/** Project data the completions draw on; the workspace keeps it current. */
export const completionSource: { symbols: Symbols; files: string[] } = {
  symbols: { labels: [], citations: [], commands: [] },
  files: [],
};

const IMAGE_EXT = /\.(png|jpe?g|pdf|eps|svg|gif)$/i;

function fileItems(kind: CompletionKind): { label: string; detail?: string }[] {
  const files = completionSource.files;
  switch (kind) {
    case "texFile":
      return files.filter((f) => f.endsWith(".tex")).map((f) => ({ label: f }));
    case "includeFile":
      return files.filter((f) => f.endsWith(".tex")).map((f) => ({ label: withoutExtension(f, ".tex") }));
    case "image":
      return files.filter((f) => IMAGE_EXT.test(f)).map((f) => ({ label: f }));
    case "bibFile":
      return files.filter((f) => f.endsWith(".bib")).map((f) => ({ label: withoutExtension(f, ".bib") }));
    case "bibResource":
      return files.filter((f) => f.endsWith(".bib")).map((f) => ({ label: f }));
    default:
      return [];
  }
}

function provide(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): monaco.languages.CompletionList {
  const line = model.getLineContent(position.lineNumber);
  const ctx = completionContext(line.slice(0, position.column - 1));
  if (!ctx) return { suggestions: [] };

  const range = new monaco.Range(position.lineNumber, ctx.start + 1, position.lineNumber, position.column);
  const snippet = CompletionItemInsertTextRule.InsertAsSnippet;

  switch (ctx.kind) {
    case "command": {
      const builtIn = COMMANDS.map((cmd, i) => ({
        label: `\\${cmd.name}`,
        filterText: cmd.name,
        kind: CompletionItemKind.Function,
        detail: cmd.detail,
        insertText: cmd.snippet ?? cmd.name,
        insertTextRules: cmd.snippet ? snippet : undefined,
        sortText: String(i).padStart(4, "0"),
        range,
      }));
      const known = new Set(COMMANDS.map((cmd) => cmd.name));
      const custom = completionSource.symbols.commands
        .filter((name) => !known.has(name))
        .map((name) => ({
          label: `\\${name}`,
          filterText: name,
          kind: CompletionItemKind.Variable,
          detail: "Defined in this project",
          insertText: name,
          range,
        }));
      return { suggestions: [...custom, ...builtIn] };
    }

    case "environment": {
      const isBegin = /\\begin\s*\{[^{}]*$/.test(line.slice(0, position.column - 1));
      // Swallow a `}` the editor already auto-inserted after the cursor.
      const closes = line[position.column - 1] === "}";
      const fullRange = closes
        ? new monaco.Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn + 1)
        : range;
      return {
        suggestions: ENVIRONMENTS.map((env) => ({
          label: env,
          kind: CompletionItemKind.Module,
          insertText: isBegin
            ? `${env}}\n${ENVIRONMENT_BODIES[env] ?? "\t$0"}\n\\end{${env}}`
            : `${env}}`,
          insertTextRules: snippet,
          range: fullRange,
        })),
      };
    }

    case "label":
      return {
        suggestions: completionSource.symbols.labels.map((l) => ({
          label: l.name,
          kind: CompletionItemKind.Reference,
          detail: `${l.file}:${l.line}`,
          insertText: l.name,
          range,
        })),
      };

    case "citation":
      return {
        suggestions: completionSource.symbols.citations.map((cit) => ({
          label: { label: cit.key, description: cit.year ?? undefined },
          // Not `Text`: the editor hides that kind (suggest.showWords is off).
          kind: CompletionItemKind.Value,
          detail: cit.title ?? cit.entryType,
          documentation: [cit.author, cit.title, cit.year, cit.file].filter(Boolean).join("\n"),
          // Let people search by title or author, not only by key.
          filterText: [cit.key, cit.title, cit.author].filter(Boolean).join(" "),
          insertText: cit.key,
          range,
        })),
      };

    default:
      return {
        suggestions: fileItems(ctx.kind).map((f) => ({
          label: f.label,
          kind: CompletionItemKind.File,
          insertText: f.label,
          range,
        })),
      };
  }
}

export function registerLatexCompletions(): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider("latex", {
    triggerCharacters: ["\\", "{", ",", "/"],
    provideCompletionItems: provide,
  });
}
