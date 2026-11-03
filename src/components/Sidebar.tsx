import { AlertTriangle, CheckCircle2, FolderCog, Library, Loader2, RefreshCw } from "lucide-react";
import { useApp } from "../store";
import { AppMenu } from "./AppMenu";

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <rect x="64" y="64" width="896" height="896" rx="208" fill="#22265a" />
      <path d="M256 330 H768" stroke="#8b98ff" strokeWidth="104" strokeLinecap="round" />
      <path d="M512 330 V720" stroke="#fff" strokeWidth="104" strokeLinecap="round" />
      <path d="M400 640 C460 600 564 600 624 640" stroke="#8b98ff" strokeWidth="36" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** Which LaTeX engine compiles, and the built-in engine's first-run setup. */
function EngineBlock() {
  const engine = useApp((s) => s.engine);
  const setup = useApp((s) => s.engineSetup);
  const retry = useApp((s) => s.checkEngine);
  if (!engine) return <div className="mt-auto" />;

  const name = engine.bundled
    ? "Built-in engine (Tectonic)"
    : engine.compiler === "tectonic"
      ? "Tectonic"
      : engine.distribution ?? "No LaTeX found";

  return (
    <div className="mt-auto border-t border-border px-4 py-3 text-xs">
      <div className="mb-1 text-muted">LaTeX engine</div>
      <div className="flex items-center gap-1.5">
        {setup.running ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
        ) : setup.error || !engine.compiler ? (
          <AlertTriangle size={13} className="shrink-0 text-amber-400" />
        ) : (
          <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />
        )}
        <span className="truncate">{name}</span>
      </div>
      {setup.running && (
        <div className="mt-1.5 text-muted">
          <p>Setting up for first use. This downloads LaTeX packages once (about 90 MB).</p>
          <p className="mt-1 truncate font-mono text-[10px]" title={setup.line}>
            {setup.line}
          </p>
        </div>
      )}
      {setup.error && (
        <div className="mt-1.5 text-muted">
          <p>{setup.error}</p>
          <button type="button" onClick={() => void retry()} className="mt-1 inline-flex items-center gap-1 text-accent hover:underline">
            <RefreshCw size={12} /> Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function Sidebar({ onChangeRoot }: { onChangeRoot: () => void }) {
  const settings = useApp((s) => s.settings);
  const count = useApp((s) => s.projects.length);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/60">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <Logo />
        <span className="flex-1 text-[15px] font-semibold tracking-tight">Texo</span>
        <AppMenu align="left" />
      </div>

      <nav className="px-3">
        <div className="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <Library size={16} className="text-accent" />
          <span className="flex-1">All projects</span>
          <span className="text-xs text-muted">{count}</span>
        </div>
      </nav>

      <EngineBlock />

      <div className="border-t border-border px-4 py-3">
        <div className="mb-1 text-xs text-muted">Projects folder</div>
        <div className="truncate font-mono text-xs" title={settings?.projectsRoot}>
          {settings?.projectsRoot ?? "…"}
        </div>
        <button
          type="button"
          onClick={onChangeRoot}
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
        >
          <FolderCog size={13} /> Change
        </button>
      </div>
    </aside>
  );
}
