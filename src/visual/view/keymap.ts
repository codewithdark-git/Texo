// Visual mode's keyboard shortcuts. Undo and redo are the code editor's, so
// they work across mode switches; Ctrl+Enter is left to the window (compile).

import { NodeSelection, type Plugin, type Command } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands } from "prosemirror-commands";
import { useWorkspace } from "../../workspace/store";
import { syncToPdf } from "../../workspace/PdfViewer";
import { enter, hardBreak, liftItem, setBlock, sinkItem, toggleMark, type GetEnv } from "./commands";
import { codeFence, undoInputRule } from "./inputRules";
import * as actions from "./actions";
import { activateNodeAt } from "./nodeviews/common";

/** Enter or Space on a selected atom opens its editor, as a click does. */
const activateSelected: Command = (state, _dispatch, view) => {
  const sel = state.selection;
  if (!(sel instanceof NodeSelection) || !sel.node.isAtom || !view) return false;
  return activateNodeAt(view, sel.from);
};

export interface KeymapHooks {
  openFind(replace: boolean): void;
}

export function buildKeymap(getEnv: GetEnv, hooks: KeymapHooks): Plugin[] {
  const withEnv =
    (fn: (env: NonNullable<ReturnType<GetEnv>>) => void): Command =>
    () => {
      const env = getEnv();
      if (!env) return false;
      fn(env);
      return true;
    };

  const keys: Record<string, Command> = {
    "Mod-b": toggleMark(getEnv, "bold"),
    "Mod-i": toggleMark(getEnv, "italic"),
    "Mod-u": toggleMark(getEnv, "underline"),
    "Mod-e": toggleMark(getEnv, "code"),
    "Mod-Shift-m": withEnv((env) => actions.mathInline(env)),
    "Mod-k": withEnv((env) => actions.link(env)),
    "Mod-Alt-0": setBlock(getEnv, 0),
    "Mod-Alt-1": setBlock(getEnv, 1),
    "Mod-Alt-2": setBlock(getEnv, 2),
    "Mod-Alt-3": setBlock(getEnv, 3),
    "Mod-Alt-4": setBlock(getEnv, 4),
    Tab: sinkItem(getEnv),
    "Shift-Tab": liftItem(getEnv),
    Enter: chainCommands(activateSelected, codeFence(getEnv), enter(getEnv)),
    Space: activateSelected,
    "Shift-Enter": hardBreak(getEnv),
    Backspace: (state) => {
      const env = getEnv();
      if (!env || !state.selection.empty) return false;
      return undoInputRule(env);
    },
    "Mod-s": () => {
      const path = getEnv()?.path;
      if (path) void useWorkspace.getState().save(path);
      return true;
    },
    "Mod-Alt-j": withEnv((env) => {
      const line = env.binding.model.getPositionAt(env.binding.sourceOffset()).lineNumber;
      void syncToPdf(env.path, line).catch(() => {});
    }),
    "Mod-z": withEnv((env) => env.binding.undo()),
    "Mod-y": withEnv((env) => env.binding.redo()),
    "Mod-Shift-z": withEnv((env) => env.binding.redo()),
    "Mod-f": () => {
      hooks.openFind(false);
      return true;
    },
    "Mod-h": () => {
      hooks.openFind(true);
      return true;
    },
  };

  // The base editing keys, minus Mod-Enter, which compiles.
  const base: Record<string, Command> = { ...baseKeymap };
  delete base["Mod-Enter"];

  return [keymap(keys), keymap(base)];
}
