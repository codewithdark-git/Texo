// The editor window's top bar: back, project name, Go to file, the Command
// Center in the middle, then compile, the layout switch, AI and the app menu.
// The Command Center and the AI button come in as slots from the Workspace,
// which owns what they need (the AI button also watches agent runs). Chat,
// Agents and agent runs open as editor tabs, not in a side panel.
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, Columns2, FileCode2, FileText } from "lucide-react";
import { Button } from "../components/Dialog";
import { AppMenu } from "../components/AppMenu";
import { Kbd } from "../components/ui/Kbd";
import { SegmentedControl, type SegmentOption } from "../components/ui/SegmentedControl";
import { prefersReducedMotion } from "../lib/motion";
import { useUi } from "../ui";
import { CompileControls } from "./CompileControls";
import { useLayout, type Layout } from "./layoutStore";

const LAYOUTS: SegmentOption<Layout>[] = [
  { value: "code", label: "Editor only", icon: <FileCode2 size={15} /> },
  { value: "split", label: "Editor and PDF", icon: <Columns2 size={15} /> },
  { value: "pdf", label: "PDF only", icon: <FileText size={15} /> },
];

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

/** Switches the layout, cross-fading the panes where the webview can and motion isn't reduced. */
export function switchLayout(layout: Layout) {
  const apply = () => useLayout.getState().setLayout(layout);
  const doc = typeof document === "undefined" ? undefined : (document as ViewTransitionDocument);
  if (!doc?.startViewTransition || prefersReducedMotion() || useLayout.getState().layout === layout) return apply();
  try {
    doc.startViewTransition(() => flushSync(apply));
  } catch {
    apply();
  }
}

interface TopBarProps {
  name: string;
  onBack: () => void;
  /** The Command Center pill, centred in the free space. */
  commandCenter: ReactNode;
  /** The AI button (opens the Chat tab, shows the finished-tasks badge). */
  ai: ReactNode;
}

export function TopBar({ name, onBack, commandCenter, ai }: TopBarProps) {
  const layout = useLayout((s) => s.layout);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <Button variant="ghost" onClick={onBack} aria-label="Back to projects">
        <ArrowLeft size={16} />
      </Button>
      <h1 className="max-w-48 shrink-0 truncate font-semibold" title={name}>
        {name}
      </h1>
      <button
        type="button"
        onClick={() => useUi.getState().openDialog("quickOpen")}
        title="Quick Open (Ctrl+P)"
        className="ml-2 hidden h-8 w-56 shrink items-center gap-2 rounded-lg border border-border bg-surface px-3 text-left text-[13px] text-muted hover:border-accent/50 md:flex"
      >
        <span className="flex-1 truncate">Go to file…</span>
        <Kbd>Ctrl+P</Kbd>
      </button>
      <div className="flex min-w-0 flex-1 justify-center">{commandCenter}</div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <CompileControls />
        <SegmentedControl label="Layout" iconOnly options={LAYOUTS} value={layout} onChange={switchLayout} />
        {ai}
        <AppMenu />
      </div>
    </header>
  );
}
