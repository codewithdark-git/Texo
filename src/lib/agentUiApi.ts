// Bindings for src-tauri/src/agents/ui_support.rs: the tools each agent kind
// can use (Settings > AI > Agents) and the review report's Markdown / LaTeX
// export (the Review view). Errors reject with a plain string (`errorText`).
import { invoke } from "@tauri-apps/api/core";
import type { AgentKindId } from "./agentsApi";
import type { ReviewReport } from "./reviewApi";

export type ReviewExportFormat = "md" | "tex";

export const agentUiApi = {
  /** Kind id -> the tool names a profile of that kind can pick from. */
  kindTools: () => invoke<Record<AgentKindId, string[]>>("agent_kind_tools"),
  /** The report as review.md / review.tex text (the same text a reviewer run writes). */
  renderReview: (report: ReviewReport, format: ReviewExportFormat) => invoke<string>("review_render", { report, format }),
  /** Renders and saves to a path from a save dialog (.md, .markdown, .txt or .tex only). */
  saveReviewAs: (report: ReviewReport, format: ReviewExportFormat, dest: string) =>
    invoke<void>("review_save_as", { report, format, dest }),
};
