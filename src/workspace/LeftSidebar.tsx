// The editor's left sidebar: Files, Outline and Search, with the footer
// (Papers, background tasks, Support, Project settings) underneath.
// Ctrl+Shift+B (or Ctrl+B outside the editors, where it is Bold) or a
// double-click on its edge folds it to a 44px rail of icons. The tabs show
// icon and label when wide, the label alone in the middle and only the icon
// when narrow. Only the panel area clips its overflow, so the rail's side
// tooltips can open past the sidebar's edge. The panels stay mounted while
// hidden, so search text and tree scroll survive tab switches. Papers is not
// a tab here: its footer row opens the library in an editor tab.
import type { ReactNode } from "react";
import { Files, ListTree, Search } from "lucide-react";
import { Tabs, TabPanel, type TabItem } from "../components/ui/Tabs";
import { Tooltip } from "../components/ui/Tooltip";
import { FileTree } from "./FileTree";
import { sidebarTabStyle, useLayout, type SidebarTab } from "./layoutStore";
import { Outline } from "./Outline";
import { SearchPanel } from "./SearchPanel";
import { SidebarFooter } from "./SidebarFooter";

const ID = "sidebar";

export const SIDEBAR_TAB_ITEMS: (TabItem<SidebarTab> & { icon: ReactNode; rail: ReactNode })[] = [
  { id: "files", label: "Files", icon: <Files size={14} />, rail: <Files size={16} /> },
  { id: "outline", label: "Outline", icon: <ListTree size={14} />, rail: <ListTree size={16} /> },
  { id: "search", label: "Search", shortcut: "Ctrl+Shift+F", icon: <Search size={14} />, rail: <Search size={16} /> },
];

/** The tab row's items at a sidebar width: without their icons in the middle range. */
export function sidebarTabItems(width: number): TabItem<SidebarTab>[] {
  return sidebarTabStyle(width) === "labels" ? SIDEBAR_TAB_ITEMS.map(({ id, label, shortcut }) => ({ id, label, shortcut })) : SIDEBAR_TAB_ITEMS;
}

interface LeftSidebarProps {
  project: string;
  /** The folder under a file being dragged in from outside, for the tree to highlight. */
  dropTarget: string | null;
  /** Bumped by Ctrl+Shift+F so the search box takes focus even when shown. */
  searchFocus: number;
}

export function LeftSidebar({ project, dropTarget, searchFocus }: LeftSidebarProps) {
  const tab = useLayout((s) => s.sidebarTab);
  const collapsed = useLayout((s) => s.collapsed);
  const width = useLayout((s) => s.sidebar);
  const { setSidebarTab, showSidebarTab } = useLayout.getState();
  const style = sidebarTabStyle(width);

  return (
    <aside aria-label="Sidebar" className="@container/sidebar flex min-h-0 min-w-0 flex-col border-r border-border bg-surface/60">
      {collapsed ? (
        <nav aria-label="Sidebar tabs" className="flex flex-col items-center gap-1 border-b border-border py-1.5">
          {SIDEBAR_TAB_ITEMS.map((t) => (
            <Tooltip key={t.id} content={t.label} shortcut={t.shortcut} side="right">
              <button
                type="button"
                aria-label={t.label}
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => showSidebarTab(t.id)}
                className={`grid size-8 place-items-center rounded-md transition-colors ${
                  tab === t.id ? "bg-surface-2 text-text" : "text-muted hover:text-text"
                }`}
              >
                {t.rail}
              </button>
            </Tooltip>
          ))}
        </nav>
      ) : (
        <div className="border-b border-border p-1.5">
          <Tabs
            label="Sidebar tabs"
            idPrefix={ID}
            items={sidebarTabItems(width)}
            value={tab}
            onChange={setSidebarTab}
            iconOnly={style === "icons"}
            // The labels fit from the label cutoff with a little less padding.
            className={style === "labels" ? "[&_[role=tab]]:px-2" : ""}
          />
        </div>
      )}
      {/* With every panel hidden in the rail, this still fills the height and keeps the footer at the bottom. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabPanel idPrefix={ID} id="files" active={!collapsed && tab === "files"} className="flex min-h-0 flex-1 flex-col">
          <FileTree dropTarget={dropTarget} />
        </TabPanel>
        <TabPanel idPrefix={ID} id="outline" active={!collapsed && tab === "outline"} className="flex min-h-0 flex-1 flex-col">
          <Outline />
        </TabPanel>
        <TabPanel idPrefix={ID} id="search" active={!collapsed && tab === "search"} className="flex min-h-0 flex-1 flex-col">
          <SearchPanel focusKey={searchFocus} />
        </TabPanel>
      </div>
      <SidebarFooter project={project} compact={collapsed} />
    </aside>
  );
}
