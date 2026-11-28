// Reduced motion must cover every animation: these checks fail when a new
// animated class is added to styles.css without its reduced-motion rule, or a
// duration token is added without being shortened.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Read from disk: Vitest doesn't process CSS, so `styles.css?raw` comes back empty.
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

interface Rule {
  /** The selector or at-rule prelude, whitespace collapsed. */
  prelude: string;
  /** The declarations directly inside the braces. */
  declarations: string;
  children: Rule[];
}

/** A small CSS parser: enough for nesting and declarations, ignoring strings with braces. */
function parse(source: string): Rule[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const block = (): Rule[] => {
    const rules: Rule[] = [];
    let text = "";
    while (i < src.length) {
      const c = src[i++];
      if (c === "{") {
        const lastSemi = text.lastIndexOf(";");
        const prelude = text.slice(lastSemi + 1).replace(/\s+/g, " ").trim();
        const start = rules.length;
        const inner = block();
        rules.splice(start, 0, { prelude, declarations: innerDeclarations, children: inner });
        text = "";
      } else if (c === "}") {
        innerDeclarations = text;
        return rules;
      } else text += c;
    }
    innerDeclarations = text;
    return rules;
  };
  let innerDeclarations = "";
  return block();
}

/** Splits a selector list on top-level commas. */
const selectors = (prelude: string) => prelude.split(/,(?![^(]*\))/).map((s) => s.trim());

/** Every style rule, with the at-rule it sits in ("" at the top level). */
function styleRules(rules: Rule[], context = ""): { rule: Rule; context: string }[] {
  return rules.flatMap((rule) => {
    if (rule.prelude.startsWith("@keyframes")) return [];
    if (rule.prelude.startsWith("@")) return styleRules(rule.children, rule.prelude);
    return [{ rule, context }, ...styleRules(rule.children, context)];
  });
}

const all = styleRules(parse(css));
const MEDIA = "@media (prefers-reduced-motion: reduce)";
const SYSTEM = ':root:not([data-motion="full"])';
const SETTING = ':root[data-motion="reduce"]';
const isReduced = (s: string) => s.startsWith(SYSTEM) || s.startsWith(SETTING);

/** The selectors in the reduced-motion rules, one set per way of asking for it. */
function reducedSelectors() {
  const system = new Set<string>();
  const setting = new Set<string>();
  for (const { rule, context } of all) {
    for (const s of selectors(rule.prelude)) {
      if (context === MEDIA && s.startsWith(SYSTEM + " ")) system.add(s.slice(SYSTEM.length + 1));
      if (context === "" && s.startsWith(SETTING + " ")) setting.add(s.slice(SETTING.length + 1));
    }
  }
  return { system, setting };
}

describe("reduced motion in styles.css", () => {
  it("the parser finds the rules it needs to", () => {
    expect(all.length).toBeGreaterThan(20);
    expect(all.some(({ rule }) => rule.prelude === ".texo-pop")).toBe(true);
    expect(all.some(({ context }) => context === MEDIA)).toBe(true);
  });

  it("lists every animated selector in both reduced-motion blocks", () => {
    const { system, setting } = reducedSelectors();
    const animated = all
      .filter(({ rule }) => /(^|[;\s])animation\s*:/.test(rule.declarations))
      .flatMap(({ rule }) => selectors(rule.prelude))
      .filter((s) => !isReduced(s));
    expect(animated.length).toBeGreaterThan(10);
    for (const s of animated) {
      expect(system.has(s), `${s} under ${MEDIA}`).toBe(true);
      expect(setting.has(s), `${s} under ${SETTING}`).toBe(true);
    }
  });

  it("the reduced rules only fade or stop (spinners and the sync mark may keep their own fade or turn)", () => {
    const allowed = /^(none|texo-fade|texo-fade-out|texo-breathe|texo-spin|texo-flash|texo-sync-fade)\b/;
    for (const { rule } of all) {
      if (!selectors(rule.prelude).every(isReduced)) continue;
      const animation = /(?:^|[;\s])animation\s*:\s*([^;]+)/.exec(rule.declarations)?.[1].trim();
      if (animation) expect(animation, rule.prelude).toMatch(allowed);
    }
  });

  it("shortens every duration token both ways", () => {
    const root = all.find(({ rule, context }) => context === "" && rule.prelude === ":root")!;
    const tokens = [...root.rule.declarations.matchAll(/(--dur-[\w-]+)\s*:/g)].map((m) => m[1]);
    expect(tokens).toEqual(expect.arrayContaining(["--dur-1", "--dur-2", "--dur-3", "--dur-4", "--dur-5", "--dur-fade"]));
    const system = all.find(({ rule, context }) => context === MEDIA && rule.prelude === SYSTEM);
    const setting = all.find(({ rule, context }) => context === "" && rule.prelude === SETTING);
    for (const token of tokens) {
      expect(system?.rule.declarations, `${token} under ${MEDIA}`).toMatch(new RegExp(`${token}\\s*:`));
      expect(setting?.rule.declarations, `${token} under ${SETTING}`).toMatch(new RegExp(`${token}\\s*:`));
    }
  });

  it("gives the light theme its own status colours in both light blocks", () => {
    const light = all.filter(({ rule }) => rule.prelude === ':root[data-theme="light"]' || rule.prelude === ":root:not([data-theme])");
    expect(light).toHaveLength(2);
    for (const { rule } of light) {
      for (const token of ["--success", "--warning", "--info", "--shadow-pop"]) expect(rule.declarations).toContain(`${token}:`);
    }
  });
});
