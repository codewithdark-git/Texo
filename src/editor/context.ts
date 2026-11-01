// Works out what kind of completion fits at the cursor, from the text of the
// current line up to the cursor. Kept free of Monaco so it can be unit-tested.

export type CompletionKind =
  | "command"
  | "environment"
  | "label"
  | "citation"
  | "texFile"
  | "includeFile"
  | "image"
  | "bibFile"
  | "bibResource";

export interface CompletionContext {
  kind: CompletionKind;
  /** What the user has typed so far for the current item. */
  prefix: string;
  /** 0-based column where `prefix` starts. */
  start: number;
}

const ARGUMENT_KINDS: [RegExp, CompletionKind][] = [
  [/\\(?:ref|eqref|pageref|autoref|nameref|vref|[cC]ref|labelcref)\*?$/, "label"],
  [/\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\]){0,2}$/, "citation"],
  [/\\begin$/, "environment"],
  [/\\end$/, "environment"],
  [/\\input$/, "texFile"],
  [/\\(?:include|subfile)$/, "includeFile"],
  [/\\includegraphics\*?(?:\[[^\]]*\])?$/, "image"],
  [/\\bibliography$/, "bibFile"],
  [/\\addbibresource(?:\[[^\]]*\])?$/, "bibResource"],
];

export function completionContext(lineBeforeCursor: string): CompletionContext | null {
  // Ignore anything inside a comment.
  const comment = lineBeforeCursor.search(/(?<!\\)%/);
  if (comment !== -1) return null;

  // Inside a `{…}` argument: find the last unclosed brace on this line.
  const open = lineBeforeCursor.lastIndexOf("{");
  if (open !== -1 && !lineBeforeCursor.slice(open).includes("}")) {
    const before = lineBeforeCursor.slice(0, open);
    const arg = lineBeforeCursor.slice(open + 1);
    for (const [pattern, kind] of ARGUMENT_KINDS) {
      if (pattern.test(before)) {
        // Citations and \cref take comma-separated lists; complete the last one.
        const lastComma = kind === "citation" || kind === "label" ? arg.lastIndexOf(",") : -1;
        const itemStart = lastComma + 1;
        const leading = arg.slice(itemStart).match(/^\s*/)?.[0].length ?? 0;
        return {
          kind,
          prefix: arg.slice(itemStart + leading),
          start: open + 1 + itemStart + leading,
        };
      }
    }
  }

  // A command name being typed: `\sec|`.
  const command = lineBeforeCursor.match(/\\([a-zA-Z@]*\*?)$/);
  if (command) {
    return { kind: "command", prefix: command[1], start: lineBeforeCursor.length - command[1].length };
  }
  return null;
}

/** Strips a known extension, for `\include{chapters/one}` and `\bibliography{refs}`. */
export function withoutExtension(path: string, ext: string): string {
  return path.toLowerCase().endsWith(ext) ? path.slice(0, -ext.length) : path;
}
