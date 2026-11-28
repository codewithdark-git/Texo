// Moving between editor tabs with the arrow keys shows each tab as it goes,
// but the keyboard should stay in the tab strip. The tab strip asks for that
// here before it shows a tab; the code and visual editors check it before
// taking focus on their own.

/** How long a request to keep focus on the tabs lasts (the visual editor focuses after it loads). */
export const HOLD_MS = 1500;

let heldUntil = 0;

/** Called by the tab strip before an arrow key shows a tab. */
export function holdTabFocus(now = Date.now()) {
  heldUntil = now + HOLD_MS;
}

/** Called when a tab is shown some other way (a click, Enter): the editor may take focus again. */
export function releaseTabFocus() {
  heldUntil = 0;
}

/** Whether an editor may take focus now that its file came in front. */
export function editorMayFocus(focusInTabs: boolean, now = Date.now()): boolean {
  return !(focusInTabs && now < heldUntil);
}

/** True while focus is on one of the editor tabs. */
export function focusInTabs(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.activeElement?.closest?.("[data-editor-tabs]");
}

/** What the editors call before they focus themselves when their file comes in front. */
export const mayAutoFocus = () => editorMayFocus(focusInTabs());
