// Where a compile issue's squiggle goes on its line. TeX only reports line
// numbers, and in LaTeX prose a whole paragraph is one long (wrapped) line, so
// marking the line would squiggle the paragraph and put a problem hover under
// the mouse wherever it rests. These helpers pick the few characters the
// issue is about instead. Pure: no Monaco here, so it is easy to test.

import type { Issue } from "../lib/api";

/** The owner of compile markers in Monaco (compileStore sets them, codeActions fixes them). */
export const MARKER_OWNER = "texo-compile";

/** 1-based columns on one line; `endColumn` is exclusive, as in Monaco. */
export interface MarkerSpan {
  startColumn: number;
  endColumn: number;
}

/** What an issue is about, read from its message (and TeX's context for errors). */
export type IssueKind =
  | { kind: "citation"; key: string }
  | { kind: "reference"; key: string }
  | { kind: "command"; name: string | null }
  | { kind: "badbox" }
  | { kind: "other" };

// TeX quotes names as `name' (older) or 'name' (newer LaTeX and biblatex).
const QUOTED = "[`'‘]([^'’]+)['’]";
const CITATION = new RegExp(`Citation ${QUOTED}.*undefined`, "i");
const REFERENCE = new RegExp(`Reference ${QUOTED}.*undefined`, "i");

/**
 * The undefined command from TeX's error context: the last control sequence
 * on the `l.N ...` line, which ends exactly where TeX stopped reading.
 */
export function undefinedCommand(context: string | null): string | null {
  if (!context) return null;
  const lines = context.split("\n");
  const at = lines.find((l) => /^l\.\d+ /.test(l)) ?? lines.find((l) => /\\[A-Za-z@]+\s*$/.test(l));
  if (!at) return null;
  const m = /\\([A-Za-z@]+)\s*$/.exec(at);
  return m ? `\\${m[1]}` : null;
}

export function issueKind(issue: Pick<Issue, "severity" | "message" | "context">): IssueKind {
  if (issue.severity === "badbox") return { kind: "badbox" };
  const cite = CITATION.exec(issue.message);
  if (cite) return { kind: "citation", key: cite[1] };
  const ref = REFERENCE.exec(issue.message);
  if (ref) return { kind: "reference", key: ref[1] };
  if (/Undefined control sequence/i.test(issue.message)) return { kind: "command", name: undefinedCommand(issue.context) };
  return { kind: "other" };
}

/** Every `{...}` argument of commands matching `cmd` on `line`, with where it starts. */
function commandArgs(line: string, cmd: RegExp): { command: MarkerSpan; argStart: number; arg: string }[] {
  const out: { command: MarkerSpan; argStart: number; arg: string }[] = [];
  // The command, optional *, optional [..] arguments, then {keys}.
  const re = new RegExp(`\\\\(?:${cmd.source})\\*?((?:\\s*\\[[^\\]]*\\])*)\\s*\\{([^}]*)\\}`, "g");
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const nameLen = /^\\[A-Za-z]+\*?/.exec(m[0])![0].length;
    // The match ends with "{keys}", so the opening brace sits before the keys and the closing one.
    const braceAt = m.index + m[0].length - m[2].length - 2;
    out.push({ command: { startColumn: m.index + 1, endColumn: m.index + 1 + nameLen }, argStart: braceAt + 1, arg: m[2] });
  }
  return out;
}

/** The span of `key` inside a comma-separated argument of a matching command, else the first such command. */
function keyInCommand(line: string, cmd: RegExp, key: string): MarkerSpan | null {
  const found = commandArgs(line, cmd);
  for (const f of found) {
    let offset = 0;
    for (const part of f.arg.split(",")) {
      const lead = part.length - part.trimStart().length;
      if (part.trim() === key) {
        const start = f.argStart + offset + lead + 1;
        return { startColumn: start, endColumn: start + key.length };
      }
      offset += part.length + 1;
    }
  }
  return found[0]?.command ?? null;
}

/** `\name` on the line, not followed by more letters (so \foo doesn't match \foobar). */
function commandSpan(line: string, name: string): MarkerSpan | null {
  const re = new RegExp(`${name.replace(/[\\@]/g, (c) => `\\${c}`)}(?![A-Za-z@])`);
  const m = re.exec(line);
  return m ? { startColumn: m.index + 1, endColumn: m.index + 1 + name.length } : null;
}

/** The first command or word on the line: a short span, never the whole paragraph. */
export function firstToken(line: string): MarkerSpan {
  const start = line.search(/\S/);
  if (start < 0) return { startColumn: 1, endColumn: 1 };
  const rest = line.slice(start);
  const m = /^\\(?:[A-Za-z@]+|.)/.exec(rest) ?? /^[^\s\\{}]+/.exec(rest);
  const len = Math.min(m ? m[0].length : 1, 40);
  return { startColumn: start + 1, endColumn: start + 1 + len };
}

const CITE_COMMANDS = /[A-Za-z]*cite[A-Za-z]*/;
const REF_COMMANDS = /[A-Za-z]*ref/;

/**
 * Where to squiggle `issue` on `line` (the text of the line TeX named), or
 * null for issues that shouldn't be squiggled at all (layout boxes: they stay
 * in the Issues panel).
 */
export function markerSpan(issue: Pick<Issue, "severity" | "message" | "context">, line: string): MarkerSpan | null {
  const what = issueKind(issue);
  switch (what.kind) {
    case "badbox":
      return null;
    case "citation":
      return keyInCommand(line, CITE_COMMANDS, what.key) ?? firstToken(line);
    case "reference":
      return keyInCommand(line, REF_COMMANDS, what.key) ?? firstToken(line);
    case "command":
      return (what.name && commandSpan(line, what.name)) || firstToken(line);
    default:
      return firstToken(line);
  }
}
