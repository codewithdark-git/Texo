// The shared markdown-it instance: CommonMark plus GFM tables and strikethrough,
// raw HTML allowed, no linkify or typographic replacements, and our maths
// rules. text_join is off so escapes and entities stay separate tokens.

import MarkdownIt from "markdown-it";
import { mathPlugin } from "./rules";

/** markdown-it's env: reference definitions collected by a parse. */
export type MdEnv = Record<string, unknown>;

export const md = new MarkdownIt({ html: true, linkify: false, typographer: false }).use(mathPlugin);
md.core.ruler.disable("text_join");
