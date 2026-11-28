// The bottom of the editor sidebar: Papers, background agent tasks, Support
// Texo and Project settings. It is always rendered, in the folded rail too
// (`compact`, icons only), so Support stays on screen at every sidebar width.
// Papers opens the paper library in an editor tab (or brings it forward),
// with the number of saved papers once the library has said.
import { useState } from "react";
import { BookOpen, Settings2 } from "lucide-react";
import { AgentTasksDock } from "../ai/dock/AgentTasksDock";
import { openPapersTab, useAiTabs } from "../ai/tabs/aiTabsStore";
import { SupportFooterButton } from "../components/SupportDialog";
import { Tooltip } from "../components/ui/Tooltip";
import { useLibrary } from "../library/libraryStore";
import { ProjectSettingsDialog } from "../project/ProjectSettingsDialog";

/** The Papers row, wired to the tabs and the library. */
export function PapersFooterButton({ compact }: { compact: boolean }) {
  const inFront = useAiTabs((s) => s.active === "papers");
  const saved = useLibrary((s) => (s.status?.available ? s.status.saved : null));
  return <PapersRow compact={compact} inFront={inFront} saved={saved} />;
}

/** The Papers row: an icon in the rail, icon, label and saved count (when known) otherwise. */
export function PapersRow({ compact, inFront, saved }: { compact: boolean; inFront: boolean; saved: number | null }) {
  const button = (
    <button
      type="button"
      onClick={openPapersTab}
      aria-label="Papers"
      aria-current={inFront ? "page" : undefined}
      className={`flex h-8 shrink-0 items-center gap-2 rounded-md text-[13px] transition-colors hover:bg-surface-2 hover:text-text ${
        inFront ? "bg-surface-2 text-text" : "text-muted"
      } ${compact ? "w-8 justify-center" : "w-full px-2"}`}
    >
      <BookOpen size={15} className="shrink-0" />
      {!compact && <span className="min-w-0 flex-1 truncate text-left">Papers</span>}
      {!compact && saved !== null && saved > 0 && (
        <span className="shrink-0 text-[11px] text-muted tabular-nums" title={`${saved} saved ${saved === 1 ? "paper" : "papers"}`}>
          {saved}
        </span>
      )}
    </button>
  );
  return compact ? (
    <Tooltip content="Papers" side="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export function SidebarFooter({ project, compact }: { project: string; compact: boolean }) {
  const [settings, setSettings] = useState(false);
  const settingsButton = (
    <button
      type="button"
      onClick={() => setSettings(true)}
      aria-label="Project settings"
      className={`flex h-8 shrink-0 items-center gap-2 rounded-md text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-text ${
        compact ? "w-8 justify-center" : "w-full px-2"
      }`}
    >
      <Settings2 size={15} className="shrink-0" />
      {!compact && <span className="truncate">Project settings</span>}
    </button>
  );
  return (
    <div className={`flex shrink-0 flex-col gap-0.5 border-t border-border p-1.5 ${compact ? "items-center" : ""}`}>
      <PapersFooterButton compact={compact} />
      <AgentTasksDock project={project} compact={compact} />
      <SupportFooterButton compact={compact} />
      {compact ? (
        <Tooltip content="Project settings" side="right">
          {settingsButton}
        </Tooltip>
      ) : (
        settingsButton
      )}
      <ProjectSettingsDialog project={project} open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}
