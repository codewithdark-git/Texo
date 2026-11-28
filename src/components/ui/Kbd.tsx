// A keyboard shortcut, drawn as a small key cap: <Kbd>Ctrl+P</Kbd>.
import type { ReactNode } from "react";

export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`inline-flex items-center rounded border border-border bg-surface-2 px-1 py-px font-sans text-[10px] leading-none whitespace-nowrap text-muted ${className}`}
    >
      {children}
    </kbd>
  );
}
