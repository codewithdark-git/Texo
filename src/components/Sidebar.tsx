import { FolderCog, Library } from "lucide-react";
import { useApp } from "../store";

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

export function Sidebar({ onChangeRoot }: { onChangeRoot: () => void }) {
  const settings = useApp((s) => s.settings);
  const count = useApp((s) => s.projects.length);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/60">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <Logo />
        <span className="text-[15px] font-semibold tracking-tight">Texo</span>
      </div>

      <nav className="px-3">
        <div className="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <Library size={16} className="text-accent" />
          <span className="flex-1">All projects</span>
          <span className="text-xs text-muted">{count}</span>
        </div>
      </nav>

      <div className="mt-auto border-t border-border px-4 py-3">
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
