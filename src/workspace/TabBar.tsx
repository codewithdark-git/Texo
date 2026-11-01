import { X } from "lucide-react";
import { baseName } from "./paths";
import { useWorkspace } from "./store";

export function TabBar() {
  const { tabs, active, status, openFile, closeTab } = useWorkspace();
  if (tabs.length === 0) return null;

  // Show the folder too when two open files share a name.
  const names = tabs.map(baseName);
  const label = (path: string, i: number) =>
    names.indexOf(names[i]) !== names.lastIndexOf(names[i]) ? path : names[i];

  return (
    <div role="tablist" className="flex h-9 shrink-0 overflow-x-auto border-b border-border bg-surface/60">
      {tabs.map((path, i) => {
        const isActive = path === active;
        const dirty = status[path]?.dirty;
        return (
          <div
            key={path}
            role="tab"
            aria-selected={isActive}
            title={path}
            onClick={() => void openFile(path)}
            onAuxClick={(e) => e.button === 1 && void closeTab(path)}
            className={`group flex max-w-56 shrink-0 cursor-default items-center gap-2 border-r border-border pr-1.5 pl-3 text-[13px] ${
              isActive ? "bg-bg text-text shadow-[inset_0_2px_0_var(--accent)]" : "text-muted hover:text-text"
            }`}
          >
            <span className="truncate">{label(path, i)}</span>
            <button
              type="button"
              aria-label={`Close ${baseName(path)}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(path);
              }}
              className="relative flex size-5 items-center justify-center rounded hover:bg-surface-2"
            >
              {dirty ? (
                <>
                  <span className="size-2 rounded-full bg-text/70 group-hover:hidden" />
                  <X size={13} className="hidden group-hover:block" />
                </>
              ) : (
                <X size={13} className={isActive ? "" : "invisible group-hover:visible"} />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
