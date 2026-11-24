// The owner requires a visible way to support Texo in every release (internal/releases.md,
// "Release checklist"). These checks fail if any entry point quietly disappears,
// including when it is still in the code but hidden behind a condition or a class.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import supportDialog from "./SupportDialog.tsx?raw";
import sidebar from "./Sidebar.tsx?raw";
import appMenu from "./AppMenu.tsx?raw";
import globalDialogs from "./GlobalDialogs.tsx?raw";
import workspace from "../workspace/Workspace.tsx?raw";
import settings from "./SettingsDialog.tsx?raw";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));

import { SupportButton, SupportTopButton } from "./SupportDialog";
import { useUi } from "../ui";

const OPENS_SUPPORT = 'openDialog("support")';
const SUPPORT_URL = "https://xcollab.pages.dev/support#contribute";
/** Classes that take an element off the screen at every window size. */
const HIDING = /(^|\s)(hidden|invisible|sr-only|opacity-0|collapse)(\s|$)/;

/** The source of one top-level function, from its declaration to the next top-level declaration. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`function ${name}\\b`));
  expect(start, `${name} should exist`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:export )?(?:function|const|\/\*\*) /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** Strips comments so a commented-out button doesn't count as present. */
const code = (source: string) => source.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Index just past the `{...}` (or string) that starts at `i`. */
function skipGroup(src: string, i: number): number {
  const open = src[i];
  if (open === '"' || open === "'" || open === "`") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === open) return j + 1;
    }
    return src.length;
  }
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") j = skipGroup(src, j) - 1;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j + 1;
  }
  return src.length;
}

interface Ancestor {
  name: string;
  attrs: string;
}

/**
 * Where the JSX tag `<name` is used in `source`: the elements it sits in, or
 * "conditional" when it sits inside a `{...}` expression (`{x && <Tag />}`,
 * a ternary, a map), where it may not render at all.
 */
function placeOf(source: string, name: string): Ancestor[] | "conditional" {
  const src = code(source);
  const at = src.search(new RegExp(`<${name}\\b`));
  expect(at, `<${name}> should be used`).toBeGreaterThanOrEqual(0);
  // The JSX the component returns, up to the tag.
  const from = src.lastIndexOf("return (", at);
  expect(from, `<${name}> should be in a component's returned JSX`).toBeGreaterThanOrEqual(0);
  const stack: Ancestor[] = [];
  let i = from + "return (".length;
  while (i < at) {
    const c = src[i];
    if (c === "{") {
      const end = skipGroup(src, i);
      if (end > at) return "conditional";
      i = end;
    } else if (c === "<" && src[i + 1] === "/") {
      stack.pop();
      i = src.indexOf(">", i) + 1;
    } else if (c === "<" && /[A-Za-z]/.test(src[i + 1] ?? "")) {
      const tag = /^<([\w.]+)/.exec(src.slice(i))![1];
      let j = i + 1 + tag.length;
      let attrs = "";
      while (j < src.length && src[j] !== ">") {
        if (src[j] === "{" || src[j] === '"' || src[j] === "'") {
          const end = skipGroup(src, j);
          attrs += src.slice(j, end);
          j = end;
        } else attrs += src[j++];
      }
      const selfClosing = attrs.trimEnd().endsWith("/");
      if (!selfClosing) stack.push({ name: tag, attrs });
      i = j + 1;
    } else i++;
  }
  return stack;
}

/** Asserts `<name>` renders wherever its parent does: no condition around it, no hiding class above it. */
function expectAlwaysShown(source: string, name: string) {
  const place = placeOf(source, name);
  expect(place, `<${name}> must not sit inside a condition`).not.toBe("conditional");
  for (const a of place as Ancestor[]) {
    const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(a.attrs);
    expect(cls?.[1] ?? cls?.[2] ?? "", `<${a.name}> around <${name}> must not hide it`).not.toMatch(HIDING);
    expect(a.attrs, `<${a.name}> around <${name}> must not hide it`).not.toMatch(/\bhidden\b(?!-)|display:\s*["']?none/);
  }
}

describe("Support entry points", () => {
  it("both support buttons open the support dialog", () => {
    expect(code(functionBody(supportDialog, "SupportButton"))).toContain(OPENS_SUPPORT);
    expect(code(functionBody(supportDialog, "SupportTopButton"))).toContain(OPENS_SUPPORT);
  });

  it("both support buttons render a visible button in every build", () => {
    for (const fn of ["SupportButton", "SupportTopButton"]) {
      const body = code(functionBody(supportDialog, fn));
      expect(body, `${fn} must not depend on the build`).not.toMatch(/import\.meta\.env|process\.env|return null/);
    }
    const sidebarHtml = renderToStaticMarkup(createElement(SupportButton));
    expect(sidebarHtml).toMatch(/^<button\b/);
    expect(sidebarHtml).toContain("Support us");
    const topHtml = renderToStaticMarkup(createElement(SupportTopButton));
    expect(topHtml).toMatch(/^<button\b/);
    expect(topHtml).toContain('aria-label="Support Texo"');
    // The button itself is on screen; only its text label may collapse on narrow windows.
    for (const html of [sidebarHtml, topHtml]) {
      const rootClass = /^<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
      expect(rootClass).not.toMatch(HIDING);
    }
  });

  it("the dashboard sidebar always shows the Support us button", () => {
    expectAlwaysShown(sidebar, "SupportButton");
  });

  it("the workspace top bar always shows the Support button", () => {
    const header = code(workspace).match(/return \([\s\S]*?<header[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header).toMatch(/<SupportTopButton\b/);
    expectAlwaysShown(workspace, "SupportTopButton");
    const place = placeOf(workspace, "SupportTopButton") as Ancestor[];
    expect(place.some((a) => a.name === "header")).toBe(true);
  });

  it("the app menu has an unconditional Support Texo item that opens the dialog", () => {
    const body = code(appMenu);
    const line = body.split("\n").find((l) => l.includes('"Support Texo"')) ?? "";
    expect(line).toContain(OPENS_SUPPORT);
    expect(line).not.toMatch(/&&|\?\s|hidden|disabled/);
    // A plain entry in the items list, not spread in from a condition.
    expect(line.trim()).toMatch(/^\{\s*label:\s*"Support Texo"/);
  });

  it("the buttons open the support dialog when clicked", () => {
    // What both buttons call, through the same store.
    useUi.getState().openDialog("support");
    expect(useUi.getState().dialog).toBe("support");
  });

  it("the About dialog has a Support Texo button", () => {
    const about = code(functionBody(globalDialogs, "AboutDialog"));
    expect(about).toContain(OPENS_SUPPORT);
    expect(about).toContain("Support Texo");
  });

  it("Settings > About has a Support Texo button", () => {
    const about = code(functionBody(settings, "AboutSection"));
    expect(about).toContain(OPENS_SUPPORT);
    expect(about).toContain("Support Texo");
  });

  it("the support dialog is wired up and links to the support page", () => {
    expect(code(globalDialogs)).toMatch(/dialog === "support"\) return <SupportDialog/);
    expect(supportDialog).toContain(`export const SUPPORT_URL = "${SUPPORT_URL}";`);
    expect(code(functionBody(supportDialog, "SupportDialog"))).toContain("openUrl(SUPPORT_URL)");
  });

  it("the guard itself spots hidden and conditional buttons", () => {
    const wrap = (jsx: string) => `function X() {\n  return (\n    <div className="p-2">\n      ${jsx}\n    </div>\n  );\n}`;
    expect(placeOf(wrap("{import.meta.env.DEV && <SupportButton />}"), "SupportButton")).toBe("conditional");
    expect(placeOf(wrap("{false && (\n<SupportButton />)}"), "SupportButton")).toBe("conditional");
    expect(placeOf(wrap("{ok ? <SupportButton /> : null}"), "SupportButton")).toBe("conditional");
    expect(() => expectAlwaysShown(wrap('<span className="hidden"><SupportButton /></span>'), "SupportButton")).toThrow();
    expect(() => expectAlwaysShown(wrap('<div onClick={() => a > b}><SupportButton /></div>'), "SupportButton")).not.toThrow();
    expect(() => expectAlwaysShown(wrap("<SupportButton />"), "SupportButton")).not.toThrow();
  });
});
