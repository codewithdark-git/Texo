// How the rest of the app puts focus (and sometimes words) in the AI Chat bar.
// A request waits here until a bar takes it, so it works even when the bar is
// not on screen yet: the Chat tab opening, the layout switching from "PDF
// only", or the privacy note still waiting to be read.

import { create } from "zustand";

interface ComposerRequest {
  /** Bumped by every request, so a mounted bar notices it. */
  seq: number;
  /** Focus wanted in the bar (or its setup line). */
  focus: boolean;
  /** Words to put in the bar, kept until a ready bar takes them. */
  text: string | null;
  /** Focus wanted on the privacy note's "OK, start chatting". */
  notice: boolean;
}

export const useComposerRequest = create<ComposerRequest>(() => ({ seq: 0, focus: false, text: null, notice: false }));

/** Puts focus in the AI Chat bar, now or once it shows. With `text`, the bar's words become `text`. */
export function focusComposer(text?: string): void {
  useComposerRequest.setState((s) => ({ seq: s.seq + 1, focus: true, text: text ?? s.text }));
}

/** Keeps `text` for the bar without moving focus (the bar takes it, and focus, once it is ready). */
export function queueComposerText(text: string): void {
  useComposerRequest.setState((s) => ({ seq: s.seq + 1, text }));
}

/** Asks the privacy note in the Chat tab to take focus. */
export function focusNotice(): void {
  useComposerRequest.setState((s) => ({ seq: s.seq + 1, notice: true }));
}

/**
 * Takes what is waiting for a bar. A ready bar takes focus and words; the
 * setup line (AI off, no key, note unread) takes only focus, and the words
 * wait for the ready bar.
 */
export function takeComposerRequest(who: "bar" | "setup"): { focus: boolean; text: string | null } {
  const { focus, text } = useComposerRequest.getState();
  if (who === "bar") {
    if (focus || text !== null) useComposerRequest.setState({ focus: false, text: null });
    return { focus, text };
  }
  if (focus) useComposerRequest.setState({ focus: false });
  return { focus, text: null };
}

/** Takes a waiting request for the privacy note. */
export function takeNoticeRequest(): boolean {
  const { notice } = useComposerRequest.getState();
  if (notice) useComposerRequest.setState({ notice: false });
  return notice;
}

/** How many bars (or setup lines) listen for Ctrl+J right now. */
let mounted = 0;

/** Counts a bar that listens for Ctrl+J; returns its removal. */
export function registerComposer(): () => void {
  mounted += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mounted -= 1;
  };
}

export function composersMounted(): number {
  return mounted;
}

/**
 * Whether Ctrl+J has to bring the bar back itself: no bar is listening
 * because the layout is "PDF only" (the bar lives under the editor).
 */
export function shortcutNeedsEditor(e: { shortcut: boolean; defaultPrevented: boolean; modal: boolean; mounted: number; layout: string }): boolean {
  return e.shortcut && !e.defaultPrevented && !e.modal && e.mounted === 0 && e.layout === "pdf";
}
