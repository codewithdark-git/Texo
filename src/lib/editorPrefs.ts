// Editor preferences shared by the code editor, Visual mode, and Settings.
export interface EditorPrefs { fontSize: number; wordWrap: boolean; defaultTexMode: "code" | "visual"; defaultMdMode: "code" | "visual"; mathHover: boolean; visualShowComments: boolean; displayMath: "brackets" | "equation" }
const KEY = "texo.editor";
export const DEFAULT_EDITOR_PREFS: EditorPrefs = { fontSize: 14, wordWrap: true, defaultTexMode: "code", defaultMdMode: "visual", mathHover: true, visualShowComments: true, displayMath: "brackets" };
export function getEditorPrefs(): EditorPrefs {
  try { return { ...DEFAULT_EDITOR_PREFS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return { ...DEFAULT_EDITOR_PREFS }; }
}
const listeners = new Set<(prefs: EditorPrefs) => void>();
export function setEditorPrefs(patch: Partial<EditorPrefs>): EditorPrefs {
  const next = { ...getEditorPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not important */ }
  listeners.forEach((fn) => fn(next));
  return next;
}
export function onEditorPrefs(fn: (prefs: EditorPrefs) => void): () => void { listeners.add(fn); return () => void listeners.delete(fn); }
