import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertCircle, AlertTriangle, ExternalLink, Info, Lightbulb, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { SHOW_PDF_EVENT, type Issue, type Severity } from "../lib/api";
import { Button } from "../components/Dialog";
import { useCompile } from "./compileStore";
import { revealSource } from "./EditorPane";
import { ENGINE_NAMES } from "./CompileControls";
import { PdfViewer } from "./PdfViewer";
import { useWorkspace } from "./store";

type Tab = "pdf" | "issues" | "log";
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

/** The right-hand pane: the PDF, the compile issues, and the logs. */
export function CompilePanel() {
  const c = useCompile();
  const engine = useWorkspace((s) => s.project?.engine ?? "pdflatex");
  const [tab, setTab] = useState<Tab>("pdf");
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
  const lastResult = useRef(c.result);
  useEffect(() => {
    if (!c.result || c.result === lastResult.current) return;
    lastResult.current = c.result;
    if (!c.result.pdfPath && c.result.status !== "aborted") setTab("issues");
    else if (c.result.status === "success") setTab((t) => (t === "issues" ? "pdf" : t));
  }, [c.result]);

  useEffect(() => {
    const show = () => setTab("pdf");
    window.addEventListener(SHOW_PDF_EVENT, show);
    return () => window.removeEventListener(SHOW_PDF_EVENT, show);
  }, []);

  // Follow the live output while compiling.
  useEffect(() => {
    if (tab === "log" && c.compiling) logEnd.current?.scrollIntoView({ block: "end" });
  }, [c.output.length, tab, c.compiling]);

  const status = c.result?.status;
  const noEngine = status === "noEngine" || (c.toolchains && !c.result && !c.compiling && !hasAnyEngine(c.toolchains));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-[13px]">
        {(["pdf", "issues", "log"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-md px-2.5 py-1 ${tab === t ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}
          >
            {t === "pdf" ? "PDF" : t === "issues" ? `Issues${issues.length ? ` (${issues.length})` : ""}` : "Log"}
            {t === "issues" && counts.error > 0 && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-danger align-middle" />}
          </button>
        ))}
        <span className="ml-auto truncate pr-1 text-xs text-muted">
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

      {c.error && <p className="border-b border-danger/40 bg-danger/10 px-3 py-2 text-sm">{c.error}</p>}

      {noEngine ? (
        <NoEngine />
      ) : status === "noMainDocument" ? (
        <Empty text="There's no main document to compile. Right-click a .tex file and choose “Set as main document”." />
      ) : null}

      {/* The viewer stays mounted so its zoom and scroll survive tab switches. */}
      <div className={tab === "pdf" && !noEngine && status !== "noMainDocument" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        {c.result?.rcIgnored && <TrustBanner onTrust={() => void c.trust()} />}
        <PdfViewer />
      </div>

      {noEngine || status === "noMainDocument" || tab === "pdf" ? null : tab === "issues" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {c.result?.rcIgnored && <TrustBanner onTrust={() => void c.trust()} />}
          {c.result?.hints.map((h) => (
            <div key={h} className="mx-3 mt-3 flex gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm">
              <Lightbulb size={15} className="mt-0.5 shrink-0 text-accent" />
              <span>{h}</span>
            </div>
          ))}
          {issues.length > 0 && (
            <div className="flex gap-1 px-3 pt-3 pb-1 text-xs">
              {(
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
            </div>
          )}
          <ul className="p-2">
            {shown.map((issue, i) => {
              const { icon: Icon, className } = ICONS[issue.severity];
              return (
                <li key={i}>
                  <button
                    type="button"
                    disabled={!issue.file}
                    onClick={() => void goTo(issue)}
                    className="flex w-full gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] enabled:hover:bg-surface-2"
                  >
                    <Icon size={15} className={`mt-0.5 shrink-0 ${className}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">{issue.message}</span>
                      {issue.file && (
                        <span className="block font-mono text-[11px] text-muted">
                          {issue.file}
                          {issue.line ? `:${issue.line}` : ""}
                        </span>
                      )}
                      {issue.context && issue.severity === "error" && (
                        <pre className="mt-1 overflow-x-auto rounded bg-bg px-2 py-1 font-mono text-[11px] text-muted">
                          {issue.context}
                        </pre>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {c.result && issues.length === 0 && !c.compiling && status !== "aborted" && (
            <Empty text="No errors or warnings." />
          )}
          {!c.result && !c.compiling && <Empty text="Press Compile (Ctrl+Enter) to build the PDF." />}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
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
    </div>
  );
}

function statusLine(status: string, ms: number, errors: number): string {
  switch (status) {
    case "success":
      return `Compiled in ${formatDuration(ms)}`;
    case "failed":
      return errors ? `${errors} ${errors === 1 ? "error" : "errors"} · ${formatDuration(ms)}` : `No PDF produced · ${formatDuration(ms)}`;
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
        Texo compiles with MiKTeX or TeX Live. Install MiKTeX (free), then check again. A built-in engine is planned
        for a later version.
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
