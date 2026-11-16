import type { ReactNode } from "react";
import { Code2, Eye } from "lucide-react";
import { showsVisual, switchMode, VISUAL_MAX_BYTES } from "./editorBridge";
import { getModel, useWorkspace, visualSupported, type EditorMode } from "./store";

/** Code | Visual switch for the active file, at the right end of the tab bar. */
export function ModeToggle() {
  const active = useWorkspace((s) => s.active);
  const modes = useWorkspace((s) => s.modes);
  const isText = useWorkspace((s) => (s.active ? s.views[s.active]?.kind === "text" : false));
  if (!active || !isText) return null;
  const supported = visualSupported(active);
  // What is on screen: a file too large for Visual mode shows Code whatever its saved mode.
  const mode = showsVisual(active, modes) ? "visual" : "code";
  const tooLarge = supported && (getModel(active)?.getValueLength() ?? 0) > VISUAL_MAX_BYTES;

  const segment = (value: EditorMode, label: string, icon: ReactNode) => {
    const pressed = mode === value;
    return (
      <button
        type="button"
        aria-pressed={pressed}
        disabled={!supported || (value === "visual" && tooLarge)}
        title={
          !supported ? "Visual mode works with .tex and .md files" : value === "visual" && tooLarge ? "This file is too large for Visual mode (over 2 MB)" : `${label} (Ctrl+Shift+E)`
        }
        onClick={() => switchMode(active, value)}
        className={`flex h-6 items-center gap-1.5 px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
          pressed ? "bg-surface-2 text-text" : "text-muted hover:text-text"
        }`}
      >
        {icon}
        {label}
      </button>
    );
  };

  return (
    <div
      role="group"
      aria-label="Editor mode"
      title={supported ? undefined : "Visual mode works with .tex and .md files"}
      className="mx-2 flex shrink-0 items-center self-center overflow-hidden rounded-md border border-border"
    >
      {segment("code", "Code", <Code2 size={13} />)}
      <span className="h-6 w-px bg-border" />
      {segment("visual", "Visual", <Eye size={13} />)}
    </div>
  );
}
