import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DraftAttachment, SendInput } from "../chat/chatStore";
import { buildSendInput } from "../chat/sendInput";
import {
  alreadyAttached,
  COMPOSER_SHORTCUT,
  composerKey,
  attachableFiles,
  includedFile,
  includeLabel,
  isComposerShortcut,
  modalOpen,
  MONACO_RESERVED,
  placeholderFor,
  selectionName,
  sendFromBar,
  shortcutOf,
  suggestFiles,
  type BarChatState,
  type EditorContext,
} from "./composerLogic";

// The editor modules load Monaco, which needs a browser; the bar only needs these few calls.
vi.mock("../../workspace/store", () => ({ useWorkspace: (pick: (s: unknown) => unknown) => pick({ active: null, views: {}, files: [] }) }));
vi.mock("../../workspace/editorBridge", () => ({ getActiveEditor: () => null }));
vi.mock("../chat/composerActions", () => ({ activeTextFile: () => null, attachFiles: () => {}, CHAT_DROP_ATTR: "data-chat-drop", currentFileContext: () => undefined, dirtyBuffers: () => [] }));
vi.mock("./barActions", () => ({ attachProjectFile: async () => {}, clearAttachments: () => {}, startAgentFromBar: async () => "failed", useAgentProfiles: () => [] }));
vi.mock("../chat/Composer", () => ({ ModelPicker: () => null }));

import { ComposerBarFor } from "./AiComposerBar";

describe("buildSendInput", () => {
  /** What Composer.submit built inline before the helper existed. */
  function before(draft: string, attachments: DraftAttachment[], file: SendInput["currentFile"], dirty: { file: string; text: string }[], choice?: string): SendInput {
    const ready = attachments.filter((a) => a.status === "ready");
    return {
      text: draft,
      attachments: ready.map((a) => (a.kind === "image" ? { name: a.name, mime: a.mime ?? "image/jpeg", dataUrl: a.dataUrl } : { name: a.name, mime: a.mime ?? "text/plain", text: a.text ?? "" })),
      currentFile: file,
      dirtyBuffers: dirty,
      ...(choice ? { model: choice } : {}),
    };
  }

  const atts: DraftAttachment[] = [
    { id: "a1", name: "fig.png", status: "ready", kind: "image", mime: "image/png", dataUrl: "data:image/png;base64,AA" },
    { id: "a2", name: "notes.txt", status: "ready", kind: "text", text: "hello" },
    { id: "a3", name: "big.pdf", status: "reading" },
    { id: "a4", name: "shot", status: "ready", kind: "image", dataUrl: "data:x" },
    { id: "a5", name: "empty.md", status: "ready", kind: "text", mime: "text/markdown" },
  ];
  const cases: [string, DraftAttachment[], SendInput["currentFile"], { file: string; text: string }[], string | undefined][] = [
    ["Hi", [], undefined, [], undefined],
    ["Explain this", atts, { file: "main.tex", text: "\\documentclass{article}" }, [{ file: "a.tex", text: "x" }], "gpt-x"],
    ["", atts, { file: "main.tex", text: "t", selection: { startLine: 1, endLine: 2, text: "t" } }, [], ""],
    ["  spaced  ", [atts[2]], undefined, [], "m"],
  ];

  it.each(cases)("matches what the composer sent before (%j)", (text, attachments, currentFile, dirtyBuffers, model) => {
    expect(buildSendInput({ text, attachments, currentFile, dirtyBuffers, model })).toEqual(before(text, attachments, currentFile, dirtyBuffers, model));
  });

  it("keeps a fixed shape", () => {
    expect(buildSendInput({ text: "Explain", attachments: atts, currentFile: { file: "main.tex" }, dirtyBuffers: [], model: "m1" })).toMatchInlineSnapshot(`
      {
        "attachments": [
          {
            "dataUrl": "data:image/png;base64,AA",
            "mime": "image/png",
            "name": "fig.png",
          },
          {
            "mime": "text/plain",
            "name": "notes.txt",
            "text": "hello",
          },
          {
            "dataUrl": "data:x",
            "mime": "image/jpeg",
            "name": "shot",
          },
          {
            "mime": "text/markdown",
            "name": "empty.md",
            "text": "",
          },
        ],
        "currentFile": {
          "file": "main.tex",
        },
        "dirtyBuffers": [],
        "model": "m1",
        "text": "Explain",
      }
    `);
  });

  it("puts the bar's own attachments first", () => {
    const out = buildSendInput({ text: "x", attachments: [atts[1]], extra: [{ name: "Selection", mime: "text/plain", text: "sel" }], dirtyBuffers: [] });
    expect(out.attachments.map((a) => a.name)).toEqual(["Selection", "notes.txt"]);
    expect(out).not.toHaveProperty("model");
  });
});

describe("include", () => {
  const sel = { startLine: 3, endLine: 7, text: "\\section{Intro}" };
  const withSel: EditorContext = { file: "chapters/intro.tex", text: "whole file", selection: sel };
  const noSel: EditorContext = { file: "main.tex", text: "whole file", selection: null };
  const none: EditorContext = { file: null, selection: null };

  it("names the open file, or the selection when there is one", () => {
    expect(includeLabel(noSel)).toBe("Include main.tex");
    expect(includeLabel(withSel)).toBe("Include selection");
    expect(includeLabel(none)).toBe("Include current file");
  });

  it("sends the open file with its selection when on", () => {
    expect(includedFile(true, withSel)).toEqual({ file: "chapters/intro.tex", text: "whole file", selection: sel });
    expect(includedFile(true, noSel)).toEqual({ file: "main.tex", text: "whole file" });
  });

  it("sends nothing when off or no file is open", () => {
    expect(includedFile(false, withSel)).toBeUndefined();
    expect(includedFile(true, none)).toBeUndefined();
  });

  it("says what the message is about", () => {
    expect(placeholderFor(withSel, true)).toBe("AI Chat: ask about the selection…");
    expect(placeholderFor(noSel, true)).toBe("AI Chat: ask about main.tex…");
    expect(placeholderFor(noSel, false)).toBe("AI Chat: ask about your project…");
    expect(placeholderFor(none, true)).toBe("AI Chat: ask about your project…");
  });

  it("names a one-line selection", () => {
    expect(selectionName("C:\\p\\main.tex", { startLine: 4, endLine: 4 })).toBe("Selection from main.tex, line 4");
    expect(selectionName("main.tex", { startLine: 3, endLine: 7 })).toBe("Selection from main.tex, lines 3–7");
  });
});

describe("project files", () => {
  const files = [
    { path: "main.tex", isDir: false, size: 1 },
    { path: "figures", isDir: true, size: 0 },
    { path: "figures/plot.png", isDir: false, size: 1 },
    { path: "refs.bib", isDir: false, size: 1 },
    { path: "main.aux", isDir: false, size: 1 },
    { path: ".texo/state.json", isDir: false, size: 1 },
    { path: "paper.pdf", isDir: false, size: 1 },
  ];

  it("offers text, pictures and PDFs, not folders, build output or Texo's own files", () => {
    expect(attachableFiles(files)).toEqual(["main.tex", "figures/plot.png", "refs.bib", "paper.pdf"]);
  });

  it("finds files by a fuzzy filter", () => {
    const paths = attachableFiles(files);
    expect(suggestFiles(paths, "plot")).toEqual(["figures/plot.png"]);
    expect(suggestFiles(paths, "").length).toBe(4);
    expect(suggestFiles(paths, "", 2).length).toBe(2);
  });

  it("doesn't attach the same project picture twice once its chip is renamed to .jpg", () => {
    const sources = new Map([["proj-1", "figures/plot.png"]]);
    const chips = [{ id: "proj-1", name: "plot.jpg" }];
    expect(alreadyAttached(chips, "figures/plot.png", sources)).toBe(true);
    expect(alreadyAttached(chips, "figures/other.png", sources)).toBe(false);
    expect(alreadyAttached([{ id: "proj-2", name: "main.tex" }], "main.tex", new Map())).toBe(true);
    expect(alreadyAttached([], "figures/plot.png", sources)).toBe(false);
  });
});

describe("keys", () => {
  it("sends on Enter and leaves Shift+Enter as a new line", () => {
    expect(composerKey({ key: "Enter" })).toBe("send");
    expect(composerKey({ key: "Enter", shiftKey: true })).toBe("newline");
    expect(composerKey({ key: "Enter", ctrlKey: true })).toBeNull();
    expect(composerKey({ key: "Enter", altKey: true })).toBeNull();
    expect(composerKey({ key: "Enter", isComposing: true })).toBeNull();
    expect(composerKey({ key: "a" })).toBeNull();
  });

  it("goes back to the editor on Esc", () => {
    expect(composerKey({ key: "Escape" })).toBe("blur");
    expect(composerKey({ key: "Escape", shiftKey: true })).toBeNull();
  });

  it("uses a shortcut the code editor leaves free", () => {
    expect(MONACO_RESERVED).not.toContain(COMPOSER_SHORTCUT);
    expect(MONACO_RESERVED).toContain("ctrl+shift+l");
    expect(new Set(MONACO_RESERVED).size).toBe(MONACO_RESERVED.length);
    for (const k of MONACO_RESERVED) expect(k).toBe(k.toLowerCase());
  });

  it("reads Ctrl+J and nothing else as the shortcut", () => {
    expect(shortcutOf({ key: "J", ctrlKey: true, shiftKey: true })).toBe("ctrl+shift+j");
    expect(isComposerShortcut({ key: "j", ctrlKey: true })).toBe(true);
    expect(isComposerShortcut({ key: "J", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isComposerShortcut({ key: "j", ctrlKey: true, altKey: true })).toBe(false);
    expect(isComposerShortcut({ key: "j" })).toBe(false);
  });
});

describe("AiComposerBar markup", () => {
  const provider = { id: "openai", label: "OpenAI" } as never;

  it("shows the Set up AI line when AI is off or has no key", () => {
    for (const access of [{ state: "off" as const }, { state: "noKey" as const, provider }]) {
      const html = renderToStaticMarkup(createElement(ComposerBarFor, { access, project: "p" }));
      expect(html).toContain("Set up AI in Settings");
      expect(html).not.toContain("<textarea");
    }
  });

  it("shows nothing while access is checked", () => {
    expect(renderToStaticMarkup(createElement(ComposerBarFor, { access: { state: "loading" }, project: "p" }))).toBe("");
  });

  it("shows the one-line bar when ready", () => {
    const html = renderToStaticMarkup(createElement(ComposerBarFor, { access: { state: "ready", provider }, project: "p" }));
    expect(html).toContain("<textarea");
    expect(html).toContain('aria-label="Message to AI Chat"');
    expect(html).toContain("AI Chat: ask about your project…");
    expect(html).toContain("Ctrl+J");
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("texo-collapse");
    expect(html).toContain("Include current file");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("Set up AI");
  });
});

describe("sendFromBar", () => {
  /** A tiny store with the chat store's set/subscribe behaviour. */
  function fakeStore(initial: BarChatState) {
    let state = initial;
    const listeners = new Set<(s: BarChatState) => void>();
    return {
      getState: () => state,
      setState: (fn: (s: BarChatState) => Partial<BarChatState>) => {
        state = { ...state, ...fn(state) };
        for (const l of [...listeners]) l(state);
      },
      subscribe: (l: (s: BarChatState) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
  }

  it("keeps the panel's draft when the bar sends to the open chat", async () => {
    const store = fakeStore({ current: { id: "c1" }, drafts: { c1: "half a thought" }, failure: null });
    const failed = await sendFromBar(store, async () => {
      store.setState((s) => ({ drafts: { ...s.drafts, c1: "" } }));
    });
    expect(failed).toBe(false);
    expect(store.getState().drafts.c1).toBe("half a thought");
  });

  it("moves the panel's draft into the chat a send creates", async () => {
    const store = fakeStore({ current: null, drafts: { "": "new chat words" }, failure: null });
    await sendFromBar(store, async () => {
      store.setState((s) => ({ current: { id: "n1" }, drafts: { ...s.drafts, "": "" } }));
      store.setState((s) => ({ drafts: { ...s.drafts, n1: "" } }));
    });
    expect(store.getState().drafts.n1).toBe("new chat words");
  });

  it("reports a failed create so the bar can put its words back", async () => {
    const store = fakeStore({ current: null, drafts: {}, failure: null });
    const failed = await sendFromBar(store, async () => {
      store.setState(() => ({ failure: { chatId: "", request: { text: "hello" } } }));
    });
    expect(failed).toBe(true);
  });

  it("leaves the bar's words out of the panel when a send fails", async () => {
    const store = fakeStore({ current: { id: "c1" }, drafts: { c1: "" }, failure: null });
    const failed = await sendFromBar(store, async () => {
      store.setState((s) => ({ drafts: { ...s.drafts, c1: "" } }));
      store.setState((s) => ({ failure: { chatId: "c1", request: { text: "hello" } }, drafts: { ...s.drafts, c1: "hello" } }));
    });
    expect(failed).toBe(true);
    expect(store.getState().drafts.c1).toBe("");
  });

  it("doesn't count an older failure as this send's", async () => {
    const old = { chatId: "c1", request: { text: "old" } };
    const store = fakeStore({ current: { id: "c1" }, drafts: {}, failure: old });
    expect(await sendFromBar(store, async () => {})).toBe(false);
  });
});

describe("modalOpen", () => {
  it("is true only while an aria-modal dialog is in the page", () => {
    expect(modalOpen({ querySelector: (q: string) => (q === '[aria-modal="true"]' ? ({} as Element) : null) } as never)).toBe(true);
    expect(modalOpen({ querySelector: () => null } as never)).toBe(false);
    expect(modalOpen(undefined)).toBe(false);
  });
});
