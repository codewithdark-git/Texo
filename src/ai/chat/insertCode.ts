// "Insert" on a chat code block: the code goes in at the cursor of the file in
// front, and that file comes back in front of the Chat tab (which hides the
// editor), so the new text, and Ctrl+Z to take it out, are right there.

import { getActiveEditor, insertAtCursor } from "../../workspace/editorBridge";
import { useAiTabs } from "../tabs/aiTabsStore";

/** Inserts `code` into the file in front and shows that file; returns the file, or null with none open. */
export function insertCode(code: string): string | null {
  const file = insertAtCursor(code);
  if (!file) return null;
  useAiTabs.getState().activate(null);
  // The editor was hidden behind the AI tab: focus it once it shows again.
  requestAnimationFrame(() => getActiveEditor()?.focus());
  return file;
}
