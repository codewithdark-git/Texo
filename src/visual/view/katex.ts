// Maths previews with KaTeX, bundled (fonts included) so they work offline
// and within the app's content security policy.

import katex from "katex";
import "katex/dist/katex.min.css";

export interface Rendered {
  html: string;
  /** KaTeX could not render it; html is then empty. */
  error: string | null;
}

const MAX = 2000;
const cache = new Map<string, Rendered>();

/** \label{..} and \tag{..} are LaTeX's business, not the preview's. */
export function stripForPreview(tex: string): { tex: string; labels: string[] } {
  const labels: string[] = [];
  const out = tex
    .replace(/\\label\s*\{([^{}]*)\}/g, (_m, key: string) => {
      labels.push(key);
      return "";
    })
    .replace(/\\(?:no)?tag\*?\s*(?:\{[^{}]*\})?/g, "")
    .replace(/\\(?:nonumber|notag)\b/g, "");
  return { tex: out, labels };
}

/** Display environments KaTeX understands as-is. */
const KATEX_ENVS = /^(align|aligned|gather|gathered|multline|split|equation|alignat|flalign|cases|matrix)\*?$/;

/** The TeX to hand KaTeX for a display node: its body, inside its environment when KaTeX knows it. */
export function displayTex(body: string, env: string): string {
  if (!env || env === "equation" || env === "equation*" || env === "displaymath" || env === "math") return body;
  const base = env.replace(/\*$/, "");
  if (base === "align" || base === "flalign") return `\\begin{aligned}${body}\\end{aligned}`;
  if (base === "gather") return `\\begin{gathered}${body}\\end{gathered}`;
  if (base === "multline") return `\\begin{gathered}${body}\\end{gathered}`;
  if (base === "alignat") return `\\begin{aligned}${body.replace(/^\s*\{\d+\}/, "")}\\end{aligned}`;
  if (KATEX_ENVS.test(env)) return `\\begin{${env}}${body}\\end{${env}}`;
  return body;
}

export function renderTex(tex: string, display: boolean, macros: Record<string, string> = {}, macrosHash = ""): Rendered {
  const key = (display ? "D" : "I") + macrosHash + "\0" + tex;
  const hit = cache.get(key);
  if (hit) {
    // Refresh its place in the LRU.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let result: Rendered;
  try {
    const html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      // KaTeX writes \gdef results into this object; never let it touch the document's.
      macros: { ...macros },
      output: "htmlAndMathml",
    });
    result = { html, error: null };
  } catch (err) {
    result = { html: "", error: err instanceof Error ? err.message : String(err) };
  }
  cache.set(key, result);
  if (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  return result;
}
