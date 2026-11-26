import { describe, expect, it } from "vitest";
import { badBaseUrl, DEFAULT_AI_SETTINGS, normalizeAiSettings } from "./aiPrefs";

describe("normalizeAiSettings", () => {
  it("falls back to defaults", () => {
    expect(normalizeAiSettings(null)).toEqual(DEFAULT_AI_SETTINGS);
    expect(normalizeAiSettings("x")).toEqual(DEFAULT_AI_SETTINGS);
    expect(normalizeAiSettings([1]).provider).toBe("nvidia");
  });

  it("keeps valid values and drops the rest", () => {
    const s = normalizeAiSettings({
      enabled: false,
      provider: "groq",
      models: { groq: "m", bogus: "x", nvidia: 3 },
      customBaseUrl: "http://localhost:11434/v1",
      noticeAccepted: ["groq", "evil"],
      apiKey: "sk-123",
    });
    expect(s).toEqual({
      enabled: false,
      provider: "groq",
      models: { groq: "m" },
      customBaseUrl: "http://localhost:11434/v1",
      noticeAccepted: ["groq"],
    });
    expect(JSON.stringify(s)).not.toContain("sk-123");
    expect(normalizeAiSettings({ provider: "openai" }).provider).toBe("nvidia");
  });
});

describe("badBaseUrl", () => {
  it("accepts http and https servers", () => {
    expect(badBaseUrl("http://localhost:11434/v1")).toBeNull();
    expect(badBaseUrl("https://example.com/v1")).toBeNull();
  });

  it("explains bad addresses", () => {
    expect(badBaseUrl("")).toMatch(/address/);
    expect(badBaseUrl("localhost:1234")).toBeTruthy();
    expect(badBaseUrl("file:///etc/passwd")).toMatch(/http/);
    expect(badBaseUrl("https://user:secret@example.com")).toMatch(/key field/);
  });
});
