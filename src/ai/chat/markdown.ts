// Chat answers as HTML: markdown-it with raw HTML turned off (so nothing the
// model writes becomes markup), maths through KaTeX ($…$, $$…$$, \(…\),
// \[…\]), no remote images, and code blocks with "Insert at cursor" and
// "Copy" buttons that the message view handles by index.

import MarkdownIt from "markdown-it";
import type { StateBlock, StateInline } from "markdown-it";
import { renderTex } from "../../visual/view/katex";

export interface RenderedMarkdown {
  html: string;
  /** Code block texts, by the index their buttons carry (data-code-index). */
  codes: string[];
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
// Pictures would load from the web (and the app's policy blocks them anyway).
md.disable("image");

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function mathHtml(tex: string, display: boolean): string {
  const r = renderTex(tex, display);
  if (r.error || !r.html) {
    const raw = display ? `$$${tex}$$` : `$${tex}$`;
    return `<code class="chat-math-error" title="KaTeX couldn't show this">${escapeHtml(raw)}</code>`;
  }
  return display ? `<div class="chat-math-display">${r.html}</div>` : r.html;
}

// --- maths: inline -----------------------------------------------------------

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  let open: string;
  let close: string;
  let display = false;
  if (src.startsWith("$$", start)) {
    [open, close, display] = ["$$", "$$", true];
  } else if (src[start] === "$") {
    [open, close] = ["$", "$"];
  } else if (src.startsWith("\\(", start)) {
    [open, close] = ["\\(", "\\)"];
  } else if (src.startsWith("\\[", start)) {
    [open, close, display] = ["\\[", "\\]", true];
  } else {
    return false;
  }
  const from = start + open.length;
  let end = from;
  for (;;) {
    end = src.indexOf(close, end);
    if (end < 0) return false;
    // A backslash-escaped dollar isn't a closer.
    if (close === "$" && src[end - 1] === "\\") {
      end += 1;
      continue;
    }
    break;
  }
  const body = src.slice(from, end);
  if (!body.trim()) return false;
  if (open === "$") {
    // Like Pandoc: no space just inside, and no digit right after ("$5 and $6").
    if (/^\s/.test(body) || /\s$/.test(body) || /\d/.test(src[end + 1] ?? "")) return false;
  }
  if (!silent) {
    const token = state.push(display ? "math_display_inline" : "math_inline", "math", 0);
    token.content = body;
    token.markup = open;
  }
  state.pos = end + close.length;
  return true;
}

// --- maths: blocks ($$ … $$ and \[ … \] on their own lines) -------------------

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineStart = state.bMarks[startLine] + state.tShift[startLine];
  const lineEnd = state.eMarks[startLine];
  const first = state.src.slice(lineStart, lineEnd);
  const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : null;
  if (!open || state.sCount[startLine] - state.blkIndent >= 4) return false;
  const close = open === "$$" ? "$$" : "\\]";
  const rest = first.slice(open.length);
  let body: string[] = [];
  let line = startLine;
  let found = false;
  const closeAt = rest.indexOf(close);
  if (closeAt >= 0) {
    // One line: "$$ x $$" (anything after the closer means it isn't a block).
    if (rest.slice(closeAt + close.length).trim()) return false;
    body = [rest.slice(0, closeAt)];
    found = true;
  } else {
    body.push(rest);
    while (++line < endLine) {
      const s = state.bMarks[line] + state.tShift[line];
      const text = state.src.slice(s, state.eMarks[line]);
      const at = text.indexOf(close);
      if (at >= 0) {
        if (text.slice(at + close.length).trim()) return false;
        body.push(text.slice(0, at));
        found = true;
        break;
      }
      body.push(text);
    }
  }
  if (!found) return false;
  if (silent) return true;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = body.join("\n").trim();
  token.map = [startLine, line + 1];
  token.markup = open;
  state.line = line + 1;
  return true;
}

md.inline.ruler.before("escape", "math_inline", mathInline);
md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
md.renderer.rules.math_inline = (tokens, i) => mathHtml(tokens[i].content, false);
md.renderer.rules.math_display_inline = (tokens, i) => mathHtml(tokens[i].content, true);
md.renderer.rules.math_block = (tokens, i) => mathHtml(tokens[i].content, true) + "\n";

// --- code blocks with buttons -------------------------------------------------

type Env = { codes: string[] } & Record<string, unknown>;

function codeBlock(code: string, lang: string, env: Env | undefined): string {
  const codes = env?.codes ?? [];
  const index = codes.length;
  codes.push(code);
  const label = lang ? `<span class="chat-code-lang">${escapeHtml(lang)}</span>` : "<span></span>";
  return (
    `<div class="chat-code">` +
    `<div class="chat-code-bar">${label}<span class="chat-code-actions">` +
    `<button type="button" data-code-action="insert" data-code-index="${index}" title="Put this at the cursor in the open file">Insert at cursor</button>` +
    `<button type="button" data-code-action="copy" data-code-index="${index}">Copy</button>` +
    `</span></div><pre><code>${escapeHtml(code)}</code></pre></div>\n`
  );
}

md.renderer.rules.fence = (tokens, i, _opts, env) => {
  const t = tokens[i];
  const lang = t.info.trim().split(/\s+/)[0] ?? "";
  return codeBlock(t.content.replace(/\n$/, ""), lang, env as Env);
};
md.renderer.rules.code_block = (tokens, i, _opts, env) => codeBlock(tokens[i].content.replace(/\n$/, ""), "", env as Env);

// Links open in the browser (the message view handles the click); mark them.
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet("class", "chat-link");
  tokens[i].attrSet("rel", "noreferrer");
  return defaultLinkOpen(tokens, i, opts, env, self);
};

/** Renders a chat answer. Safe for any input: raw HTML is shown as text. */
export function renderMarkdown(text: string): RenderedMarkdown {
  const env: Env = { codes: [] };
  const html = md.render(text, env);
  return { html, codes: env.codes };
}

/** True for links the message view may open in the browser. */
export function isOpenableLink(href: string | null): href is string {
  return !!href && /^https?:\/\//i.test(href);
}
