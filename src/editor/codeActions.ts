// Quick fixes (Ctrl+. or the lightbulb) for Texo's compile markers: swap a
// mistyped citation or label for a close match, or load the package that
// defines a well-known command. With no fixes for a marker, nothing is offered,
// so the lightbulb only appears when it has something to do.

import * as monaco from "monaco-editor/editor";
import { completionSource } from "./completions";
import { issueKind, MARKER_OWNER } from "./markers";
import { closestKeys, loadsPackage, packageFor, usepackageInsertLine } from "./quickFixes";

type Action = monaco.languages.CodeAction;

function replaceAction(model: monaco.editor.ITextModel, marker: monaco.editor.IMarkerData, title: string, text: string): Action {
  return {
    title,
    kind: "quickfix",
    diagnostics: [marker],
    edit: {
      edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: marker as monaco.IRange, text } }],
    },
  };
}

/** "Change to <key>" for the keys closest to the marked one. */
function keyFixes(model: monaco.editor.ITextModel, marker: monaco.editor.IMarkerData, key: string, known: string[]): Action[] {
  // Only when the squiggle is on the key itself (not a fallback span), so the edit swaps exactly it.
  if (model.getValueInRange(marker as monaco.IRange) !== key) return [];
  return closestKeys(key, known).map((k, i) => ({ ...replaceAction(model, marker, `Change to “${k}”`, k), isPreferred: i === 0 }));
}

/** "Add \usepackage{pkg}" for a known command, when this file has a preamble that doesn't load it yet. */
function packageFix(model: monaco.editor.ITextModel, marker: monaco.editor.IMarkerData, command: string): Action[] {
  const pkg = packageFor(command);
  if (!pkg) return [];
  const text = model.getValue();
  // natbib and biblatex clash; a biblatex document wants \textcite/\parencite instead.
  if (loadsPackage(text, pkg) || (pkg === "natbib" && loadsPackage(text, "biblatex"))) return [];
  const line = usepackageInsertLine(model.getLinesContent());
  if (!line) return [];
  return [
    {
      title: `Add \\usepackage{${pkg}}`,
      kind: "quickfix",
      isPreferred: true,
      diagnostics: [marker],
      edit: {
        edits: [
          {
            resource: model.uri,
            versionId: model.getVersionId(),
            textEdit: {
              range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
              text: `\\usepackage{${pkg}}${model.getEOL()}`,
            },
          },
        ],
      },
    },
  ];
}

function fixesFor(model: monaco.editor.ITextModel, marker: monaco.editor.IMarkerData): Action[] {
  const what = issueKind({ severity: "error", message: marker.message, context: null });
  switch (what.kind) {
    case "citation":
      return keyFixes(model, marker, what.key, completionSource.symbols.citations.map((c) => c.key));
    case "reference":
      return keyFixes(model, marker, what.key, completionSource.symbols.labels.map((l) => l.name));
    case "command": {
      // The squiggle sits on the undefined command when TeX's context named it.
      const marked = model.getValueInRange(marker as monaco.IRange);
      return /^\\[A-Za-z@]+$/.test(marked) ? packageFix(model, marker, marked) : [];
    }
    default:
      return [];
  }
}

export function registerCodeActions(): monaco.IDisposable {
  return monaco.languages.registerCodeActionProvider(
    "latex",
    {
      provideCodeActions(model, _range, context) {
        const actions = context.markers
          // Markers reach providers as IMarker at run time; the owner says they're the compile's.
          .filter((m) => (m as Partial<monaco.editor.IMarker>).owner === MARKER_OWNER)
          .flatMap((m) => fixesFor(model, m));
        return { actions, dispose() {} };
      },
    },
    { providedCodeActionKinds: ["quickfix"] },
  );
}
