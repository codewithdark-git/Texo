// Project settings (sidebar footer): this project's main document, engine,
// history, bibliography files, and links to its AI memory and agent profiles.
// Sections are listed on the left, as in Settings, and every change applies
// at once.
//
// The sections here only draw what they are given (`ProjectSettingsModel`),
// so they render in tests. The part that reads the stores and talks to the
// backend is `ProjectSettingsConnected.tsx`, loaded when the dialog first
// opens: the workspace stores pull in the editor, which the sidebar footer
// (and its tests) must not load just to show a button.
import { lazy, Suspense, useState, type ReactNode } from "react";
import { BookMarked, ExternalLink, FileText, GitBranch, Hammer, History, Loader2, RefreshCw, Settings2, Sparkles } from "lucide-react";
import type { Engine } from "../lib/api";
import type { HistoryStatus } from "../lib/historyApi";
import type { LibraryStatus } from "../lib/libraryApi";
import { Button, Modal } from "../components/Dialog";
import { Choice, Heading, Row, Toggle } from "../components/settingsControls";
import { StatusDot } from "../components/ui/StatusDot";
import {
  ENGINES,
  historyLine,
  libraryState,
  mainDocOptions,
  PROJECT_SECTIONS,
  type AiSettingsPage,
  type ProjectSection,
} from "./projectSettingsLogic";

/** Everything the sections show, and what they can change. */
export interface ProjectSettingsModel {
  name: string;
  /** The project folder on disk. */
  path: string;
  /** Opened from a folder outside the projects folder. */
  external: boolean;

  mainDocument: string | null;
  /** `.tex` files with `\documentclass`; null while they are being read. */
  mainCandidates: string[] | null;
  setMainDocument: (path: string) => void;

  engine: Engine;
  setEngine: (engine: Engine) => void;

  /** null while loading. */
  history: HistoryStatus | null;
  /** Why the history status couldn't be read; shown instead of "Checking…". */
  historyError: string | null;
  setHistoryEnabled: (on: boolean) => void;
  keepHistoryOutOfGit: () => void;

  /** The `.bib` files the library reads; null while loading. */
  bibFiles: string[] | null;
  /** null while loading, "error" when the status itself failed. */
  library: LibraryStatus | null | "error";
  rescanning: boolean;
  /** What the last re-scan found, in plain words. */
  lastScan: string | null;
  rescan: () => void;

  aiEnabled: boolean;
  /** e.g. "1.2 KB of 8 KB", or null while loading or unknown. */
  memorySize: string | null;
  /** Agent profiles saved for this project only; null while loading or unknown. */
  projectProfiles: number | null;
  /** Closes this dialog and opens Settings on a section (and AI page). */
  openSettings: (section: string, aiPage?: AiSettingsPage) => void;
}

const ICONS: Record<ProjectSection, typeof Settings2> = {
  general: Settings2,
  compile: Hammer,
  history: History,
  references: BookMarked,
  ai: Sparkles,
};

const SELECT = "h-8 max-w-56 truncate rounded-lg border border-border bg-bg px-2 text-sm outline-none focus:border-accent";
const PANEL = "rounded-lg border border-border bg-bg px-3 py-2";

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted">{children}</span>;
}

function Waiting({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <Loader2 size={12} className="animate-spin" aria-hidden="true" /> {label}
    </span>
  );
}

/** A link-style button to a part of the global Settings. */
function SettingsLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button onClick={onClick}>
      {label} <ExternalLink size={12} className="text-muted" aria-hidden="true" />
    </Button>
  );
}

function GeneralSection({ m }: { m: ProjectSettingsModel }) {
  const options = m.mainCandidates ? mainDocOptions(m.mainCandidates, m.mainDocument) : null;
  return (
    <>
      <Heading>General</Heading>
      <Row
        label="Name"
        help={m.external ? "Rename it from the project list. The folder keeps its name." : "Rename it from the project list."}
      >
        <span className="block max-w-56 truncate text-sm font-medium" title={m.name}>
          {m.name}
        </span>
      </Row>
      <div className={`${PANEL} truncate font-mono text-xs text-muted`} title={m.path}>
        {m.path}
      </div>
      <Row label="Main document" help="The file Texo compiles. Files that start a document with \documentclass are listed.">
        {options === null ? (
          <Waiting label="Looking…" />
        ) : options.length === 0 ? (
          <Muted>None found</Muted>
        ) : (
          <select
            aria-label="Main document"
            className={SELECT}
            value={m.mainDocument ?? ""}
            onChange={(e) => e.target.value && m.setMainDocument(e.target.value)}
          >
            {!m.mainDocument && <option value="">Choose a file</option>}
            {options.map((p) => (
              <option key={p} value={p}>
                {p}
                {m.mainCandidates && !m.mainCandidates.includes(p) ? " (no \\documentclass)" : ""}
              </option>
            ))}
          </select>
        )}
      </Row>
    </>
  );
}

function CompileSection({ m }: { m: ProjectSettingsModel }) {
  return (
    <>
      <Heading>Compile</Heading>
      <Row label="Engine" help="Used for this project only. XeLaTeX and LuaLaTeX handle system fonts and Unicode best.">
        <Choice label="Engine" value={m.engine} options={ENGINES} onChange={m.setEngine} />
      </Row>
      <Row label="Compiler and auto compile" help="These apply to every project.">
        <SettingsLink label="Compile settings" onClick={() => m.openSettings("compile")} />
      </Row>
    </>
  );
}

function HistorySection({ m }: { m: ProjectSettingsModel }) {
  const line = historyLine(m.history, m.historyError);
  const s = m.history;
  return (
    <>
      <Heading>History</Heading>
      <Row label="Keep a history of this project" help="Texo saves versions as you work, so you can compare and restore them.">
        <Toggle label="Keep a history of this project" checked={s?.enabled ?? false} onChange={m.setHistoryEnabled} />
      </Row>
      <p aria-live="polite" className={`flex items-center gap-2 text-xs ${line.tone === "warning" ? "text-warning" : "text-muted"}`}>
        {(s || line.tone === "warning") && <StatusDot tone={line.tone === "warning" ? "warning" : s?.enabled ? "success" : "muted"} />}
        {line.text}
      </p>
      {s?.offerGitExclude && (
        <div className={`${PANEL} texo-fade-in mt-4 flex items-start gap-3`}>
          <GitBranch size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm">Keep history out of git</div>
            <div className="mt-0.5 text-xs text-muted">
              This project is a git repository. Texo can add <span className="font-mono">.texo/</span> to{" "}
              <span className="font-mono">.git/info/exclude</span> so git ignores its files.
            </div>
          </div>
          <Button className="shrink-0" onClick={m.keepHistoryOutOfGit}>
            Keep out of git
          </Button>
        </div>
      )}
    </>
  );
}

function ReferencesSection({ m }: { m: ProjectSettingsModel }) {
  const lib = libraryState(m.library);
  return (
    <>
      <Heading>References</Heading>
      <p className="mb-2 text-xs text-muted">The bibliography files this project uses. Their entries are linked to your paper library.</p>
      {m.bibFiles === null ? (
        <div className="py-2">
          <Waiting label="Looking for .bib files…" />
        </div>
      ) : m.bibFiles.length === 0 ? (
        <p className={`${PANEL} text-xs text-muted`}>No .bib files in this project yet.</p>
      ) : (
        <ul aria-label="Bibliography files" className={`${PANEL} max-h-40 overflow-auto py-1.5`}>
          {m.bibFiles.map((f) => (
            <li key={f} className="flex items-center gap-2 py-0.5 font-mono text-xs" title={f}>
              <FileText size={13} className="shrink-0 text-muted" aria-hidden="true" />
              <span className="truncate">{f}</span>
            </li>
          ))}
        </ul>
      )}
      <Row label="Re-scan bibliography" help="Reads the .bib files again and updates which papers this project cites.">
        <Button onClick={m.rescan} disabled={!lib.ready || m.rescanning}>
          <RefreshCw size={13} className={m.rescanning ? "animate-spin" : ""} aria-hidden="true" /> {m.rescanning ? "Scanning…" : "Re-scan"}
        </Button>
      </Row>
      <p aria-live="polite" className="text-xs text-muted">
        {m.lastScan ?? ""}
      </p>
      {lib.note && (
        <p role="status" className={`${PANEL} mt-2 flex items-start gap-2 text-xs text-muted`}>
          <StatusDot tone="warning" className="mt-1" />
          {lib.note}
        </p>
      )}
    </>
  );
}

function AiSection({ m }: { m: ProjectSettingsModel }) {
  if (!m.aiEnabled) {
    return (
      <>
        <Heading>AI</Heading>
        <p className="mb-3 text-sm text-muted">The AI helper is off. Turn it on to give the agents notes and profiles for this project.</p>
        <SettingsLink label="AI settings" onClick={() => m.openSettings("ai", "provider")} />
      </>
    );
  }
  const profiles = m.projectProfiles;
  return (
    <>
      <Heading>AI</Heading>
      <Row
        label="Project memory"
        help={`Notes the agents read before they start, kept in this project.${m.memorySize ? ` ${m.memorySize} used.` : ""}`}
      >
        <SettingsLink label="Memory" onClick={() => m.openSettings("ai", "memory")} />
      </Row>
      <Row
        label="Agent profiles"
        help={
          profiles === null
            ? "Profiles can apply to all projects or to this one."
            : profiles === 0
              ? "No profiles just for this project yet."
              : `${profiles} ${profiles === 1 ? "profile" : "profiles"} just for this project.`
        }
      >
        <SettingsLink label="Agents" onClick={() => m.openSettings("ai", "agents")} />
      </Row>
    </>
  );
}

/** One section's content. */
export function ProjectSettingsSection({ section, model }: { section: ProjectSection; model: ProjectSettingsModel }) {
  switch (section) {
    case "general":
      return <GeneralSection m={model} />;
    case "compile":
      return <CompileSection m={model} />;
    case "history":
      return <HistorySection m={model} />;
    case "references":
      return <ReferencesSection m={model} />;
    case "ai":
      return <AiSection m={model} />;
  }
}

/** The dialog itself, drawn from a model. */
export function ProjectSettingsView({
  model,
  onClose,
  initialSection = "general",
}: {
  model: ProjectSettingsModel;
  onClose: () => void;
  initialSection?: ProjectSection;
}) {
  const [section, setSection] = useState<ProjectSection>(initialSection);
  return (
    <Modal title="Project settings" onClose={onClose} wide>
      <div className="flex h-[min(60vh,440px)] gap-4">
        <nav aria-label="Project settings sections" className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-border pr-3">
          {PROJECT_SECTIONS.map(([value, label]) => {
            const Icon = ICONS[value];
            return (
              <button
                key={value}
                type="button"
                aria-current={section === value ? "page" : undefined}
                onClick={() => setSection(value)}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-(--dur-2) ${
                  section === value ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/60 hover:text-text"
                }`}
              >
                <Icon size={15} aria-hidden="true" /> {label}
              </button>
            );
          })}
        </nav>
        <div key={section} className="texo-fade-in min-w-0 flex-1 overflow-auto pr-1">
          <ProjectSettingsSection section={section} model={model} />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-muted" title={model.name}>
          {model.name}
        </span>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

const Connected = lazy(() => import("./ProjectSettingsConnected"));

export function ProjectSettingsDialog({ project, open, onClose }: { project: string; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <Connected project={project} onClose={onClose} />
    </Suspense>
  );
}
