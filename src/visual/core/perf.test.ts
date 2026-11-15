// Soft performance checks. The design budgets on a quiet machine are: cold
// parse of a 250 KB thesis under 60 ms, warm re-sync under 15 ms, a 1-char
// plan under 2 ms, and 50 inbound changes under 20 ms. Test files run in
// parallel (and CI machines are often busy), so absolute times are noisy:
// these tests assert the budgets relative to the cold parse measured in the
// same conditions, plus a generous absolute ceiling.

import { describe, expect, it } from "vitest";
import { Transform } from "prosemirror-transform";
import { createSession, schema } from "./index";
import { thesis } from "./__fixtures__/thesis";

const TEXT = thesis();

function best(n: number, fn: () => void): number {
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    min = Math.min(min, performance.now() - t);
  }
  return min;
}

let coldMs = 0;
/** The cold parse time, measured once. */
function cold(): number {
  if (!coldMs) {
    createSession("latex", TEXT); // warm up the JIT
    coldMs = best(3, () => createSession("latex", TEXT + " ".repeat(Math.floor(Math.random() * 3))));
  }
  return coldMs;
}

/** Budget ratio against the cold parse (60 ms in the design), with 2x slack. */
const ratio = (designMs: number) => (designMs / 60) * 2;

describe("performance (soft)", () => {
  it("parses a 250 KB thesis cold", () => {
    expect(cold()).toBeLessThan(2000);
  }, 30_000);

  it("re-syncs warm after a 1-char edit far faster than a cold parse", () => {
    const s = createSession("latex", TEXT);
    const at = TEXT.indexOf("the", 100_000);
    let flip = false;
    const ms = best(10, () => {
      flip = !flip;
      s.syncFromText(flip ? TEXT.slice(0, at) + "X" + TEXT.slice(at) : TEXT);
    });
    expect(ms).toBeLessThan(cold() * ratio(15));
  }, 30_000);

  it("plans a 1-char edit far faster than a cold parse", () => {
    const s = createSession("latex", TEXT);
    let target = -1;
    s.doc.descendants((n, pos) => {
      if (target === -1 && pos > s.doc.content.size / 2 && n.isText) target = pos + 1;
      return target === -1;
    });
    const doc = new Transform(s.doc).insert(target, schema.text("Z")).doc;
    expect(s.plan(doc).ok).toBe(true);
    const ms = best(20, () => s.plan(doc));
    expect(ms).toBeLessThan(Math.max(1, cold() * ratio(2)));
  }, 30_000);

  it("applies 50 inbound changes faster than a cold parse", () => {
    const s = createSession("latex", TEXT);
    let text = TEXT;
    const step = Math.floor(TEXT.length / 52);
    for (let k = 1; k <= 50; k++) {
      const at = text.indexOf(" ", k * step);
      text = text.slice(0, at) + " w" + text.slice(at);
    }
    const ms = best(5, () => {
      s.syncFromText(TEXT);
      s.syncFromText(text);
    });
    expect(ms / 2).toBeLessThan(cold() * ratio(20));
  }, 30_000);
});
