// Keeps the mouse wheel scrolling the code editor when a popup is under the
// pointer. Monaco's hovers (a problem's "View Problem / Quick Fix"), the
// suggestion details and the quick-fix menu swallow every wheel event while
// they're open, even when they have nothing to scroll, so the text seemed
// stuck. Here, a popup that can still scroll that way keeps the wheel; one
// that can't is closed and the editor scrolls instead.

import type { monaco } from "./monaco";

/** Monaco's popups (and Texo's maths preview) that may sit over the text. */
export const POPUP_SELECTOR = ".monaco-hover, .suggest-details, .action-widget, .parameter-hints-widget, .texo-math-hover";

interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/** True when `el` can still move in the wheel's direction (the dominant axis). */
export function canScrollFurther(el: ScrollMetrics, deltaX: number, deltaY: number): boolean {
  if (Math.abs(deltaY) >= Math.abs(deltaX)) {
    if (el.scrollHeight - el.clientHeight < 1 || deltaY === 0) return false;
    return deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
  }
  if (el.scrollWidth - el.clientWidth < 1) return false;
  return deltaX > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0;
}

/** The wheel delta in pixels: browsers may report it in lines (1) or pages (2). */
export function wheelPixels(delta: number, deltaMode: number, lineHeight: number, pageSize: number): number {
  if (deltaMode === 1) return delta * lineHeight;
  if (deltaMode === 2) return delta * pageSize;
  return delta;
}

/** Pixels Monaco scrolls per unit of a wheel's legacy `wheelDelta` (it moves 50px per 120). */
const MONACO_PX_PER_WHEEL_DELTA = 50 / 120;

/**
 * How far the editor would scroll for this wheel over the text, so a wheel
 * taken from a popup moves it by the same amount. Chromium's legacy
 * `wheelDeltaX/Y` is what Monaco itself reads; without it, a pixel delta
 * scaled the same way (Chromium reports 1.2 wheelDelta per pixel).
 */
export function editorWheelPixels(
  e: { deltaX: number; deltaY: number; deltaMode: number; wheelDeltaX?: number; wheelDeltaY?: number },
  lineHeight: number,
  size: { width: number; height: number },
): { x: number; y: number } {
  const axis = (legacy: number | undefined, delta: number, page: number) =>
    legacy ? -legacy * MONACO_PX_PER_WHEEL_DELTA : e.deltaMode === 0 ? delta * 1.2 * MONACO_PX_PER_WHEEL_DELTA : wheelPixels(delta, e.deltaMode, lineHeight, page);
  return { x: axis(e.wheelDeltaX, e.deltaX, size.width), y: axis(e.wheelDeltaY, e.deltaY, size.height) };
}

/** The popup around `target`, if it's in one. */
function popupOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? (target.closest(POPUP_SELECTOR) as HTMLElement | null) : null;
}

/** True when some element from `target` up to `popup` can scroll the wheel's way. */
function popupCanScroll(target: Element, popup: HTMLElement, e: WheelEvent): boolean {
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (canScrollFurther(el, e.deltaX, e.deltaY)) return true;
    if (el === popup) break;
  }
  return false;
}

type HoverController = monaco.editor.IEditorContribution & { hideContentHover?: () => void };

/** Closes Monaco's hover (a problem's "View Problem" box, say). */
function hideHover(editor: monaco.editor.ICodeEditor) {
  editor.getContribution<HoverController>("editor.contrib.contentHover")?.hideContentHover?.();
}

/** Closes Monaco's hover, suggestion details and quick-fix menu on `editor`. */
export function hidePopups(editor: monaco.editor.ICodeEditor) {
  hideHover(editor);
  for (const id of ["hideSuggestWidget", "hideCodeActionWidget"]) {
    try {
      editor.trigger("texo", id, null);
    } catch {
      // Not registered in this build; nothing to close.
    }
  }
}

/**
 * Installs the wheel rule on a code editor. `m` is the Monaco API (passed in
 * so this module stays importable from tests); `onPassThrough` runs whenever
 * the editor takes a wheel from a popup.
 */
export function attachWheelPassthrough(
  m: typeof monaco,
  editor: monaco.editor.ICodeEditor,
  onPassThrough?: () => void,
): { dispose(): void } {
  const onWheel = (e: WheelEvent) => {
    const popup = popupOf(e.target);
    if (!popup || !(e.target instanceof Element)) return;
    const node = editor.getDomNode();
    // A popup outside this editor (the quick-fix menu lives on the page) only
    // counts while this editor is the one being worked in.
    if (node && !node.contains(popup) && !editor.hasTextFocus() && !editor.hasWidgetFocus()) return;
    if (popupCanScroll(e.target, popup, e)) return;
    e.preventDefault();
    e.stopPropagation();
    hidePopups(editor);
    onPassThrough?.();
    // Scroll as far as an ordinary wheel over the text would.
    const layout = editor.getLayoutInfo();
    const lineHeight = editor.getOption(m.editor.EditorOption.lineHeight);
    const legacy = e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
    const px = editorWheelPixels(
      { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, wheelDeltaX: legacy.wheelDeltaX, wheelDeltaY: legacy.wheelDeltaY },
      lineHeight,
      layout,
    );
    editor.setScrollPosition({ scrollTop: editor.getScrollTop() + px.y, scrollLeft: editor.getScrollLeft() + px.x });
  };
  // Capture on the page, so this runs before Monaco's own wheel handling
  // inside the popup (which would swallow the event).
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  // A click in the text closes a hover left open under the pointer.
  const down = editor.onMouseDown((e) => {
    const { CONTENT_TEXT, CONTENT_EMPTY } = m.editor.MouseTargetType;
    if (e.target.type === CONTENT_TEXT || e.target.type === CONTENT_EMPTY) hideHover(editor);
  });
  return {
    dispose() {
      window.removeEventListener("wheel", onWheel, { capture: true });
      down.dispose();
    },
  };
}
