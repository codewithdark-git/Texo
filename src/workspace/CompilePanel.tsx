import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  FileText,
  History as HistoryIcon,
  Info,
  Lightbulb,
  Loader2,
  RefreshCw,
  ScrollText,
  ShieldAlert,
} from "lucide-react";
import type { Issue, Severity } from "../lib/api";
import { ExplainIssueButton, FixIssuesButton } from "../ai/AiButtons";
import { Button } from "../components/Dialog";
import { Tabs, TabPanel, panelId, tabId, type TabItem } from "../components/ui/Tabs";
import { HistoryPanel } from "../history/HistoryPanel";
import { bibtexBackendEdit, parseHint } from "../editor/biblatexFix";
import { toast } from "../ui";
import { useCompile } from "./compileStore";
import { consequenceSummary, groupIssues } from "./diagnostics";
import { InstallPackageFix } from "./InstallPackageFix";
import { COMPILE_TABS, useLayout, type RightTab } from "./layoutStore";
import { revealSource } from "./EditorPane";
import { ENGINE_NAMES } from "./CompileControls";
import { PdfViewer } from "./PdfViewer";
import { getModel, useWorkspace } from "./store";

/** Below this width the tabs show icons only, with the label in a tooltip. */
const LABELS_MIN = 300;
const ID = "right";
type Filter = "all" | "error" | "warning" | "badbox";

const ICONS: Record<Severity, { icon: typeof AlertCircle; className: string }> = {
  error: { icon: AlertCircle, className: "text-danger" },
  warning: { icon: AlertTriangle, className: "text-amber-400" },
  badbox: { icon: Info, className: "text-muted" },
};

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

async function goTo(issue: Issue) {
  if (issue.file) await revealSource(issue.file, issue.line ?? 1);
}

/**
 * Switches the main document's biblatex to the BibTeX backend. The edit goes
 * through the file's editor model, so Ctrl+Z undoes it and saving and
 * auto-compile pick it up like a typed change.
 */
async function switchToBibtexBackend() {
  const ws = useWorkspace.getState();
  const main = ws.project?.mainDocument;
  if (!main) return;
  if (!getModel(main)) await ws.openFile(main);
  const model = getModel(main);
  if (!model) {
    toast(`Couldn't open ${main}.`, "error");
    return;
  }
  const edit = bibtexBackendEdit(model.getValue());
  if (!edit) {
    toast(`${main} has no \\usepackage{biblatex} that uses Biber.`, "info");
    return;
  }
  const from = model.getPositionAt(edit.start);
  const to = model.getPositionAt(edit.end);
  model.pushStackElement();
  model.pushEditOperations(
    [],
    [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: edit.text }],
    () => null,
  );
  model.pushStackElement();
  // Save now rather than waiting for autosave; saving starts the auto-compile.
  await useWorkspace.getState().save(main);
  if (!useCompile.getState().auto) void useCompile.getState().compile();
  toast(`${main} now uses BibTeX for the bibliography.`);
}

/** A compile hint; one that carries a fix marker gets a button that applies it. */
function Hint({ hint }: { hint: string }) {
  const { fix, arg, text } = parseHint(hint);
  return (
    <div className="mx-3 mt-3 flex gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm">
      <Lightbulb size={15} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <span>{text}</span>
        {fix === "biblatex-bibtex" && (
          <Button className="mt-2" onClick={() => void switchToBibtexBackend()}>
            Use BibTeX backend
          </Button>
        )}
        {fix === "install-package" && arg && <InstallPackageFix pkg={arg} />}
      </div>
    </div>
  );
}

/** Whether `el` is narrower than `min`, followed as it resizes. */
function useNarrow(el: RefObject<HTMLElement | null>, min: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setNarrow(node.clientWidth < min));
    observer.observe(node);
    return () => observer.disconnect();
  }, [el, min]);
  return narrow;
}

/** The right-hand pane: the PDF, the compile issues, the logs and the project's history. */
export function CompilePanel({ project }: { project: string }) {
  const c = useCompile();
  const engine = useWorkspace((s) => s.project?.engine ?? "pdflatex");
  const tab = useLayout((s) => s.rightTab);
  const setTab = useLayout((s) => s.setRightTab);
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root, LABELS_MIN);
  // History mounts on first view, then stay mounted so their scroll and inputs survive.
  const [visited, setVisited] = useState<Partial<Record<RightTab, true>>>(() => ({ [useLayout.getState().rightTab]: true }));
  useEffect(() => setVisited((v) => (v[tab] ? v : { ...v, [tab]: true })), [tab]);
  const [filter, setFilter] = useState<Filter>("all");
  const [showTexLog, setShowTexLog] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);

  const issues = c.result?.issues ?? [];
  const counts = useMemo(
    () => ({
      error: issues.filter((i) => i.severity === "error").length,
      warning: issues.filter((i) => i.severity === "warning").length,
      badbox: issues.filter((i) => i.severity === "badbox").length,
    }),
    [issues],
  );
  const shown = filter === "all" ? issues : issues.filter((i) => i.severity === filter);

  // Show the issues when a compile produced no PDF, and the PDF again once it works.
  // History is never switched away from (see autoTabAfterCompile).
  const lastResult = useRef(c.result);
  useEffect(() => {
    if (!c.result || c.result === lastResult.current) return;
    lastResult.current = c.result;
    // A PDF left from an earlier compile doesn't help when TeX stopped on an error.
    const stopped = c.result.status === "failed" && c.result.issues.some((i) => i.fatal);
    if ((!c.result.pdfPath || stopped) && c.result.status !== "aborted") useLayout.getState().afterCompile("failed");
    else if (c.result.status === "success") useLayout.getState().afterCompile("success");
  }, [c.result]);

  // Follow the live output while compiling.
  useEffect(() => {
    if (tab === "log" && c.compiling) logEnd.current?.scrollIntoView({ block: "end" });
  }, [c.output.length, tab, c.compiling]);

  const status = c.result?.status;
  const noEngine = status === "noEngine" || (c.toolchains && !c.result && !c.compiling && !hasAnyEngine(c.toolchains));
  const compileTab = COMPILE_TABS.includes(tab);
  const errorDot = counts.error > 0 && <span aria-hidden="true" className="inline-block size-1.5 shrink-0 rounded-full bg-danger" />;
  const tabs: TabItem<RightTab>[] = [
    { id: "pdf", label: "PDF", icon: <FileText size={14} /> },
    {
      id: "issues",
      label: `Issues${issues.length ? ` (${issues.length})` : ""}`,
      icon: (
        <span className="relative flex">
          <AlertCircle size={14} />
          {narrow && counts.error > 0 && <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-danger" />}
        </span>
      ),
      badge: errorDot,
    },
    { id: "log", label: "Log", icon: <ScrollText size={14} /> },
    { id: "history", label: "History", icon: <HistoryIcon size={14} /> },
  ];

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-[13px]">
        <Tabs label="Preview panel" idPrefix={ID} items={tabs} value={tab} onChange={setTab} iconOnly={narrow} className="shrink-0" />
        <span className={`ml-auto min-w-0 truncate pr-1 text-xs text-muted ${compileTab ? "" : "hidden"}`}>
          {c.compiling ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Compiling with {ENGINE_NAMES[engine]}…
            </span>
          ) : c.result ? (
            statusLine(c.result.status, c.result.durationMs, counts.error)
          ) : (
            "Not compiled yet"
          )}
        </span>
      </div>

      {compileTab && c.error && <p className="border-b border-danger/40 bg-danger/10 px-3 py-2 text-sm">{c.error}</p>}

      {!compileTab ? null : noEngine ? (
        <NoEngine />
      ) : status === "noMainDocument" ? (
        <Empty text="There's no main document to compile. Right-click a .tex file and choose “Set as main document”." />
      ) : null}

      {/* The viewer stays mounted so its zoom and scroll survive tab switches. */}
      <div
        id={panelId(ID, "pdf")}
        role="tabpanel"
        aria-labelledby={tabId(ID, "pdf")}
        className={tab === "pdf" && !noEngine && status !== "noMainDocument" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      >
        {c.result?.rcIgnored && <TrustBanner onTrust={() => void c.trust()} />}
        <PdfViewer />
      </div>

      {!compileTab || noEngine || status === "noMainDocument" || tab === "pdf" ? null : tab === "issues" ? (
        <div id={panelId(ID, "issues")} role="tabpanel" aria-labelledby={tabId(ID, "issues")} className="min-h-0 flex-1 overflow-auto">
          {c.result?.rcIgnored && <TrustBanner onTrust={() => void c.trust()} />}
          {c.result?.hints.map((h) => <Hint key={h} hint={h} />)}
          {(issues.length > 0 || status === "failed") && (
            // Sticky, so "Fix issues" stays in reach from every scroll position.
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 bg-[color-mix(in_srgb,var(--surface-2)_40%,var(--bg))] px-3 pt-3 pb-2 text-xs">
              {issues.length > 0 && (
                [
                  ["all", `All ${issues.length}`],
                  ["error", `Errors ${counts.error}`],
                  ["warning", `Warnings ${counts.warning}`],
                  ["badbox", `Layout ${counts.badbox}`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={`rounded-full border px-2.5 py-0.5 ${
                    filter === value ? "border-accent bg-accent/15 text-text" : "border-border text-muted hover:text-text"
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto flex shrink-0 items-center">
                <FixIssuesButton project={project} counts={counts} status={c.compiling ? "compiling" : status} />
              </span>
            </div>
          )}
          <IssueList issues={shown} />
          {c.result && issues.length === 0 && !c.compiling && status !== "aborted" && (
            <Empty text="No errors or warnings." />
          )}
          {!c.result && !c.compiling && <Empty text="Press Compile (Ctrl+Enter) to build the PDF." />}
        </div>
      ) : (
        <div id={panelId(ID, "log")} role="tabpanel" aria-labelledby={tabId(ID, "log")} className="flex min-h-0 flex-1 flex-col">
          <label className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted">
            <input type="checkbox" checked={showTexLog} onChange={(e) => setShowTexLog(e.target.checked)} />
            Show the full TeX log file instead of console output
          </label>
          <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-text/85 select-text">
            {showTexLog ? c.result?.log || "No log file yet." : c.output.join("\n") || c.result?.output || "No output yet."}
            <div ref={logEnd} />
          </pre>
        </div>
      )}

      {visited.history && (
        <TabPanel idPrefix={ID} id="history" active={tab === "history"} className="flex min-h-0 flex-1 flex-col">
          <HistoryPanel />
        </TabPanel>
      )}
    </div>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const { icon: Icon, className } = ICONS[issue.severity];
  return (
    <li className="flex gap-1">
      <button
        type="button"
        disabled={!issue.file}
        onClick={() => void goTo(issue)}
        className="flex min-w-0 flex-1 gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] enabled:hover:bg-surface-2"
      >
        <Icon size={15} className={`mt-0.5 shrink-0 ${className}`} />
        <span className="min-w-0 flex-1">
          {issue.fatal && (
            <span className="mb-0.5 block text-[11px] font-medium tracking-wide text-danger uppercase">TeX stopped here</span>
          )}
          <span className="block break-words">{issue.message}</span>
          {issue.file && (
            <span className="block font-mono text-[11px] text-muted">
              {issue.file}
              {issue.line ? `:${issue.line}` : ""}
            </span>
          )}
          {issue.explanation && <span className="mt-1 block text-[12px] leading-relaxed text-text/85">{issue.explanation}</span>}
          {issue.context && issue.severity === "error" && (
            <pre className="mt-1 overflow-x-auto rounded bg-bg px-2 py-1 font-mono text-[11px] text-muted">{issue.context}</pre>
          )}
        </span>
      </button>
      <ExplainIssueButton issue={issue} />
    </li>
  );
}

/**
 * The issues, with the citations and references that are only undefined
 * because TeX stopped early folded into a group of their own below.
 */
function IssueList({ issues }: { issues: Issue[] }) {
  const { main, consequences } = groupIssues(issues);
  return (
    <>
      <ul className="p-2">
        {main.map((issue, i) => (
          <IssueRow key={i} issue={issue} />
        ))}
      </ul>
      {consequences.length > 0 && (
        <details className="mx-3 mb-3 rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted select-none hover:text-text">
            {consequenceSummary(consequences)}. Fix the error above first.
          </summary>
          <ul className="px-2 pb-2 opacity-75">
            {consequences.map((issue, i) => (
              <IssueRow key={i} issue={issue} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function statusLine(status: string, ms: number, errors: number): string {
  switch (status) {
    case "success":
      return `Compiled in ${formatDuration(ms)}`;
    case "failed":
      return errors
        ? `Failed · ${errors} ${errors === 1 ? "error" : "errors"} · ${formatDuration(ms)}`
        : `Failed · no PDF produced · ${formatDuration(ms)}`;
    case "aborted":
      return "Stopped";
    case "timeout":
      return "Timed out";
    default:
      return "";
  }
}

function hasAnyEngine(tc: NonNullable<ReturnType<typeof useCompile.getState>["toolchains"]>) {
  return !!(tc.pdflatex || tc.xelatex || tc.lualatex || tc.tectonic);
}

function TrustBanner({ onTrust }: { onTrust: () => void }) {
  return (
    <div className="mx-3 mt-3 flex gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
      <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="flex-1">
        <p>
          This project has a <span className="font-mono">latexmkrc</span> file. It can run programs on your PC, so Texo
          skipped it. Trust the project only if you know where it came from.
        </p>
        <Button className="mt-2" onClick={onTrust}>
          Trust this project
        </Button>
      </div>
    </div>
  );
}

function NoEngine() {
  const refresh = useCompile((s) => s.refreshToolchains);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangle size={28} className="text-amber-400" />
      <p className="font-medium">No LaTeX installation found</p>
      <p className="max-w-sm text-sm text-muted">
        Texo's built-in engine is missing, and no MiKTeX or TeX Live was found. Reinstall Texo to restore the built-in
        engine, or install MiKTeX, then check again.
      </p>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void openUrl("https://miktex.org/download")}>
          <ExternalLink size={14} /> Get MiKTeX
        </Button>
        <Button onClick={() => void refresh()}>
          <RefreshCw size={14} /> Check again
        </Button>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-6 py-10 text-center text-sm text-muted">{text}</p>;
}
