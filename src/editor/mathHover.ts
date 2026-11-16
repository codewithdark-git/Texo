// A maths preview in the code editor: rest the mouse on $..$, \(..\), \[..\]
// or a display environment and a rendered formula appears below it. The
// renderer (KaTeX) and the macro reader load on first use.

import type { monaco } from "./monaco";

export interface MathSpan {
  /** Offsets of the whole span, delimiters included. */
  start: number;
  end: number;
  /** The TeX between the delimiters. */
  body: string;
  display: boolean;
  /** The environment name for \begin{..} spans, else "". */
  env: string;
}

const MATH_ENVS = /^(equation|align|gather|multline|flalign|alignat|displaymath|math)\*?$/;

/**
 * The maths span around `offset` in `text`, or null. Understands $..$, $$..$$,
 * \(..\), \[..\] and display environments; skips \$ and % comments.
 */
export function findMathAt(text: string, offset: number): MathSpan | null {
  type Open = { kind: "$" | "$$" | "\\(" | "\\[" | "env"; start: number; bodyStart: number; env: string };
  let open: Open | null = null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "%" && !open) {
      // A comment runs to the end of the line.
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "\n" && open && (open.kind === "$" || open.kind === "\\(")) {
      // Inline maths can't span a blank line.
      let j = i + 1;
      while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j++;
      if (text[j] === "\n") open = null;
    }
    if (c === "\\") {
      const next = text[i + 1];
      if (!open && (next === "(" || next === "[")) {
        open = { kind: next === "(" ? "\\(" : "\\[", start: i, bodyStart: i + 2, env: "" };
        i += 2;
        continue;
      }
      if (open && ((open.kind === "\\(" && next === ")") || (open.kind === "\\[" && next === "]"))) {
        const span = { start: open.start, end: i + 2, body: text.slice(open.bodyStart, i), display: open.kind === "\\[", env: "" };
        if (offset >= span.start && offset <= span.end) return span;
        open = null;
        i += 2;
        continue;
      }
      if (text.startsWith("begin", i + 1) || text.startsWith("end", i + 1)) {
        const m = /^\\(begin|end)\s*\{([^}]*)\}/.exec(text.slice(i, i + 80));
        if (m && MATH_ENVS.test(m[2])) {
          if (m[1] === "begin" && !open) {
            open = { kind: "env", start: i, bodyStart: i + m[0].length, env: m[2] };
          } else if (m[1] === "end" && open?.kind === "env" && open.env === m[2]) {
            const span = { start: open.start, end: i + m[0].length, body: text.slice(open.bodyStart, i), display: true, env: m[2] };
            if (offset >= span.start && offset <= span.end) return span;
            open = null;
          }
          i += m[0].length;
          continue;
        }
      }
      i += 2; // an escaped character or a command's first letter
      continue;
    }
    if (c === "$") {
      const dbl = text[i + 1] === "$";
      if (!open) {
        open = dbl ? { kind: "$$", start: i, bodyStart: i + 2, env: "" } : { kind: "$", start: i, bodyStart: i + 1, env: "" };
        i += dbl ? 2 : 1;
        continue;
      }
      if ((open.kind === "$$" && dbl) || (open.kind === "$" && !dbl)) {
        const len = dbl ? 2 : 1;
        const span = { start: open.start, end: i + len, body: text.slice(open.bodyStart, i), display: dbl, env: "" };
        if (offset >= span.start && offset <= span.end) return span;
        open = null;
        i += len;
        continue;
      }
    }
    if (!open && i > offset) return null;
    i++;
  }
  return null;
}

/** How far around the mouse to look for a display formula's delimiters. */
const WINDOW_LINES = 60;
/** How much further up to look for a blank line to start scanning from. */
const SAFE_START_LINES = 400;

/**
 * The line to start scanning from for a hover on `line`: a blank line at or
 * above the window's top, since no formula runs across one. Starting inside a
 * formula would read its closing delimiter as an opener.
 */
export function scanStartLine(line: number, lineAt: (n: number) => string): number {
  let first = Math.max(1, line - WINDOW_LINES);
  const floor = Math.max(1, first - SAFE_START_LINES);
  while (first > floor && lineAt(first).trim() !== "") first--;
  return first;
}

/** True when a found span crosses a blank line: not real maths (TeX ends maths at a paragraph break). */
export function crossesBlankLine(body: string): boolean {
  return /\n[ \t\r]*\n/.test(body);
}

// Every attached hover's hide, for hideMathHover.
const hiders = new Set<() => void>();

/** Hides any maths preview on screen (the code editor was switched away from). */
export function hideMathHover() {
  for (const h of hiders) h();
}

/** Adds the hover to a code editor. Checks `enabled()` each time, so the preference applies live. */
export function attachMathHover(editor: monaco.editor.ICodeEditor, enabled: () => boolean): { dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let box: HTMLDivElement | null = null;
  let shown: { start: number; end: number; version: number } | null = null;
  const macroCache = new WeakMap<monaco.editor.ITextModel, { version: number; macros: Record<string, string>; hash: string }>();

  const hide = () => {
    clearTimeout(timer);
    shown = null;
    if (box) box.style.display = "none";
  };

  const show = async (pos: monaco.Position) => {
    const model = editor.getModel();
    if (!model || !enabled()) return;
    const lang = model.getLanguageId();
    if (lang !== "latex" && lang !== "markdown") return;
    const firstLine = scanStartLine(pos.lineNumber, (n) => model.getLineContent(n));
    const lastLine = Math.min(model.getLineCount(), pos.lineNumber + WINDOW_LINES);
    const range = { startLineNumber: firstLine, startColumn: 1, endLineNumber: lastLine, endColumn: model.getLineMaxColumn(lastLine) };
    const base = model.getOffsetAt({ lineNumber: firstLine, column: 1 });
    const text = model.getValueInRange(range);
    const span = findMathAt(text, model.getOffsetAt(pos) - base);
    if (!span || !span.body.trim() || crossesBlankLine(span.body)) {
      hide();
      return;
    }
    const version = model.getVersionId();
    if (shown && shown.start === span.start + base && shown.version === version) return;
    const [{ renderTex, displayTex, stripForPreview }, core] = await Promise.all([import("../visual/view/katex"), import("../visual/core")]);
    if (editor.getModel() !== model || model.getVersionId() !== version) return;
    let macros = macroCache.get(model);
    if (!macros || macros.version !== version) {
      const ctx = core.readContext(lang === "latex" ? "latex" : "markdown", model.getValue());
      macros = { version, macros: ctx.macros, hash: ctx.macrosHash };
      macroCache.set(model, macros);
    }
    const { tex } = stripForPreview(span.body);
    const src = span.display ? displayTex(tex, span.env) : tex;
    const r = renderTex(src, span.display, macros.macros, macros.hash);
    box ??= createBox();
    if (r.error) {
      box.textContent = r.error;
      box.classList.add("texo-math-hover-error");
    } else {
      box.innerHTML = r.html;
      box.classList.remove("texo-math-hover-error");
    }
    const at = model.getPositionAt(span.end + base);
    const vis = editor.getScrolledVisiblePosition(at);
    const host = editor.getDomNode()?.getBoundingClientRect();
    if (!vis || !host) return;
    const startVis = editor.getScrolledVisiblePosition(model.getPositionAt(span.start + base));
    box.style.display = "block";
    const left = host.left + Math.min(startVis?.left ?? vis.left, vis.left);
    box.style.left = `${Math.max(8, Math.min(left, window.innerWidth - box.offsetWidth - 8))}px`;
    const below = host.top + vis.top + vis.height + 6;
    box.style.top = `${below + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, host.top + (startVis?.top ?? vis.top) - box.offsetHeight - 6) : below}px`;
    shown = { start: span.start + base, end: span.end + base, version };
  };

  const createBox = () => {
    const el = document.createElement("div");
    el.className = "texo-math-hover";
    el.setAttribute("role", "tooltip");
    Object.assign(el.style, {
      position: "fixed",
      zIndex: "60",
      maxWidth: "min(640px, 90vw)",
      overflowX: "auto",
      padding: "6px 10px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "var(--surface)",
      color: "var(--text)",
      boxShadow: "0 8px 24px rgb(0 0 0 / 0.25)",
      pointerEvents: "none",
      display: "none",
      fontSize: "16px",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.append(el);
    return el;
  };

  hiders.add(hide);
  const subs = [
    editor.onMouseMove((e) => {
      clearTimeout(timer);
      const pos = e.target.position;
      if (!pos || !enabled()) {
        hide();
        return;
      }
      timer = setTimeout(() => void show(pos).catch(() => hide()), 300);
    }),
    editor.onMouseLeave(hide),
    editor.onDidScrollChange(hide),
    editor.onDidChangeModelContent(hide),
    editor.onDidChangeModel(hide),
    editor.onKeyDown(hide),
  ];

  return {
    dispose() {
      hide();
      hiders.delete(hide);
      subs.forEach((s) => s.dispose());
      box?.remove();
      box = null;
    },
  };
}
