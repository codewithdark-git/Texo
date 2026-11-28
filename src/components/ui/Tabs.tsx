// Tabs: a row of tabs with a pill that slides under the active one. Arrow
// keys, Home and End move between tabs (roving tabindex, so Tab leaves the
// row), and panels are linked to their tabs for screen readers.
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Tooltip } from "./Tooltip";

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** Shown after the label, such as an issue count. */
  badge?: ReactNode;
  /** Shown in the tooltip when only the icon is visible. */
  shortcut?: string;
}

/**
 * The tab a key moves to from `index` among `count` tabs, or null for a key
 * the row doesn't handle. The arrows wrap around at either end.
 */
export function nextIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * Where the sliding indicator sits: under the child of `container` marked
 * `data-selected`. Measured after layout and again when the row resizes.
 */
export function useIndicator(container: RefObject<HTMLElement | null>, deps: unknown[]): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => {
      const active = el.querySelector<HTMLElement>("[data-selected]");
      if (!active) return setStyle({ opacity: 0 });
      // Measured against the row, as the tab may sit inside a tooltip wrapper.
      const left = active.getBoundingClientRect().left - el.getBoundingClientRect().left - el.clientLeft + el.scrollLeft;
      setStyle({ width: active.offsetWidth, transform: `translateX(${left}px)` });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // The caller lists what moves the indicator.
  }, deps);
  return style;
}

interface TabsProps<T extends string> {
  /** What the row is for, for screen readers ("Sidebar"). */
  label: string;
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Ties tab and panel ids together; use the same prefix on each `TabPanel`. */
  idPrefix: string;
  /** Show only icons, with the label in a tooltip (for narrow places). */
  iconOnly?: boolean;
  className?: string;
}

export function Tabs<T extends string>({ label, items, value, onChange, idPrefix, iconOnly = false, className = "" }: TabsProps<T>) {
  const row = useRef<HTMLDivElement>(null);
  const indicator = useIndicator(row, [value, iconOnly, items.length]);
  const selected = Math.max(
    0,
    items.findIndex((t) => t.id === value),
  );

  const onKeyDown = (e: KeyboardEvent) => {
    const to = nextIndex(e.key, selected, items.length);
    if (to === null) return;
    e.preventDefault();
    onChange(items[to].id);
    row.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };

  return (
    <div ref={row} role="tablist" aria-label={label} onKeyDown={onKeyDown} className={`relative flex items-stretch gap-0.5 ${className}`}>
      {items.map((t, i) => {
        const active = i === selected;
        const tab = (
          <button
            key={t.id}
            id={tabId(idPrefix, t.id)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelId(idPrefix, t.id)}
            aria-label={iconOnly ? t.label : undefined}
            tabIndex={active ? 0 : -1}
            data-selected={active ? "" : undefined}
            onClick={() => onChange(t.id)}
            className={`relative z-10 flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
              active ? "text-text" : "text-muted hover:text-text"
            }`}
          >
            {t.icon && <span className="shrink-0">{t.icon}</span>}
            {!iconOnly && <span className="truncate">{t.label}</span>}
            {!iconOnly && t.badge}
          </button>
        );
        return iconOnly ? (
          <Tooltip key={t.id} content={t.label} shortcut={t.shortcut}>
            {tab}
          </Tooltip>
        ) : (
          tab
        );
      })}
      <span aria-hidden="true" style={indicator} className="texo-indicator pointer-events-none absolute inset-y-0 left-0 rounded-md bg-surface-2" />
    </div>
  );
}

/** One tab's panel. It stays mounted while hidden, so its scroll and inputs survive tab switches. */
export function TabPanel({
  idPrefix,
  id,
  active,
  children,
  className = "",
}: {
  idPrefix: string;
  id: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      id={panelId(idPrefix, id)}
      role="tabpanel"
      aria-labelledby={tabId(idPrefix, id)}
      hidden={!active}
      className={`${active ? "texo-fade-in" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
