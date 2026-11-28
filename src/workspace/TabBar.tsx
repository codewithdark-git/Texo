// The editor's tab strip: the open files, then the AI tabs (Chat, Agents,
// Papers, one per agent run), all in one tablist. A click (or Enter) shows a tab; the
// arrow keys, Home and End move between them; middle-click or × closes one.
// The Code/Visual toggle sits at the end while a file is in front.
import { useRef, type KeyboardEvent, type MouseEvent } from "react";
import { X } from "lucide-react";
import { nextIndex } from "../components/ui/Tabs";
import { AI_TAB_PANEL_ID, AiTabLabel, aiTabDomId, aiTabLabel, closeAiTab } from "../ai/tabs/AiTabView";
import { stripTabs, useAiTabs, type AiTabId, type StripTab } from "../ai/tabs/aiTabsStore";
import { useRuns } from "../ai/agents/runsStore";
import { ModeToggle } from "./ModeToggle";
import { baseName } from "./paths";
import { holdTabFocus, releaseTabFocus } from "./tabFocus";
import { useWorkspace } from "./store";

const TAB =
  "group flex max-w-56 shrink-0 cursor-default items-center gap-1.5 border-r border-border pr-1.5 pl-3 text-[13px] outline-none transition-colors duration-[var(--dur-1)] focus-visible:bg-surface-2 focus-visible:text-text";
const tabTone = (selected: boolean) => (selected ? "bg-bg text-text shadow-[inset_0_2px_0_var(--accent)]" : "text-muted hover:text-text");
const fileTabId = (i: number) => `editor-tab-file-${i}`;

/**
 * After a tab closes, keeps the keyboard in the strip: if focus was lost
 * (the closed tab, or the AI tab's content, left the page), the tab now in
 * front takes it. Focus that went somewhere else, a save prompt say, stays.
 */
export function focusSelectedTab() {
  requestAnimationFrame(() => {
    const el = document.activeElement;
    if (el && el !== document.body && el.isConnected) return;
    document.querySelector<HTMLElement>("[data-editor-tabs] [role=tab][aria-selected=true]")?.focus();
  });
}

export function TabBar() {
  const { tabs, active, status, openFile, closeTab } = useWorkspace();
  const aiTabs = useAiTabs((s) => s.tabs);
  const aiActive = useAiTabs((s) => s.active);
  const runs = useRuns((s) => s.runs);
  const list = useRef<HTMLDivElement>(null);
  const all = stripTabs(tabs, aiTabs);

  // With no tabs at all, a slim bar still holds the Code/Visual toggle (it hides itself when there is nothing to switch).
  if (all.length === 0)
    return (
      <div className="flex h-7 shrink-0 items-center justify-end border-b border-border bg-surface/60 empty:hidden">
        <ModeToggle />
      </div>
    );

  // Show the folder too when two open files share a name.
  const names = tabs.map(baseName);
  const label = (path: string, i: number) => (names.indexOf(names[i]) !== names.lastIndexOf(names[i]) ? path : names[i]);

  const isSelected = (t: StripTab) => (t.kind === "ai" ? t.id === aiActive : !aiActive && t.path === active);
  const show = (t: StripTab) => {
    if (t.kind === "ai") useAiTabs.getState().activate(t.id);
    // Showing a file puts it in front of any AI tab.
    else void openFile(t.path);
  };
  const close = (t: StripTab) => {
    if (t.kind === "ai") closeAiTab(t.id);
    else void closeTab(t.path);
    focusSelectedTab();
  };
  const selected = Math.max(0, all.findIndex(isSelected));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = all.findIndex((_, i) => list.current?.children[i] === document.activeElement);
    if (from < 0) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      releaseTabFocus();
      show(all[from]);
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      close(all[from]);
      return;
    }
    const to = nextIndex(e.key, from, all.length);
    if (to === null) return;
    e.preventDefault();
    // Showing the tab must not pull the keyboard into its editor.
    holdTabFocus();
    show(all[to]);
    (list.current?.children[to] as HTMLElement | undefined)?.focus();
  };

  const closeButton = (name: string, t: StripTab, dirty: boolean | undefined, sel: boolean) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`Close ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        close(t);
      }}
      className="relative flex size-5 shrink-0 items-center justify-center rounded hover:bg-surface-2"
    >
      {dirty ? (
        <>
          <span className="size-2 rounded-full bg-text/70 group-hover:hidden" />
          <X size={13} className="hidden group-hover:block" />
        </>
      ) : (
        <X size={13} className={sel ? "" : "invisible group-hover:visible group-focus-visible:visible"} />
      )}
    </button>
  );

  return (
    <div className="flex h-9 shrink-0 border-b border-border bg-surface/60">
      <div ref={list} role="tablist" aria-label="Open tabs" data-editor-tabs="" onKeyDown={onKeyDown} className="flex min-w-0 flex-1 overflow-x-auto">
        {all.map((t, i) => {
          const sel = isSelected(t);
          const common = {
            role: "tab",
            "aria-selected": sel,
            tabIndex: i === selected ? 0 : -1,
            onClick: () => {
              releaseTabFocus();
              show(t);
            },
            onAuxClick: (e: MouseEvent) => e.button === 1 && close(t),
          } as const;
          if (t.kind === "file") {
            const fi = tabs.indexOf(t.path);
            return (
              <div key={`f:${t.path}`} id={fileTabId(fi)} title={t.path} {...common} className={`${TAB} ${tabTone(sel)}`}>
                <span className="truncate">{label(t.path, fi)}</span>
                {closeButton(baseName(t.path), t, status[t.path]?.dirty, sel)}
              </div>
            );
          }
          const name = aiTabName(t.id, runs);
          return (
            <div
              key={`a:${t.id}`}
              id={aiTabDomId(t.id)}
              title={name}
              aria-controls={sel ? AI_TAB_PANEL_ID : undefined}
              {...common}
              className={`texo-fade-in ${TAB} ${tabTone(sel)} [animation-duration:var(--dur-1)]!`}
            >
              <AiTabLabel id={t.id} />
              {closeButton(name, t, false, sel)}
            </div>
          );
        })}
      </div>
      {!aiActive && <ModeToggle />}
    </div>
  );
}

function aiTabName(id: AiTabId, runs: ReturnType<typeof useRuns.getState>["runs"]): string {
  return aiTabLabel(id, id.startsWith("run:") ? runs[id.slice(4)] : undefined);
}
