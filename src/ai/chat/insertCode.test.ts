import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ file: "main.tex" as string | null, inserted: [] as string[], focus: vi.fn() }));

vi.mock("../../workspace/editorBridge", () => ({
  insertAtCursor: (text: string) => {
    if (h.file) h.inserted.push(text);
    return h.file;
  },
  getActiveEditor: () => ({ focus: h.focus }),
}));

import { useAiTabs } from "../tabs/aiTabsStore";
import { insertCode } from "./insertCode";

const frames: (() => void)[] = [];
vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

beforeEach(() => {
  h.file = "main.tex";
  h.inserted = [];
  h.focus.mockClear();
  frames.length = 0;
  useAiTabs.getState().reset();
});

describe("Insert from the Chat tab", () => {
  it("puts the file back in front and focuses its editor once it shows", () => {
    useAiTabs.getState().open("chat");
    expect(insertCode("\alpha")).toBe("main.tex");
    expect(h.inserted).toEqual(["\alpha"]);
    expect(useAiTabs.getState().active).toBeNull();
    // The Chat tab stays open behind the file.
    expect(useAiTabs.getState().tabs).toEqual(["chat"]);
    expect(h.focus).not.toHaveBeenCalled();
    frames.forEach((fn) => fn());
    expect(h.focus).toHaveBeenCalledOnce();
  });

  it("leaves the Chat tab in front when no file is open", () => {
    h.file = null;
    useAiTabs.getState().open("chat");
    expect(insertCode("x")).toBeNull();
    expect(useAiTabs.getState().active).toBe("chat");
    expect(frames).toHaveLength(0);
  });
});
