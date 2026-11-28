// App-wide UI state: short confirmation toasts and the global dialogs.
import { create } from "zustand";
import type { Template } from "./lib/api";

export type ToastKind = "success" | "info" | "error";

/** A button on a toast, such as "Undo". Clicking it runs `run` and closes the toast. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
  /** Set while the toast plays its exit animation, just before it is removed. */
  leaving?: boolean;
}

export type GlobalDialog =
  | "shortcuts"
  | "about"
  | "quickOpen"
  | "settings"
  | "wordCount"
  | "newProject"
  | "support"
  | null;

interface UiStore {
  toasts: Toast[];
  dialog: GlobalDialog;
  /** The template the "newProject" dialog starts on; unset means the last one used. */
  newTemplate?: Template;
  /** The section the Settings dialog opens on; unset means the first one. */
  settingsSection?: string;
  toast: (text: string, kind?: ToastKind, action?: ToastAction) => void;
  /** Starts a toast's exit; it is removed once that has played. */
  dismissToast: (id: number) => void;
  /** Removes a toast at once (the Toaster calls this when the exit animation ends). */
  removeToast: (id: number) => void;
  /**
   * Stops a toast's timer while the pointer rests on it or focus is in it, and
   * restarts it once neither holds it. Hover and focus are counted apart, so
   * the pointer leaving does not restart a toast that still has focus.
   */
  pauseToast: (id: number, reason?: ToastHold) => void;
  resumeToast: (id: number, reason?: ToastHold) => void;
  openDialog: (dialog: GlobalDialog) => void;
  /** Opens the template gallery, optionally with `template` selected. */
  openNewProject: (template?: Template) => void;
  /** Opens Settings on one section (e.g. "ai"). */
  openSettings: (section?: string) => void;
}

let nextId = 1;
const TOAST_MS = 3500;
/** How long a toast's exit may take before it is removed anyway (the Toaster usually removes it sooner). */
export const TOAST_EXIT_MS = 220;

/** What is keeping a toast on screen. */
export type ToastHold = "hover" | "focus";

/** Each live toast's timer: when it was last started, how much time it has left, and what holds it. */
const timers = new Map<number, { handle?: ReturnType<typeof setTimeout>; started: number; left: number; holds: Set<ToastHold> }>();

export const useUi = create<UiStore>((set, get) => {
  const startTimer = (id: number) => {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeout(timer.handle);
    timer.started = Date.now();
    timer.handle = setTimeout(() => get().dismissToast(id), timer.left);
  };

  return {
    toasts: [],
    dialog: null,
    toast: (text, kind = "success", action) => {
      const id = nextId++;
      // Keep at most three on screen; the newest goes at the bottom.
      set((s) => {
        const keep = s.toasts.filter((t) => !t.leaving).slice(-2);
        for (const t of s.toasts) if (!keep.includes(t)) timers.delete(t.id);
        return { toasts: [...keep, { id, kind, text, ...(action ? { action } : {}) }] };
      });
      // A toast with a button stays a little longer, so there is time to use it.
      const ms = kind === "error" ? TOAST_MS * 2 : action ? TOAST_MS * 2 : TOAST_MS;
      timers.set(id, { started: Date.now(), left: ms, holds: new Set() });
      startTimer(id);
    },
    dismissToast: (id) => {
      const timer = timers.get(id);
      clearTimeout(timer?.handle);
      timers.delete(id);
      if (!get().toasts.some((t) => t.id === id && !t.leaving)) return;
      set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
      setTimeout(() => get().removeToast(id), TOAST_EXIT_MS);
    },
    removeToast: (id) => {
      timers.delete(id);
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
    pauseToast: (id, reason = "hover") => {
      const timer = timers.get(id);
      if (!timer) return;
      timer.holds.add(reason);
      if (timer.handle === undefined) return;
      clearTimeout(timer.handle);
      timer.handle = undefined;
      timer.left = Math.max(0, timer.left - (Date.now() - timer.started));
    },
    resumeToast: (id, reason = "hover") => {
      const timer = timers.get(id);
      if (!timer) return;
      timer.holds.delete(reason);
      // Give at least a moment after the pointer or focus leaves.
      if (timer.holds.size === 0 && timer.handle === undefined) {
        timer.left = Math.max(timer.left, 1200);
        startTimer(id);
      }
    },
    openDialog: (dialog) => set({ dialog, settingsSection: undefined }),
    openNewProject: (newTemplate) => set({ dialog: "newProject", newTemplate }),
    openSettings: (settingsSection) => set({ dialog: "settings", settingsSection }),
  };
});

/** Shorthand for components and stores that just want to say something. */
export const toast = (text: string, kind?: ToastKind, action?: ToastAction) => useUi.getState().toast(text, kind, action);

/** What the platform calls its file browser, for menu labels. */
export const fileManagerName = navigator.userAgent.includes("Windows") ? "File Explorer" : "file manager";
export const trashName = navigator.userAgent.includes("Windows") ? "Recycle Bin" : "Trash";
