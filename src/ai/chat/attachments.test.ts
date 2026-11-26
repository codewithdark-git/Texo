import { describe, expect, it } from "vitest";
import {
  attachLimitReason,
  capText,
  classifyAttachment,
  dataUrlBytes,
  firstJpegAttempt,
  fitWithin,
  formatBytes,
  looksLikeText,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  MIN_IMAGE_SIDE,
  nextJpegAttempt,
  type JpegAttempt,
} from "./attachments";

describe("fitWithin", () => {
  it("scales the longer side to 1600 and keeps the shape", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(1000, 5000)).toEqual({ width: 320, height: 1600 });
  });

  it("never enlarges and never reaches zero", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(100000, 1)).toEqual({ width: 1600, height: 1 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
  });
});

describe("JPEG attempts", () => {
  it("starts within the size limit at high quality", () => {
    expect(firstJpegAttempt(3200, 1800)).toEqual({ side: MAX_IMAGE_SIDE, quality: 0.85 });
    expect(firstJpegAttempt(640, 480).side).toBe(640);
  });

  it("stops once the picture fits", () => {
    expect(nextJpegAttempt({ side: 1600, quality: 0.85 }, MAX_IMAGE_BYTES)).toBeNull();
  });

  it("lowers quality first, then shrinks, and gives up at the smallest size", () => {
    let a: JpegAttempt | null = { side: 1600, quality: 0.85 };
    const seen: JpegAttempt[] = [];
    // An encoder whose output never fits.
    while (a && seen.length < 100) {
      seen.push(a);
      a = nextJpegAttempt(a, MAX_IMAGE_BYTES + 1);
    }
    expect(a).toBeNull();
    expect(seen.length).toBeLessThan(100);
    expect(seen[1]).toEqual({ side: 1600, quality: 0.75 });
    const shrinks = seen.filter((x, i) => i > 0 && x.side < seen[i - 1].side);
    expect(shrinks.length).toBeGreaterThan(0);
    for (const x of seen) expect(x.side).toBeGreaterThanOrEqual(MIN_IMAGE_SIDE);
    // Sizes only go down.
    for (let i = 1; i < seen.length; i++) expect(seen[i].side).toBeLessThanOrEqual(seen[i - 1].side);
  });

  it("skips a quality step when far too large", () => {
    expect(nextJpegAttempt({ side: 1600, quality: 0.85 }, MAX_IMAGE_BYTES * 3)).toEqual({ side: 1600, quality: 0.65 });
  });
});

describe("kinds and text", () => {
  it("classifies by name and type", () => {
    expect(classifyAttachment("paper.PDF", "")).toBe("pdf");
    expect(classifyAttachment("shot.png", "image/png")).toBe("image");
    expect(classifyAttachment("x", "image/jpeg")).toBe("image");
    expect(classifyAttachment("refs.bib", "")).toBe("text");
    expect(classifyAttachment("data.csv", "text/csv")).toBe("text");
    expect(classifyAttachment("model.bin", "application/octet-stream")).toBe("unknown");
  });

  it("sniffs text and binary", () => {
    expect(looksLikeText(new TextEncoder().encode("\\section{Intro} é"))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false);
    // A multi-byte character cut at the 8 KB mark is still text.
    const long = new TextEncoder().encode("a".repeat(8191) + "é");
    expect(looksLikeText(long)).toBe(true);
  });

  it("measures data URLs and caps text", () => {
    expect(dataUrlBytes("data:image/jpeg;base64,AAAA")).toBe(3);
    expect(dataUrlBytes("data:image/jpeg;base64,AAA=")).toBe(2);
    expect(dataUrlBytes("data:image/jpeg;base64,AA==")).toBe(1);
    expect(capText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(capText("ab", 3)).toEqual({ text: "ab", truncated: false });
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("enforces the backend's counts", () => {
    const six = Array.from({ length: 6 }, () => ({ kind: "image" as const }));
    expect(attachLimitReason(six, "image")).toMatch(/6 pictures/);
    expect(attachLimitReason(six, "text")).toBeNull();
    const ten = Array.from({ length: 10 }, () => ({ kind: "text" as const }));
    expect(attachLimitReason(ten, "text")).toMatch(/10 files/);
  });
});
