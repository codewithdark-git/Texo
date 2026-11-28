// How much the interface moves: follow the system's reduced-motion setting, or
// force reduced or full motion. The choice is stored per machine and applied
// to the page as `data-motion` on <html>; styles.css shortens every duration
// token when motion is reduced. Safe to import where there is no DOM.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DependencyList, type RefObject } from "react";

export type MotionPref = "system" | "reduce" | "full";
export type Motion = "reduce" | "full";

const KEY = "texo.motion";
const listeners = new Set<() => void>();

const media = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

export function getMotionPref(): MotionPref {
  try {
    const value = localStorage.getItem(KEY);
    return value === "reduce" || value === "full" ? value : "system";
  } catch {
    return "system";
  }
}

/** The motion level a preference comes to, given whether the system asks for less motion. */
export function resolveMotion(pref: MotionPref, systemReduced: boolean): Motion {
  if (pref === "system") return systemReduced ? "reduce" : "full";
  return pref;
}

/** Whether motion is reduced right now. */
export function prefersReducedMotion(): boolean {
  return resolveMotion(getMotionPref(), media()?.matches ?? false) === "reduce";
}

/** Puts the preference on <html>. "system" leaves it to the media query in styles.css. */
export function applyMotion(pref: MotionPref = getMotionPref()) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.motion;
  else root.dataset.motion = pref;
  listeners.forEach((fn) => fn());
}

export function setMotionPref(pref: MotionPref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Applies for this session only.
  }
  applyMotion(pref);
}

/** Calls `fn` when the preference or the system setting changes. */
export function onMotionChange(fn: () => void): () => void {
  listeners.add(fn);
  const mq = media();
  mq?.addEventListener("change", fn);
  return () => {
    listeners.delete(fn);
    mq?.removeEventListener("change", fn);
  };
}

/** True while motion is reduced, by the system or by the app setting. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(onMotionChange, prefersReducedMotion, () => false);
}

/**
 * Animates the children of `ref` that carry `data-flip` from where they were
 * to where they are now when `deps` change (FLIP), so reordered rows glide
 * instead of jumping. Does nothing when motion is reduced.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, deps: DependencyList, duration = 200) {
  const last = useRef(new Map<string, DOMRect>());
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = new Map<string, DOMRect>();
    for (const child of Array.from(el.querySelectorAll<HTMLElement>(":scope > [data-flip]"))) {
      const key = child.dataset.flip!;
      const now = child.getBoundingClientRect();
      next.set(key, now);
      const before = last.current.get(key);
      if (reduced || !before || typeof child.animate !== "function") continue;
      const dx = before.left - now.left;
      const dy = before.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration,
        easing: "cubic-bezier(.2,0,0,1)",
      });
    }
    last.current = next;
  }, deps);
}

export type PresenceState = "enter" | "exit";

export interface Presence {
  /** Whether to render the element at all. */
  mounted: boolean;
  /** Which animation class to give it: the enter one, or the exit one while it leaves. */
  state: PresenceState;
  /** Put on the animated element so it unmounts as soon as its own exit animation ends. */
  onAnimationEnd: (e?: { target: EventTarget | null; currentTarget: EventTarget | null }) => void;
}

/** The presence after `open` changes: what to render, and whether removal must wait for an exit. */
export function presenceAfter(open: boolean, mounted: boolean): { mounted: boolean; state: PresenceState; waitForExit: boolean } {
  if (open) return { mounted: true, state: "enter", waitForExit: false };
  return { mounted, state: "exit", waitForExit: mounted };
}

/**
 * Keeps an element mounted while it plays its exit animation. Removes it
 * after `animationend`, or after `exitMs` in case no animation runs (reduced
 * motion, a hidden window).
 */
export function usePresence(open: boolean, exitMs: number): Presence {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<PresenceState>("enter");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reduced = useReducedMotion();

  useEffect(() => {
    clearTimeout(timer.current);
    const next = presenceAfter(open, mounted);
    setState(next.state);
    if (next.mounted) setMounted(true);
    if (next.waitForExit) timer.current = setTimeout(() => setMounted(false), reduced ? Math.min(exitMs, 120) : exitMs);
    return () => clearTimeout(timer.current);
    // `mounted` is read, not watched: only a change of `open` starts an exit.
  }, [open, exitMs, reduced]);

  const onAnimationEnd = useCallback<Presence["onAnimationEnd"]>((e) => {
    // A child's animation ending bubbles up too; only the element's own exit counts.
    if (open || (e && e.target !== e.currentTarget)) return;
    clearTimeout(timer.current);
    setMounted(false);
  }, [open]);

  return { mounted, state, onAnimationEnd };
}
