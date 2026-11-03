// App-wide UI state: short confirmation toasts and the global dialogs.
import { create } from "zustand";

export type ToastKind = "success" | "info" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

export type GlobalDialog = "shortcuts" | "about" | "quickOpen" | null;

interface UiStore {
  toasts: Toast[];
  dialog: GlobalDialog;
  toast: (text: string, kind?: ToastKind) => void;
  dismissToast: (id: number) => void;
  openDialog: (dialog: GlobalDialog) => void;
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
  openDialog: (dialog) => set({ dialog }),
}));

/** Shorthand for components and stores that just want to say something. */
export const toast = (text: string, kind?: ToastKind) => useUi.getState().toast(text, kind);

/** What the platform calls its file browser, for menu labels. */
export const fileManagerName = navigator.userAgent.includes("Windows") ? "File Explorer" : "file manager";
