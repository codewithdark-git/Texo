// Small editing popovers for Visual mode: maths, raw source, citation and
// reference pickers, links, footnotes, labels, and the slash menu. Node views
// and commands open them through `openPopover`; the pane renders the host.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { create } from "zustand";
import { COMMANDS } from "../../editor/latexData";
import { fuzzyFilter } from "../../lib/fuzzy";
import { displayTex, renderTex, stripForPreview } from "./katex";

export interface Anchor {
  left: number;
  top: number;
  bottom: number;
}

export interface PickItem {
  key: string;
  label: string;
  detail?: string;
}

export type PopoverRequest =
  | {
      kind: "math";
      anchor: Anchor;
      body: string;
      display: boolean;
      env?: string;
      macros?: Record<string, string>;
      macrosHash?: string;
      /** For a new inline formula: Ctrl+Enter makes it a display formula instead. */
      allowDisplay?: boolean;
      /** Esc keeps what was typed instead of cancelling (a formula opened by typing "$"). */
      commitOnEscape?: boolean;
      onCommit(body: string, display: boolean): void;
      onCancel?(): void;
    }
  | { kind: "raw"; anchor: Anchor; src: string; title?: string; onCommit(src: string): void; onOpenInCode?(): void }
  | {
      kind: "pick";
      anchor: Anchor;
      title: string;
      items: PickItem[];
      multi?: boolean;
      selected?: string[];
      empty?: string;
      onPick(keys: string[]): void;
      onCancel?(): void;
      extra?: { label: string; run(): void };
    }
  | { kind: "size"; anchor: Anchor; onPick(rows: number, cols: number): void }
  | { kind: "link"; anchor: Anchor; href: string; onCommit(href: string): void; onOpen?(): void; onRemove?(): void }
  | { kind: "text"; anchor: Anchor; title: string; value: string; placeholder?: string; multiline?: boolean; hint?: string; onCommit(value: string): void; extra?: { label: string; run(): void } }
  | { kind: "slash"; anchor: Anchor; items: PickItem[]; onPick(key: string): void; onCancel?(): void };

interface PopoverStore {
  current: PopoverRequest | null;
  /** Called after the popover closes, to give focus back to the editor. */
  onClose: (() => void) | null;
  open(req: PopoverRequest, onClose?: () => void): void;
  close(): void;
}

export const usePopover = create<PopoverStore>((set, get) => ({
  current: null,
  onClose: null,
  open: (current, onClose) => set({ current, onClose: onClose ?? null }),
  close: () => {
    const done = get().onClose;
    set({ current: null, onClose: null });
    done?.();
  },
}));

export function openPopover(req: PopoverRequest, onClose?: () => void) {
  usePopover.getState().open(req, onClose);
}

// Commits what is typed in the maths popover shown for `req`. Kept in plain
// JS (not read from the DOM), so it still works while the pane unmounts.
let commitTyped: { req: PopoverRequest; run(): void } | null = null;

/** Closes the popover. With `commit`, a maths popover keeps what was typed, as clicking away does. */
export function closePopover(opts: { commit?: boolean } = {}) {
  const store = usePopover.getState();
  const req = store.current;
  if (!req) return;
  const pending = commitTyped;
  commitTyped = null;
  if (opts.commit && pending && pending.req === req) pending.run();
  store.close();
}

/** Anchors a popover under a DOM element. */
export function anchorOf(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom };
}

/** Maths symbols for the strip: from \frac to the Greek letters in the completion data. */
const SYMBOLS = (() => {
  const start = COMMANDS.findIndex((c) => c.name === "frac");
  return COMMANDS.slice(start === -1 ? 0 : start).map((c) => ({
    name: c.name,
    insert: "\\" + (c.snippet ?? c.name).replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{\d+\}|\$0/g, ""),
  }));
})();

export function PopoverHost() {
  const current = usePopover((s) => s.current);
  const close = usePopover((s) => s.close);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!current || !box.current) {
      setPos(null);
      return;
    }
    const r = box.current.getBoundingClientRect();
    const margin = 8;
    let left = Math.min(current.anchor.left, window.innerWidth - r.width - margin);
    left = Math.max(margin, left);
    let top = current.anchor.bottom + 6;
    if (top + r.height > window.innerHeight - margin) top = Math.max(margin, current.anchor.top - r.height - 6);
    setPos({ left, top });
  }, [current]);

  // The box is invisible until it is placed, and a hidden field can't take
  // focus; once it shows, make sure typing goes into it, not the document.
  useEffect(() => {
    const el = box.current;
    if (!current || !pos || !el || el.contains(document.activeElement)) return;
    const field = el.querySelector<HTMLInputElement | HTMLTextAreaElement>("textarea, input:not([type=checkbox])");
    if (!field) return;
    field.focus();
    field.select();
  }, [current, pos]);

  useEffect(() => {
    if (!current) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        // Clicking away keeps what was typed in a maths popover.
        closePopover({ commit: true });
      }
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [current]);

  if (!current) return null;
  return (
    <div
      ref={box}
      role="dialog"
      className="visual-popover fixed z-50 rounded-lg border border-border bg-surface p-2 text-sm text-text shadow-xl"
      style={{ left: pos?.left ?? current.anchor.left, top: pos?.top ?? current.anchor.bottom + 6, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (current.kind === "math" && current.commitOnEscape) {
            closePopover({ commit: true });
            return;
          }
          if (current.kind === "math" || current.kind === "slash" || current.kind === "pick") current.onCancel?.();
          close();
        }
      }}
    >
      {current.kind === "math" && <MathPopover req={current} close={close} />}
      {current.kind === "raw" && <RawPopover req={current} close={close} />}
      {current.kind === "pick" && <PickPopover req={current} close={close} />}
      {current.kind === "link" && <LinkPopover req={current} close={close} />}
      {current.kind === "text" && <TextPopover req={current} close={close} />}
      {current.kind === "slash" && <SlashPopover req={current} close={close} />}
      {current.kind === "size" && <SizePopover req={current} close={close} />}
    </div>
  );
}

type Req<K extends PopoverRequest["kind"]> = Extract<PopoverRequest, { kind: K }>;

function Small({ children, onClick, primary }: { children: ReactNode; onClick(): void; primary?: boolean }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-xs ${primary ? "bg-accent text-accent-ink hover:bg-accent-strong" : "border border-border hover:bg-surface-2"}`}
    >
      {children}
    </button>
  );
}

function MathPopover({ req, close }: { req: Req<"math">; close(): void }) {
  const [body, setBody] = useState(req.body);
  // A new inline formula becomes display maths when "$$" is typed.
  const [display, setDisplay] = useState(req.display);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ta.current?.focus();
    ta.current?.select();
  }, []);
  // What closing the popover from outside keeps (clicking away, switching file or mode).
  const latest = useRef({ body, display });
  latest.current = { body, display };
  useEffect(() => {
    commitTyped = { req, run: () => req.onCommit(latest.current.body, latest.current.display) };
  }, [req]);
  const preview = useMemo(() => {
    const { tex } = stripForPreview(body);
    const src = display ? displayTex(tex, req.env ?? "") : tex;
    return src.trim() ? renderTex(src, display, req.macros, req.macrosHash) : null;
  }, [body, display, req.env, req.macros, req.macrosHash]);

  const commit = (asDisplay: boolean) => {
    req.onCommit(body, asDisplay);
    close();
  };
  const insertSymbol = (s: string) => {
    const el = ta.current;
    if (!el) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const next = body.slice(0, a) + s + body.slice(b);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = a + s.length;
    });
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit(req.allowDisplay ? true : display);
    } else if (e.key === "Enter" && !e.shiftKey && !display) {
      e.preventDefault();
      commit(false);
    } else if (e.key === "$" && req.allowDisplay && !display && body === "") {
      e.preventDefault();
      setDisplay(true);
    } else if ((e.key === "$" && !display && !body.endsWith("\\")) || e.key === "Tab") {
      e.preventDefault();
      commit(display);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !display) {
      // Arrowing out of either end finishes the formula, like leaving it in the text.
      const el = e.currentTarget as HTMLTextAreaElement;
      const atEdge = e.key === "ArrowLeft" ? el.selectionStart === 0 && el.selectionEnd === 0 : el.selectionStart === body.length;
      if (atEdge) {
        e.preventDefault();
        commit(false);
      }
    }
  };
  return (
    <div className="flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      <textarea
        ref={ta}
        value={body}
        spellCheck={false}
        rows={display ? 4 : 2}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
        className="w-full resize-y rounded-md border border-border bg-bg p-2 font-mono text-[13px] outline-none focus:border-accent"
        placeholder={display ? "E = mc^2" : "x^2"}
        aria-label="Maths source"
      />
      <div className="flex max-h-8 flex-wrap gap-1 overflow-hidden hover:max-h-40 hover:overflow-auto">
        {SYMBOLS.map((s) => (
          <button
            key={s.name}
            type="button"
            title={s.insert}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertSymbol(s.insert)}
            className="rounded border border-border px-1 font-mono text-[11px] text-muted hover:bg-surface-2 hover:text-text"
          >
            {s.name}
          </button>
        ))}
      </div>
      <div className="min-h-8 overflow-x-auto rounded-md bg-bg px-2 py-1">
        {preview?.error ? (
          <span className="font-mono text-xs text-amber-500">{preview.error}</span>
        ) : preview ? (
          <span dangerouslySetInnerHTML={{ __html: preview.html }} />
        ) : (
          <span className="text-xs text-muted">Preview</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] text-muted">
          {display ? "Ctrl+Enter to finish" : req.allowDisplay ? "Enter: inline · Ctrl+Enter: display" : "Enter to finish"} · Esc cancels
        </span>
        <Small onClick={close}>Cancel</Small>
        <Small primary onClick={() => commit(display)}>
          Done
        </Small>
      </div>
    </div>
  );
}

function RawPopover({ req, close }: { req: Req<"raw">; close(): void }) {
  const [src, setSrc] = useState(req.src);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ta.current?.focus(), []);
  const commit = () => {
    req.onCommit(src);
    close();
  };
  return (
    <div className="flex w-[32rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {req.title && <div className="text-xs font-medium text-muted">{req.title}</div>}
      <textarea
        ref={ta}
        value={src}
        spellCheck={false}
        rows={Math.min(16, Math.max(3, src.split("\n").length + 1))}
        onChange={(e) => setSrc(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          }
        }}
        className="w-full resize-y rounded-md border border-border bg-bg p-2 font-mono text-[13px] outline-none focus:border-accent"
        aria-label="Source"
      />
      <div className="flex items-center gap-2">
        {req.onOpenInCode && (
          <Small
            onClick={() => {
              close();
              req.onOpenInCode?.();
            }}
          >
            Open in Code
          </Small>
        )}
        <span className="flex-1 text-[11px] text-muted">Ctrl+Enter to finish · Esc cancels</span>
        <Small onClick={close}>Cancel</Small>
        <Small primary onClick={commit}>
          Done
        </Small>
      </div>
    </div>
  );
}

function PickPopover({ req, close }: { req: Req<"pick">; close(): void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<string[]>(req.selected ?? []);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const byKey = useMemo(() => new Map(req.items.map((i) => [i.key, i])), [req.items]);
  const shown = useMemo(() => {
    const hay = req.items.map((i) => i.key + (i.detail ? " " + i.detail : ""));
    return fuzzyFilter(query, hay, 40).map((m) => req.items[hay.indexOf(m.path)]);
  }, [query, req.items]);
  const pick = (key: string) => {
    if (req.multi) {
      const next = chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key];
      setChosen(next);
      return;
    }
    req.onPick([key]);
    close();
  };
  const finish = () => {
    if (req.multi && chosen.length) req.onPick(chosen);
    close();
  };
  return (
    <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1">
      <div className="px-1 text-xs font-medium text-muted">{req.title}</div>
      <input
        ref={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(shown.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) finish();
            else if (shown[index] && req.multi) {
              // Enter takes the highlighted key along with any ticked ones.
              const key = shown[index].key;
              req.onPick(chosen.includes(key) ? chosen : [...chosen, key]);
              close();
            } else if (shown[index]) pick(shown[index].key);
            else if (query.trim() && !byKey.size) pick(query.trim());
          } else if (e.key === " " && req.multi && shown[index] && query === "") {
            e.preventDefault();
            pick(shown[index].key);
          }
        }}
        placeholder="Search"
        className="rounded-md border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-accent"
      />
      <div role="listbox" className="max-h-64 overflow-auto">
        {shown.length === 0 && <div className="px-2 py-2 text-xs text-muted">{req.empty ?? "Nothing matches."}</div>}
        {shown.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === index}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(item.key)}
            className={`flex w-full flex-col items-start rounded-md px-2 py-1 text-left ${i === index ? "bg-surface-2" : "hover:bg-surface-2"}`}
          >
            <span className="flex w-full items-center gap-2">
              {req.multi && <input type="checkbox" readOnly checked={chosen.includes(item.key)} className="pointer-events-none" />}
              <span className="truncate font-mono text-xs">{item.label}</span>
            </span>
            {item.detail && <span className="w-full truncate text-[11px] text-muted">{item.detail}</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        {req.extra && (
          <Small
            onClick={() => {
              close();
              req.extra?.run();
            }}
          >
            {req.extra.label}
          </Small>
        )}
        <span className="flex-1 text-[11px] text-muted">{req.multi ? "Enter inserts · click to tick several" : ""}</span>
        {req.multi && (
          <Small primary onClick={finish}>
            Done
          </Small>
        )}
      </div>
    </div>
  );
}

function LinkPopover({ req, close }: { req: Req<"link">; close(): void }) {
  const [href, setHref] = useState(req.href);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const commit = () => {
    req.onCommit(href.trim());
    close();
  };
  return (
    <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      <input
        ref={input}
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder="https://"
        spellCheck={false}
        className="rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs outline-none focus:border-accent"
        aria-label="Link address"
      />
      <div className="flex items-center gap-2">
        {req.onOpen && <Small onClick={() => req.onOpen?.()}>Open</Small>}
        {req.onRemove && (
          <Small
            onClick={() => {
              req.onRemove?.();
              close();
            }}
          >
            Remove link
          </Small>
        )}
        <span className="flex-1" />
        <Small primary onClick={commit}>
          Done
        </Small>
      </div>
    </div>
  );
}

function TextPopover({ req, close }: { req: Req<"text">; close(): void }) {
  const [value, setValue] = useState(req.value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    req.onCommit(value);
    close();
  };
  const common = {
    ref,
    value,
    placeholder: req.placeholder,
    onChange: (e: { target: { value: string } }) => setValue(e.target.value),
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === "Enter" && (!req.multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
      }
    },
    className: "w-full rounded-md border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-accent",
    "aria-label": req.title,
  };
  return (
    <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      <div className="text-xs font-medium text-muted">{req.title}</div>
      {req.multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
      {req.hint && <div className="text-[11px] text-muted">{req.hint}</div>}
      <div className="flex items-center gap-2">
        {req.extra && (
          <Small
            onClick={() => {
              close();
              req.extra?.run();
            }}
          >
            {req.extra.label}
          </Small>
        )}
        <span className="flex-1" />
        <Small onClick={close}>Cancel</Small>
        <Small primary onClick={commit}>
          Done
        </Small>
      </div>
    </div>
  );
}

function SlashPopover({ req, close }: { req: Req<"slash">; close(): void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const shown = useMemo(() => {
    const labels = req.items.map((i) => i.label);
    return fuzzyFilter(query, labels, 30).map((m) => req.items[labels.indexOf(m.path)]);
  }, [query, req.items]);
  const pick = (key: string) => {
    close();
    req.onPick(key);
  };
  return (
    <div className="flex w-60 flex-col gap-1">
      <input
        ref={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(shown.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[index]) pick(shown[index].key);
          } else if (e.key === "Backspace" && query === "") {
            e.preventDefault();
            req.onCancel?.();
            close();
          }
        }}
        placeholder="Insert…"
        className="rounded-md border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-accent"
      />
      <div role="listbox" className="max-h-72 overflow-auto">
        {shown.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === index}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(item.key)}
            className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm ${i === index ? "bg-surface-2" : "hover:bg-surface-2"}`}
          >
            <span>{item.label}</span>
            {item.detail && <span className="text-[11px] text-muted">{item.detail}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function SizePopover({ req, close }: { req: Req<"size">; close(): void }) {
  const [hover, setHover] = useState<[number, number]>([2, 2]);
  const max = 8;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted">
        Table: {hover[0]} × {hover[1]}
      </div>
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${max}, 1rem)` }} onMouseDown={(e) => e.preventDefault()}>
        {Array.from({ length: max * max }, (_, i) => {
          const r = Math.floor(i / max) + 1;
          const c = (i % max) + 1;
          const on = r <= hover[0] && c <= hover[1];
          return (
            <button
              key={i}
              type="button"
              aria-label={`${r} by ${c}`}
              onMouseEnter={() => setHover([r, c])}
              onFocus={() => setHover([r, c])}
              onClick={() => {
                close();
                req.onPick(r, c);
              }}
              className={`size-4 rounded-sm border ${on ? "border-accent bg-accent/40" : "border-border bg-bg"}`}
            />
          );
        })}
      </div>
    </div>
  );
}
