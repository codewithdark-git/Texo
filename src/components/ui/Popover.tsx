// A panel that opens next to its trigger: grows in from the trigger's edge,
// fades out on close, and closes on an outside click or Escape (which puts
// focus back on the trigger). The caller owns `open`, so a shortcut can
// toggle it too.
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { usePresence } from "../../lib/motion";

/** How long the close animation may run before the panel is removed anyway. */
export const POPOVER_EXIT_MS = 120;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

const SIDES = { bottom: "top-full mt-1", top: "bottom-full mb-1" };
const ALIGNS = { start: "left-0", end: "right-0", center: "left-1/2 -translate-x-1/2" };

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens it; it should call `onOpenChange(!open)` and set `aria-expanded`. */
  trigger: ReactNode;
  children: ReactNode;
  /** What the panel is, for screen readers. */
  label: string;
  role?: "dialog" | "menu" | "listbox";
  side?: keyof typeof SIDES;
  align?: keyof typeof ALIGNS;
  /** Panel width in px (or any CSS length). */
  width?: number | string;
  /** Where focus goes when it opens; the first focusable element by default. */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  panelClassName?: string;
}

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  label,
  role = "dialog",
  side = "bottom",
  align = "start",
  width,
  initialFocus,
  className = "",
  panelClassName = "",
}: PopoverProps) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const { mounted, state, onAnimationEnd } = usePresence(open, POPOVER_EXIT_MS);

  // Move focus in once the panel is there: usePresence mounts it a render after
  // `open` turns true, so this waits for `mounted` rather than `open` alone.
  const showing = open && mounted;
  useEffect(() => {
    if (!showing) return;
    const target = initialFocus?.current ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current;
    target?.focus();
    // Only on opening; a new `initialFocus` ref while open does not pull focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Heard first (capture phase) and kept from the window listeners of a
      // dialog or menu behind it, so Esc closes only the popover.
      e.preventDefault();
      e.stopImmediatePropagation();
      onOpenChange(false);
      anchor.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpenChange]);

  const style: CSSProperties = { width, maxHeight: "70vh" };
  return (
    <div ref={root} className={`relative inline-flex ${className}`}>
      <div ref={anchor} className="contents">
        {trigger}
      </div>
      {mounted && (
        <div
          ref={panel}
          role={role}
          aria-label={label}
          tabIndex={-1}
          data-side={side}
          data-align={align}
          style={style}
          onAnimationEnd={onAnimationEnd}
          className={`${state === "exit" ? "texo-menu-out pointer-events-none" : "texo-menu"} absolute z-40 overflow-auto rounded-lg border border-border bg-surface shadow-[var(--shadow-pop)] outline-none ${SIDES[side]} ${ALIGNS[align]} ${panelClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
