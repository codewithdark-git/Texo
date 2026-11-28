import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";
import { SHOW_PDF_EVENT, type ProjectSummary } from "../lib/api";
import { useApp } from "../store";
import { toast, useUi } from "../ui";
import { useCompile } from "./compileStore";
import { baseName } from "./paths";
import { QuickOpen } from "./QuickOpen";
import { FixDialog } from "../ai/FixDialog";
import { AiPanelButton } from "../ai/panel/AiPanel";
import { useAiPanel } from "../ai/panel/aiPanelStore";
import { AgentDialogs } from "../ai/agents/AgentsTab";
import { listenChatEvents } from "../ai/chat/chatStore";
import { AiTabView, aiTabLabel, closeAiTab, useAiTabsSync } from "../ai/tabs/AiTabView";
import { cycleTab, runIdOf, useAiTabs } from "../ai/tabs/aiTabsStore";
import { useRuns } from "../ai/agents/runsStore";
import { attachPaths, CHAT_DROP_ATTR } from "../ai/chat/composerActions";
import { CommandCenter } from "../ai/command/CommandCenter";
import { AiComposerBar, useComposerShortcutFallback } from "../ai/composer/AiComposerBar";
import { routeDrop } from "../ai/pathDrop";
import { zoomEditor } from "./EditorPane";
import { CompilePanel } from "./CompilePanel";
import { EditorPane } from "./EditorPane";
import { LeftSidebar } from "./LeftSidebar";
import { sidebarColumn, useLayout } from "./layoutStore";
import { StatusBar } from "./StatusBar";
import { focusSelectedTab, TabBar } from "./TabBar";
import { TopBar } from "./TopBar";
import { useWorkspace } from "./store";
import { useHistory } from "../history/historyStore";

/** Starts a drag that reports the pointer's x position until release. */
function startDrag(e: ReactPointerEvent, onMove: (x: number) => void, onEnd: (moved: boolean) => void) {
  e.preventDefault();
  let moved = false;
  const move = (ev: PointerEvent) => {
    moved = true;
    onMove(ev.clientX);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
    onEnd(moved);
  };
  document.body.style.cursor = "col-resize";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function Workspace({ project }: { project: ProjectSummary }) {
  const ws = useWorkspace();
  const dialog = useUi((s) => s.dialog);
  const layout = useLayout((s) => s.layout);
  const split = useLayout((s) => s.split);
  const column = useLayout(sidebarColumn);
  // The sidebar's width animates when it folds or unfolds, but follows the pointer at once while dragged.
  const [resizing, setResizing] = useState(false);
  // Bumped by Ctrl+Shift+F so the search box takes focus even when shown.
  const [searchFocus, setSearchFocus] = useState(0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // True once the project's files are open, so its AI tabs can come back.
  const [ready, setReady] = useState(false);
  const aiTab = useAiTabs((s) => s.active);
  const body = useRef<HTMLDivElement>(null);
  // The bar lives under the editor; in "PDF only" Ctrl+J brings the editor side back for it.
  useComposerShortcutFallback();

  const close = async () => {
    useCompile.getState().reset();
    await useWorkspace.getState().teardown();
    void useApp.getState().refresh().catch(() => {});
    useApp.getState().open(null);
  };

  useEffect(() => {
    let live = true;
    setReady(false);
    void useWorkspace
      .getState()
      .init(project)
      .then(() => {
        if (live) setReady(true);
        return useCompile.getState().init();
      });
    return () => {
      live = false;
      useCompile.getState().reset();
      void useWorkspace.getState().teardown();
    };
  }, [project.path]);

  // Chat, Agents and agent runs open as editor tabs; they come back per project.
  useAiTabsSync(project.id, project.path, ready);
  // Chat answers are heard whatever tab shows.
  useEffect(() => listenChatEvents(), []);

  // History status for the status bar and the History tab; new versions
  // appear after saves (30 s idle), compiles and AI runs, so check now and then.
  useEffect(() => {
    useHistory.getState().setProject(project.path);
    const timer = setInterval(() => void useHistory.getState().refreshStatus(), 30_000);
    const offCompile = useCompile.subscribe((s, prev) => {
      if (s.finishedAt !== prev.finishedAt) void useHistory.getState().refreshStatus();
    });
    return () => {
      clearInterval(timer);
      offCompile();
      useHistory.getState().setProject(null);
    };
  }, [project.path]);

  // Showing the PDF needs the preview pane visible.
  useEffect(() => {
    const show = () => useLayout.getState().openRightTab("pdf");
    window.addEventListener(SHOW_PDF_EVENT, show);
    return () => window.removeEventListener(SHOW_PDF_EVENT, show);
  }, []);

  // Window title: the tab in front (a file, Chat, Agents or a run) and the project.
  const active = ws.active;
  const projectName = ws.project?.name ?? project.name;
  const aiRunId = aiTab ? runIdOf(aiTab) : null;
  const aiRun = useRuns((s) => (aiRunId ? s.runs[aiRunId] : undefined));
  const front = aiTab ? aiTabLabel(aiTab, aiRun) : active ? baseName(active) : null;
  useEffect(() => {
    const title = front ? `${front} — ${projectName} — Texo` : `${projectName} — Texo`;
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [front, projectName]);

  // Workspace shortcuts. Monaco keeps the keys it uses itself (Ctrl+F, …);
  // these reach the window from the editor and everywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const state = useWorkspace.getState();
      const key = e.key.toLowerCase();
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (key === "a" && e.shiftKey) {
        handled();
        useAiPanel.getState().show("chat");
      } else if (key === "f" && e.shiftKey) {
        handled();
        useLayout.getState().showSidebarTab("search");
        setSearchFocus((n) => n + 1);
      } else if (key === "b") {
        // Ctrl+B is Bold in both editors, which take the key first, so there
        // only Ctrl+Shift+B folds the sidebar. Elsewhere either one does.
        handled();
        useLayout.getState().toggleSidebar();
      } else if (key === "enter") {
        handled();
        void useCompile.getState().compile();
      } else if (key === "p" && !e.shiftKey) {
        handled();
        useUi.getState().openDialog("quickOpen");
      } else if (key === "w" && !e.shiftKey) {
        handled();
        const ai = useAiTabs.getState().active;
        if (ai) closeAiTab(ai);
        else if (state.active) void state.closeTab(state.active);
        focusSelectedTab();
      } else if (key === "tab") {
        // Through files and AI tabs alike.
        const next = cycleTab(state.tabs, state.active, useAiTabs.getState(), e.shiftKey);
        if (!next) return;
        handled();
        if (next.kind === "ai") useAiTabs.getState().activate(next.id);
        else void state.openFile(next.path);
      } else if ((key === "=" || key === "+") && !e.shiftKey) {
        handled();
        zoomEditor(1);
      } else if (key === "-" && !e.shiftKey) {
        handled();
        zoomEditor(-1);
      } else if (key === "0" && !e.shiftKey) {
        handled();
        zoomEditor(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Save everything before the window closes.
  useEffect(() => {
    const pending = getCurrentWindow().onCloseRequested(async () => {
      await useWorkspace.getState().saveAll();
    });
    return () => void pending.then((off) => off());
  }, []);

  // Dropping files from File Explorer copies them into the folder under the pointer.
  useEffect(() => {
    const folderAt = (x: number, y: number): string | null => {
      const ratio = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(x / ratio, y / ratio);
      const target = el?.closest<HTMLElement>("[data-drop-dir]");
      return target ? (target.dataset.dropDir ?? "") : null;
    };
    const pending = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      // Files dropped on the chat composer are attached to the message instead.
      const overChat = (x: number, y: number) => {
        const ratio = window.devicePixelRatio || 1;
        return !!document.elementFromPoint(x / ratio, y / ratio)?.closest(`[${CHAT_DROP_ATTR}]`);
      };
      if (p.type === "drop" && overChat(p.position.x, p.position.y)) {
        setDropTarget(null);
        attachPaths(p.paths);
        return;
      }
      // A dialog that takes attachments gets them; other dialogs take nothing (FE-2).
      if (p.type === "drop") {
        const ratio = window.devicePixelRatio || 1;
        const route = routeDrop(document.elementFromPoint(p.position.x / ratio, p.position.y / ratio));
        if (route) {
          setDropTarget(null);
          if (route === "blocked") toast("Close this window first to add files to the project.", "info");
          else route(p.paths);
          return;
        }
      }
      if (p.type === "over") setDropTarget(folderAt(p.position.x, p.position.y));
      else if (p.type === "leave") setDropTarget(null);
      else if (p.type === "drop") {
        setDropTarget(null);
        const dest = folderAt(p.position.x, p.position.y) ?? "";
        void useWorkspace.getState().importFiles(dest, p.paths);
      }
    });
    return () => void pending.then((off) => off());
  }, []);

  const showCode = layout !== "pdf";
  const showPdf = layout !== "code";
  const name = ws.project?.name ?? project.name;

  return (
    <div className="flex h-full flex-col">
      {dialog === "quickOpen" && <QuickOpen onClose={() => useUi.getState().openDialog(null)} />}
      <FixDialog />
      <AgentDialogs project={project.path} />
      <TopBar
        name={name}
        onBack={() => void close()}
        commandCenter={<CommandCenter project={project.path} />}
        ai={<AiPanelButton project={project.path} />}
      />

      {ws.error && (
        <div role="alert" className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm">
          <span className="flex-1">{ws.error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => ws.setError(null)} className="text-muted hover:text-text">
            <X size={15} />
          </button>
        </div>
      )}

      <div
        ref={body}
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: `${column}px 4px minmax(0, 1fr)`,
          transition: resizing ? undefined : "grid-template-columns var(--dur-3) var(--ease-standard)",
        }}
      >
        <LeftSidebar project={project.path} dropTarget={dropTarget} searchFocus={searchFocus} />
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize. Double-click to fold (Ctrl+Shift+B)."
          onDoubleClick={() => useLayout.getState().toggleSidebar()}
          onPointerDown={(e) => {
            setResizing(true);
            startDrag(
              e,
              (x) => {
                const left = body.current?.getBoundingClientRect().left ?? 0;
                useLayout.getState().setSidebarWidth(x - left, false);
              },
              (moved) => {
                setResizing(false);
                if (moved) useLayout.getState().setSidebarWidth(useLayout.getState().sidebar);
              },
            );
          }}
          className="cursor-col-resize hover:bg-accent/40"
        />

        <div className="flex min-h-0 min-w-0">
          {showCode && (
            <section style={{ flex: showPdf ? split : 1 }} className="flex min-w-0 flex-col">
              <TabBar />
              {/* The editor stays mounted (cursor, scroll, undo) while an AI tab takes its place. */}
              <div className={aiTab ? "hidden" : "contents"}>
                <EditorPane />
              </div>
              {aiTab && <AiTabView project={project.path} tab={aiTab} />}
              <AiComposerBar project={project.path} />
            </section>
          )}
          {showCode && showPdf && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize editor and preview"
              onPointerDown={(e) => {
                const host = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                startDrag(
                  e,
                  (x) => useLayout.getState().setSplit((x - host.left) / host.width, false),
                  (moved) => moved && useLayout.getState().setSplit(useLayout.getState().split),
                );
              }}
              className="w-1 shrink-0 cursor-col-resize border-l border-border hover:bg-accent/40"
            />
          )}
          {showPdf && (
            <section style={{ flex: showCode ? 1 - split : 1 }} className="flex min-w-0 flex-col bg-surface-2/40">
              <CompilePanel project={project.path} />
            </section>
          )}
        </div>
      </div>

      {/* Full width, below the panes, so it shows in every layout. */}
      <StatusBar />
    </div>
  );
}
