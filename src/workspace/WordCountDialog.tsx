// The detailed word count, opened from the status bar: the whole document
// (the main file and everything it includes) or just the open file.
import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Button, Modal } from "../components/Dialog";
import { api } from "../lib/api";
import {
  countDetailed,
  countMarkdownWords,
  countProject,
  totalWords,
  type DetailedCount,
  type FileCount,
} from "../lib/wordcount";
import { toast } from "../ui";
import { getModel, useWorkspace } from "./store";

type Scope = "document" | "file";

interface Report {
  /** Null for a Markdown file, which only has a word count. */
  totals: DetailedCount | null;
  words: number;
  files: FileCount[];
}

/** A file's current text: the editor's copy if it's open, else the disk's. */
async function readText(project: string, path: string): Promise<string | null> {
  const model = getModel(path);
  if (model) return model.getValue();
  try {
    const content = await api.readFile(project, path);
    return content.kind === "text" ? content.content : null;
  } catch {
    return null;
  }
}

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

async function buildReport(project: string, scope: Scope, main: string | null, active: string | null): Promise<Report | null> {
  if (scope === "document" && main) {
    const result = await countProject(main, (path) => readText(project, path));
    return { totals: result.totals, words: totalWords(result.totals), files: result.files };
  }
  if (!active) return null;
  const text = await readText(project, active);
  if (text === null) return null;
  if (isMarkdown(active)) return { totals: null, words: countMarkdownWords(text), files: [] };
  const stats = countDetailed(text);
  return { totals: stats, words: totalWords(stats), files: [{ path: active, stats }] };
}

const METRICS: [keyof DetailedCount, string][] = [
  ["textWords", "Words in text"],
  ["headingWords", "Words in headings"],
  ["captionWords", "Words in captions"],
  ["footnoteWords", "Words in footnotes"],
  ["characters", "Characters (no spaces)"],
  ["headings", "Headings"],
  ["figures", "Figures"],
  ["tables", "Tables"],
  ["inlineMath", "Inline formulas"],
  ["displayMath", "Displayed formulas"],
  ["citations", "Citations"],
];

function summary(report: Report, label: string): string {
  const lines = [`Word count: ${label}`, `Total words: ${report.words.toLocaleString()}`];
  if (report.totals) {
    for (const [key, name] of METRICS) lines.push(`${name}: ${report.totals[key].toLocaleString()}`);
  }
  if (report.files.length > 1) {
    lines.push("", "Per file:");
    for (const f of report.files) {
      lines.push(`  ${f.path}: ${f.stats ? `${totalWords(f.stats).toLocaleString()} words` : "not found"}`);
    }
  }
  lines.push("", "Counted from the source; the PDF may differ.");
  return lines.join("\n");
}

export function WordCountDialog({ onClose }: { onClose: () => void }) {
  const projectPath = useWorkspace((s) => s.project?.path);
  const main = useWorkspace((s) => s.project?.mainDocument ?? null);
  const active = useWorkspace((s) => s.active);
  const countable = (path: string | null) => !!path && (/\.tex$/i.test(path) || isMarkdown(path));
  const activeFile = countable(active) ? active : null;
  const [scope, setScope] = useState<Scope>(main ? "document" : "file");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    setLoading(true);
    buildReport(projectPath, scope, main, activeFile).then(
      (r) => {
        if (cancelled) return;
        setReport(r);
        setLoading(false);
      },
      () => !cancelled && setLoading(false),
    );
    return () => {
      cancelled = true;
    };
  }, [projectPath, scope, main, activeFile]);

  const label = scope === "document" && main ? `${main} and its included files` : (activeFile ?? "");

  const copy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(summary(report, label));
      toast("Word count copied");
    } catch {
      toast("Couldn't copy to the clipboard", "error");
    }
  };

  const scopes: [Scope, string, boolean][] = [
    ["document", "Whole document", !!main],
    ["file", "This file", !!activeFile],
  ];

  return (
    <Modal title="Word count" onClose={onClose} wide>
      <div className="mb-4 flex items-center gap-3">
        <div role="radiogroup" aria-label="What to count" className="flex rounded-lg border border-border bg-surface-2/50 p-0.5">
          {scopes.map(([value, name, enabled]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              disabled={!enabled}
              title={enabled ? undefined : value === "document" ? "This project has no main document" : "Open a .tex or .md file"}
              onClick={() => setScope(value)}
              className={`rounded-md px-3 py-1 text-sm disabled:opacity-40 ${
                scope === value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        <span className="min-w-0 truncate text-xs text-muted" title={label}>
          {label}
        </span>
      </div>

      {loading && !report ? (
        <p className="py-8 text-center text-sm text-muted">Counting…</p>
      ) : !report ? (
        <p className="py-8 text-center text-sm text-muted">Open a .tex or .md file, or set a main document, to count its words.</p>
      ) : (
        <div className={loading ? "opacity-60" : ""}>
          <div className="mb-4 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums">{report.words.toLocaleString()}</span>
            <span className="text-sm text-muted">words</span>
          </div>
          {report.totals && (
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {METRICS.map(([key, name]) => (
                <div key={key} className="rounded-lg border border-border bg-surface-2/40 px-3 py-2">
                  <dt className="text-[11px] text-muted">{name}</dt>
                  <dd className="text-base font-medium tabular-nums">{report.totals![key].toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          )}
          {report.files.length > 1 && (
            <div className="mt-4 max-h-48 overflow-auto rounded-lg border border-border">
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0 bg-surface text-xs text-muted">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">File</th>
                    <th className="px-3 py-1.5 text-right font-medium">Words</th>
                    <th className="px-3 py-1.5 text-right font-medium">Formulas</th>
                    <th className="px-3 py-1.5 text-right font-medium">Figures</th>
                    <th className="px-3 py-1.5 text-right font-medium">Tables</th>
                  </tr>
                </thead>
                <tbody>
                  {report.files.map((f) => (
                    <tr key={f.path} className="border-t border-border">
                      <td className="max-w-0 truncate px-3 py-1 font-mono text-xs" title={f.path}>
                        {f.path}
                      </td>
                      {f.stats ? (
                        <>
                          <td className="px-3 py-1 text-right tabular-nums">{totalWords(f.stats).toLocaleString()}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{(f.stats.inlineMath + f.stats.displayMath).toLocaleString()}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{f.stats.figures}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{f.stats.tables}</td>
                        </>
                      ) : (
                        <td colSpan={4} className="px-3 py-1 text-right text-xs text-amber-400">
                          Not found
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="mt-5 flex items-center gap-2">
        <p className="flex-1 text-xs text-muted">Counted from the source; the PDF may differ.</p>
        <Button onClick={() => void copy()} disabled={!report}>
          <Copy size={14} /> Copy
        </Button>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
