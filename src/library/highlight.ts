// Search matches in library snippets. The backend marks each match with two
// control characters (MARK_START / MARK_END), never with HTML, so a title or
// abstract that contains "<script>" stays text: these helpers split the
// snippet into runs and React renders the matches as <mark> elements.
import { createElement, Fragment, type ReactNode } from "react";
import { MARK_END, MARK_START, snippetParts } from "../lib/libraryApi";

export interface Segment {
  text: string;
  /** A search match, drawn as <mark>. */
  mark: boolean;
}

/** The snippet as runs of text, with the matches flagged. Unpaired markers are dropped. */
export function highlightSegments(snippet: string | null | undefined): Segment[] {
  if (!snippet) return [];
  return snippetParts(snippet).map((p) => ({ text: p.text, mark: p.match }));
}

/** The snippet without its markers, for tooltips and screen readers. */
export function plainSnippet(snippet: string | null | undefined): string {
  if (!snippet) return "";
  return snippet.split(MARK_START).join("").split(MARK_END).join("");
}

/** Whether the snippet has at least one highlighted match. */
export function hasMatch(snippet: string | null | undefined): boolean {
  return highlightSegments(snippet).some((s) => s.mark);
}

/** Text with its search matches as <mark> elements. */
export function Highlight({ text, className = "" }: { text: string | null | undefined; className?: string }): ReactNode {
  const segments = highlightSegments(text);
  return createElement(
    "span",
    { className },
    ...segments.map((s, i) =>
      s.mark
        ? createElement("mark", { key: i, className: "rounded-[3px] bg-accent/20 px-px text-text" }, s.text)
        : createElement(Fragment, { key: i }, s.text),
    ),
  );
}
