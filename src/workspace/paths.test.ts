import { describe, expect, it } from "vitest";
import { nativePath } from "./paths";

describe("nativePath", () => {
  it("uses the separator of the project's own path", () => {
    expect(nativePath("C:\\Users\\me\\Paper", "sec/intro.tex")).toBe("C:\\Users\\me\\Paper\\sec\\intro.tex");
    expect(nativePath("/home/me/Paper", "sec/intro.tex")).toBe("/home/me/Paper/sec/intro.tex");
    expect(nativePath("/home/me/Paper", "")).toBe("/home/me/Paper");
  });
});
