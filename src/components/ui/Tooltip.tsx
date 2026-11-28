// A small label that appears when the pointer rests on, or focus reaches, the
// element it wraps. It waits 400ms so it doesn't flicker past, and Escape
// hides it.
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Kbd } from "./Kbd";

export const TOOLTIP_DELAY_MS = 400;

const SIDES = {
  bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
  top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  left: "right-full top-1/2 mr-1.5 -translate-y-1/2",
  right: "left-full top-1/2 ml-1.5 -translate-y-1/2",
};

interface TooltipProps {
  content: ReactNode;
  /** A key combination shown after the text, such as "Ctrl+P". */
  shortcut?: string;
  side?: keyof typeof SIDES;
  /** When set, the child shows no tooltip (for example while a menu it opens is showing). */
  disabled?: boolean;
  children: ReactElement<{ "aria-describedby"?: string }>;
}

export function Tooltip({ content, shortcut, side = "bottom", disabled = false, children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), TOOLTIP_DELAY_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const visible = open && !disabled;
  const child = visible && isValidElement(children) ? cloneElement(children, { "aria-describedby": id }) : children;

  return (
    <span className="relative inline-flex" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide} onPointerDown={hide}>
      {child}
      {visible && (
        <span
          id={id}
          role="tooltip"
          className={`texo-fade-in pointer-events-none absolute z-50 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs whitespace-nowrap text-text shadow-[var(--shadow-pop)] ${SIDES[side]}`}
        >
          {content}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </span>
      )}
    </span>
  );
}
