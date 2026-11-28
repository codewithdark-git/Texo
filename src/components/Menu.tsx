import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: (MenuItem | "divider")[];
  align?: "left" | "right";
}

/** Where a dropdown sits: fixed to the window, under (or above) its trigger. */
export function dropdownPlace(
  r: { top: number; bottom: number; left: number; right: number },
  view: { width: number; height: number },
  align: "left" | "right",
  menuHeight: number,
): { style: CSSProperties; side: "top" | "bottom" } {
  const gap = 4;
  const below = view.height - r.bottom - gap;
  const up = below < menuHeight + 8 && r.top - gap > below;
  const style: CSSProperties = up ? { bottom: view.height - r.top + gap } : { top: r.bottom + gap };
  // Never wider than the window, even in a narrow panel or window.
  const maxWidth = Math.max(0, view.width - 8);
  style.maxWidth = maxWidth;
  style.minWidth = Math.min(208, maxWidth);
  if (align === "right") style.right = Math.max(4, view.width - r.right);
  else style.left = Math.max(4, r.left);
  return { style, side: up ? "top" : "bottom" };
}

/**
 * Which item a key moves to in a menu of `count` items, with `at` the item
 * that has focus now (-1 for none). Arrows wrap around; null means the key
 * does not move focus.
 */
export function menuKeyTarget(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return at < 0 ? 0 : (at + 1) % count;
    case "ArrowUp":
      return at < 0 ? count - 1 : (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Should a scroll of `target` close a menu whose trigger is `trigger`? Only when it moves the trigger. */
export function scrollMovesTrigger(target: EventTarget | null, trigger: Node | null): boolean {
  if (!trigger || !target || typeof (target as Node).contains !== "function") return false;
  return (target as Node).contains(trigger);
}

const ITEMS = '[role="menuitem"]:not([disabled])';
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A click-to-open dropdown that closes on outside click, Escape, Tab, resizing
 * or a scroll that moves its trigger. The menu renders in a portal, fixed to
 * the window, so no card, panel or scroll area can cover or clip it. Opening
 * it puts focus on the first item; arrows, Home and End move between items,
 * and Escape puts focus back on the trigger.
 */
export function Menu({ trigger, items, align = "right" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ style: CSSProperties; side: "top" | "bottom" } | null>(null);

  useLayoutEffect(() => {
    if (!open || !root.current) return setPlace(null);
    const r = root.current.getBoundingClientRect();
    const h = menu.current?.offsetHeight ?? 0;
    setPlace(dropdownPlace(r, { width: window.innerWidth, height: window.innerHeight }, align, h));
  }, [open, align]);

  // Move focus in once the menu is placed (it is hidden, so not focusable, until then).
  const placed = open && !!place;
  useEffect(() => {
    if (placed) menu.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [placed]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) root.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      // Back on the trigger before the browser moves focus, so Tab goes on from there.
      close(true);
      return;
    }
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
    const next = menuKeyTarget(e.key, rows.indexOf(document.activeElement as HTMLElement), rows.length);
    if (next === null) {
      // Plain keys belong to the menu: through the portal they would otherwise
      // reach panel shortcuts behind it (such as "/" in Papers). Shortcuts with
      // a modifier still go through.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    rows[next]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => root.current?.contains(t as Node) || menu.current?.contains(t as Node);
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Heard first (capture phase) and kept from a drawer or dialog behind it,
      // so Esc closes only the menu, as with Popover.
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
      root.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    };
    // The menu is fixed to the window, so it would drift away from a trigger
    // that scrolls. Other scrolls (a log or a live list following along) leave it be.
    const onScroll = (e: Event) => {
      if (!inside(e.target) && scrollMovesTrigger(e.target, root.current)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const list = open && (
    <div
      ref={menu}
      role="menu"
      data-side={place?.side ?? "bottom"}
      data-align={align === "right" ? "end" : "start"}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onListKey}
      style={{ ...(place?.style ?? { top: 0, left: 0 }), visibility: place ? undefined : "hidden" }}
      className="texo-menu fixed z-50 rounded-lg border border-border bg-surface p-1 shadow-xl"
    >
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={`d${i}`} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            type="button"
            tabIndex={-1}
            onClick={() => {
              close(true);
              item.onSelect();
            }}
            className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-surface-2 focus-visible:bg-surface-2 ${
              item.danger ? "text-danger" : "text-text"
            }`}
          >
            <span className="mt-0.5 shrink-0 text-muted">{item.icon}</span>
            <span>
              <span className="block">{item.label}</span>
              {item.hint && <span className="block text-xs text-muted">{item.hint}</span>}
            </span>
          </button>
        ),
      )}
    </div>
  );

  return (
    <div ref={root} className="relative" onClick={(e) => e.stopPropagation()}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {list && (typeof document === "undefined" ? list : createPortal(list, document.body))}
    </div>
  );
}

/** A menu opened at the mouse position, for right-click actions. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: (MenuItem | "divider")[];
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    // Keep the menu on screen near the right and bottom edges.
    const el = root.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({
        x: Math.min(x, window.innerWidth - r.width - 8),
        y: Math.min(y, window.innerHeight - r.height - 8),
      });
    }
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [x, y, onClose]);

  return (
    <div
      ref={root}
      role="menu"
      data-side="bottom"
      data-align="start"
      style={{ left: pos.x, top: pos.y }}
      className="texo-menu fixed z-50 min-w-52 rounded-lg border border-border bg-surface p-1 shadow-xl"
    >
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={`d${i}`} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            type="button"
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2 ${
              item.danger ? "text-danger" : "text-text"
            }`}
          >
            <span className="shrink-0 text-muted">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="text-xs text-muted">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
