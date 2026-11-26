import { describe, expect, it } from "vitest";
import { isOpenableLink, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("never passes raw HTML through", () => {
    const { html } = renderMarkdown('Hi <img src=x onerror="alert(1)"> <script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops javascript: links and remote pictures", () => {
    expect(renderMarkdown("[x](javascript:alert(1))").html).not.toContain("href=\"javascript");
    expect(renderMarkdown("![p](https://example.com/a.png)").html).not.toContain("<img");
    expect(renderMarkdown("[doc](https://example.com)").html).toContain('href="https://example.com"');
  });

  it("renders maths with KaTeX", () => {
    const inline = renderMarkdown("Energy $E=mc^2$ here").html;
    expect(inline).toContain("katex");
    const block = renderMarkdown("$$\n\\int_0^1 x\\,dx\n$$").html;
    expect(block).toContain("chat-math-display");
    expect(renderMarkdown("\\(a+b\\) and \\[c\\]").html.match(/class="katex"/g)?.length).toBe(2);
  });

  it("leaves prices and unclosed dollars alone", () => {
    const { html } = renderMarkdown("It costs $5 and $6 now, $ alone");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5 and $6");
  });

  it("shows bad maths as code instead of failing", () => {
    expect(renderMarkdown("$\\frac{$").html).not.toContain("katex-error");
    expect(renderMarkdown("$\\notacommand{x}$").html).toMatch(/chat-math-error|katex/);
  });

  it("gives code blocks Insert and Copy buttons by index", () => {
    const { html, codes } = renderMarkdown("```latex\n\\section{A}\n<b>x</b>\n```\n\n    indented\n");
    expect(codes).toEqual(["\\section{A}\n<b>x</b>", "indented"]);
    expect(html).toContain('data-code-action="insert" data-code-index="0"');
    expect(html).toContain('data-code-action="copy" data-code-index="1"');
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("chat-code-lang");
  });

  it("does not treat maths inside code as maths", () => {
    const { html, codes } = renderMarkdown("`$x$` and\n\n```\n$$y$$\n```");
    expect(html).not.toContain("katex");
    expect(codes).toEqual(["$$y$$"]);
  });
});

describe("isOpenableLink", () => {
  it("allows web links only", () => {
    expect(isOpenableLink("https://arxiv.org/abs/1")).toBe(true);
    expect(isOpenableLink("file:///C:/x")).toBe(false);
    expect(isOpenableLink(null)).toBe(false);
  });
});
