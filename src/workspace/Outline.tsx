import { useEffect, useState } from "react";
import { revealLine } from "./EditorPane";
import { parseMarkdownOutline, parseOutline, type OutlineItem } from "./outlineParser";
import { getModel, useWorkspace } from "./store";

/** The outline parser for a file, or null if it has no outline. */
function parserFor(path: string | null): ((text: string) => OutlineItem[]) | null {
  if (!path) return null;
  if (/\.tex$/i.test(path)) return parseOutline;
  if (/\.(md|markdown)$/i.test(path)) return parseMarkdownOutline;
  return null;
}

export function Outline() {
  const active = useWorkspace((s) => s.active);
  const isText = useWorkspace((s) => (s.active ? s.views[s.active]?.kind === "text" : false));
  const cursorLine = useWorkspace((s) => s.cursor?.line ?? 0);
  const [items, setItems] = useState<OutlineItem[]>([]);

  useEffect(() => {
    const parse = parserFor(active);
    const model = active && isText && parse ? getModel(active) : undefined;
    if (!model || !parse) {
      setItems([]);
      return;
    }
    setItems(parse(model.getValue()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setItems(parse(model.getValue())), 250);
    });
    return () => {
      clearTimeout(timer);
      sub.dispose();
    };
  }, [active, isText]);

  // The heading the cursor is currently under.
  const current = items.reduce<number>((found, item, i) => (item.line <= cursorLine ? i : found), -1);
  const minLevel = Math.min(...items.map((i) => i.level));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pt-2 pb-1 text-xs font-medium tracking-wide text-muted uppercase">Outline</div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-4">
        {items.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted">
            {parserFor(active) ? "No headings in this file yet." : "Open a .tex or .md file to see its outline."}
          </p>
        ) : (
          items.map((item, i) => (
            <button
              key={`${item.line}-${i}`}
              type="button"
              onClick={() => revealLine(item.line)}
              style={{ paddingLeft: 10 + (item.level - minLevel) * 14 }}
              className={`block w-full truncate rounded-md py-1 pr-2 text-left text-[13px] ${
                i === current ? "bg-accent/15 text-text" : "text-text/85 hover:bg-surface-2"
              } ${item.level <= minLevel ? "font-medium" : ""}`}
              title={`Line ${item.line}`}
            >
              {item.title}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
