import { useEffect, useState } from "react";
import { HistoryStatusItem } from "../history/HistoryPanel";
import { formatRelative } from "../lib/projects";
import { countMarkdownWords, countWords } from "../lib/wordcount";
import { useUi } from "../ui";
import { useCompile } from "./compileStore";
import { showsVisual } from "./editorBridge";
import { useLayout } from "./layoutStore";
import { getModel, useWorkspace } from "./store";

/** The word counter for a file: LaTeX or Markdown, or null for neither. */
function counterFor(path: string | null): ((text: string) => number) | null {
  if (path?.endsWith(".tex")) return countWords;
  if (path && /\.(md|markdown)$/i.test(path)) return countMarkdownWords;
  return null;
}

/** Words in the open .tex or .md file, recounted shortly after edits. */
function useWordCount(active: string | null): number | null {
  const [count, setCount] = useState<number | null>(null);
  const isText = useWorkspace((s) => (s.active ? s.views[s.active]?.kind === "text" : false));
  useEffect(() => {
    const counter = counterFor(active);
    const model = active && counter && isText ? getModel(active) : undefined;
    if (!model || !counter) {
      setCount(null);
      return;
    }
    setCount(counter(model.getValue()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setCount(counter(model.getValue())), 400);
    });
    return () => {
      clearTimeout(timer);
      sub.dispose();
    };
  }, [active, isText]);
  return count;
}

/** "Compiled 2 min ago", refreshed every half minute. */
function useCompiledAgo(): string | null {
  const finishedAt = useCompile((s) => s.finishedAt);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  return finishedAt ? formatRelative(new Date(finishedAt).toISOString()) : null;
}

/** The window-wide bar at the bottom: save state, main document, compile, language, history, words, cursor. */
export function StatusBar() {
  const { cursor, saving, status, active, project } = useWorkspace();
  const words = useWordCount(active);
  const compiledAgo = useCompiledAgo();
  const compiling = useCompile((s) => s.compiling);
  const unsaved = Object.values(status).some((s) => s.dirty);
  const conflict = active ? status[active]?.conflict : false;
  const modes = useWorkspace((s) => s.modes);
  const lang = active?.match(/\.(tex|bib|sty|cls|md|markdown)$/i)?.[1].toLowerCase();
  const langLabel =
    (lang === "bib" ? "BibTeX" : lang === "md" || lang === "markdown" ? "Markdown" : lang ? "LaTeX" : active ? "Plain text" : "") +
    (showsVisual(active, modes) ? " · Visual" : "");
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-t border-border bg-surface/60 px-3 text-[11px] text-muted">
      <span className="shrink-0">{conflict ? "Changed on disk" : saving > 0 ? "Saving…" : unsaved ? "Unsaved changes" : "All changes saved"}</span>
      {project?.mainDocument && <span className="min-w-0 truncate">Main: {project.mainDocument}</span>}
      {compiling ? <span>Compiling…</span> : compiledAgo && <span className="min-w-0 truncate" title="Last compile">Compiled {compiledAgo}</span>}
      <span className="ml-auto shrink-0">{langLabel}</span>
      <HistoryStatusItem onOpen={() => useLayout.getState().openRightTab("history")} />
      {words !== null && (
        <button
          type="button"
          title="Words in this file's text. Click for details."
          onClick={() => useUi.getState().openDialog("wordCount")}
          className="shrink-0 rounded px-1 hover:bg-surface-2 hover:text-text"
        >
          {words.toLocaleString()} words
        </button>
      )}
      {cursor && (
        <span className="shrink-0">
          Ln {cursor.line}, Col {cursor.column}
        </span>
      )}
    </div>
  );
}
