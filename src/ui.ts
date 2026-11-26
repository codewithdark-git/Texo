// App-wide UI state: short confirmation toasts and the global dialogs.
import { create } from "zustand";
import type { Template } from "./lib/api";

export type ToastKind = "success" | "info" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
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
  toast: (text: string, kind?: ToastKind) => void;
  dismissToast: (id: number) => void;
  openDialog: (dialog: GlobalDialog) => void;
  /** Opens the template gallery, optionally with `template` selected. */
  openNewProject: (template?: Template) => void;
  /** Opens Settings on one section (e.g. "ai"). */
  openSettings: (section?: string) => void;
}

let nextId = 1;
const TOAST_MS = 3500;

export const useUi = create<UiStore>((set, get) => ({
  toasts: [],
  dialog: null,
  toast: (text, kind = "success") => {
    const id = nextId++;
    // Keep at most three on screen; the newest goes at the bottom.
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? TOAST_MS * 2 : TOAST_MS);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openDialog: (dialog) => set({ dialog, settingsSection: undefined }),
  openNewProject: (newTemplate) => set({ dialog: "newProject", newTemplate }),
  openSettings: (settingsSection) => set({ dialog: "settings", settingsSection }),
}));

/** Shorthand for components and stores that just want to say something. */
export const toast = (text: string, kind?: ToastKind) => useUi.getState().toast(text, kind);

/** What the platform calls its file browser, for menu labels. */
export const fileManagerName = navigator.userAgent.includes("Windows") ? "File Explorer" : "file manager";
export const trashName = navigator.userAgent.includes("Windows") ? "Recycle Bin" : "Trash";
