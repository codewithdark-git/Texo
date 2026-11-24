// Every node and mark view Visual mode draws with, in one place, so the page
// and the read-only previews of included files look the same.

import type { MarkViewConstructor, NodeViewConstructor } from "prosemirror-view";
import { schema } from "../../core";
import type { GetEnv } from "../commands";
import { includeHooks } from "../includePreview";
import { mathView } from "./MathView";
import { rawView } from "./RawView";
import { commentView } from "./CommentView";
import { postambleView, preambleView } from "./PreambleView";
import { figureView } from "./FigureView";
import { tableView } from "./TableView";
import { citeView, footnoteView, glyphView, imageView, labelView, refView, softbreakView, urlView } from "./ChipViews";
import { commandView } from "./CommandView";
import { containerView, headingView, listItemView, listView } from "./BlockViews";
import { layoutMarkViews, layoutNodeViews } from "./LayoutViews";

export function buildNodeViews(getEnv: GetEnv): Record<string, NodeViewConstructor> {
  return {
    math_inline: mathView(getEnv),
    math_display: mathView(getEnv),
    raw_block: rawView(getEnv),
    raw_inline: rawView(getEnv),
    comment_block: commentView(getEnv),
    command_block: commandView(getEnv),
    preamble: preambleView(getEnv),
    postamble: postambleView(getEnv),
    figure: figureView(getEnv),
    table_block: tableView(getEnv),
    cite: citeView(getEnv),
    ref: refView(getEnv),
    label: labelView(getEnv),
    footnote: footnoteView(getEnv),
    url: urlView(getEnv),
    glyph: glyphView(getEnv),
    softbreak: softbreakView(getEnv),
    image: imageView(getEnv),
    heading: headingView(getEnv),
    list: listView(getEnv),
    list_item: listItemView(getEnv),
    container: containerView(getEnv),
    // Size, colour, spacing and alignment, once the core has those types.
    ...layoutNodeViews(schema, getEnv),
  };
}

export function buildMarkViews(): Record<string, MarkViewConstructor> {
  return layoutMarkViews(schema);
}

// Included files draw with the same views.
includeHooks.nodeViews = buildNodeViews;
includeHooks.markViews = buildMarkViews;
