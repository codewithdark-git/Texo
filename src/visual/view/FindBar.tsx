import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { replaceAll, replaceCurrent, setQuery, step, type FindState } from "./find";

interface Props {
  view: EditorView;
  state: FindState | undefined;
  replace: boolean;
  /** Bumped to focus the find field again. */
  focusKey: number;
  onClose(): void;
  toast(text: string, kind?: "success" | "info" | "error"): void;
}

/** Find and replace for Visual mode, at the top right of the page. */
export function FindBar({ view, state, replace: showReplace, focusKey, onClose, toast }: Props) {
  const [text, setText] = useState(state?.query.text ?? "");
  const [caseSensitive, setCase] = useState(state?.query.caseSensitive ?? false);
  const [wholeWord, setWhole] = useState(state?.query.wholeWord ?? false);
  const [replacement, setReplacement] = useState("");
  const [withReplace, setWithReplace] = useState(showReplace);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Start from the selected text, as the code editor does.
    const { from, to } = view.state.selection;
    const sel = view.state.doc.textBetween(from, to, " ");
    if (sel && !sel.includes("\n") && sel.length < 200) setText(sel);
    setWithReplace((r) => r || showReplace);
    input.current?.focus();
    input.current?.select();
  }, [focusKey, showReplace, view]);

  useEffect(() => {
    setQuery(view, { text, caseSensitive, wholeWord });
  }, [view, text, caseSensitive, wholeWord]);

  useEffect(() => () => setQuery(view, { text: "", caseSensitive: false, wholeWord: false }), [view]);

  const total = state?.matches.length ?? 0;
  const close = () => {
    onClose();
    view.focus();
  };
  const toggle = (on: boolean, set: (v: boolean) => void, label: string, title: string) => (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={() => set(!on)}
      className={`rounded px-1.5 text-xs ${on ? "bg-accent/20 text-text" : "text-muted hover:text-text"}`}
    >
      {label}
    </button>
  );

  return (
    <div
      role="search"
      className="absolute top-12 right-4 z-30 flex w-[22rem] max-w-[calc(100%-2rem)] flex-col gap-1.5 rounded-lg border border-border bg-surface p-2 text-sm shadow-xl"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className="flex items-center gap-1">
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(view, e.shiftKey ? -1 : 1);
            }
          }}
          placeholder="Find"
          aria-label="Find"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 outline-none focus:border-accent"
        />
        {toggle(caseSensitive, setCase, "Aa", "Match case")}
        {toggle(wholeWord, setWhole, "W", "Whole word")}
        <span className="w-16 text-center text-[11px] text-muted">
          {text ? (total ? `${(state?.current ?? 0) + 1} of ${total}` : "No results") : ""}
        </span>
        <button type="button" title="Previous (Shift+Enter)" onClick={() => step(view, -1)} className="rounded p-0.5 text-muted hover:text-text">
          <ChevronUp size={15} />
        </button>
        <button type="button" title="Next (Enter)" onClick={() => step(view, 1)} className="rounded p-0.5 text-muted hover:text-text">
          <ChevronDown size={15} />
        </button>
        <button type="button" title="Close (Esc)" onClick={close} className="rounded p-0.5 text-muted hover:text-text">
          <X size={15} />
        </button>
      </div>
      {withReplace ? (
        <div className="flex items-center gap-1">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                replaceCurrent(view, replacement);
              }
            }}
            placeholder="Replace"
            aria-label="Replace"
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 outline-none focus:border-accent"
          />
          <button type="button" onClick={() => replaceCurrent(view, replacement)} className="rounded border border-border px-2 py-0.5 text-xs hover:bg-surface-2">
            Replace
          </button>
          <button
            type="button"
            onClick={() => {
              const n = replaceAll(view, replacement);
              if (n) toast(`Replaced ${n} ${n === 1 ? "match" : "matches"}`);
            }}
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
          >
            All
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setWithReplace(true)} className="self-start text-[11px] text-muted hover:text-text">
          Replace…
        </button>
      )}
      {!!state?.inCode && (
        <div className="text-[11px] text-amber-500">
          {state.inCode} {state.inCode === 1 ? "match" : "matches"} inside code chips. Replace them in Code mode.
        </div>
      )}
    </div>
  );
}
