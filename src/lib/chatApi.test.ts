import { describe, expect, it } from "vitest";
import { applyChatEvent, emptyAnswer, findMentions, type ChatEventBody, type ChatMessage } from "./chatApi";

const replay = (events: ChatEventBody[]) => events.reduce(applyChatEvent, emptyAnswer());

describe("applyChatEvent", () => {
  it("appends deltas and replaces after a retry", () => {
    const a = replay([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "replace", text: "" },
      { type: "delta", text: "Fresh" },
    ]);
    expect(a.text).toBe("Fresh");
  });

  it("tracks tools, notices and a proposed task", () => {
    const a = replay([
      { type: "toolStarted", name: "read_file", summary: "Reading main.tex" },
      { type: "notice", message: "Switched model" },
      { type: "notice", message: "Switched model" },
      { type: "proposedTask", task: { prompt: "Fix it", files: ["main.tex"] } },
    ]);
    expect(a.tools).toEqual([{ name: "read_file", summary: "Reading main.tex", ok: true, ms: 0, running: true }]);
    expect(a.notices).toEqual(["Switched model"]);
    const b = applyChatEvent(a, { type: "toolFinished", tool: { name: "read_file", summary: "Read main.tex", ok: false, ms: 4 } });
    expect(b.tools).toEqual([{ name: "read_file", summary: "Read main.tex", ok: false, ms: 4, running: false }]);
    expect(b.proposedTask?.prompt).toBe("Fix it");
  });

  it("takes the saved message as final", () => {
    const message: ChatMessage = { id: "m", role: "assistant", text: "Final", created: 1, stopped: true };
    const a = replay([{ type: "delta", text: "Fin" }, { type: "done", message }]);
    expect(a.text).toBe("Final");
    expect(a.done).toBe(message);
    expect(a.tools).toEqual([]);
  });
});

describe("findMentions", () => {
  it("finds @files once, not e-mail addresses", () => {
    expect(findMentions("look at @main.tex and @chapters\\intro.tex, also @main.tex. mail me@x.org")).toEqual([
      "main.tex",
      "chapters/intro.tex",
    ]);
  });
});
