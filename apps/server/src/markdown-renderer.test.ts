import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { marked } from "marked";
import hljs from "highlight.js";

function loadRenderer(): { renderMarkdownMessage: (value: string) => string } {
  const source = readFileSync(join(process.cwd(), "public", "markdown-renderer.js"), "utf8");
  const context = vm.createContext({ URL, globalThis: { marked, hljs, URL } });
  vm.runInContext(source, context);
  return (context.globalThis as { DigitalAgentMarkdown: { renderMarkdownMessage: (value: string) => string } }).DigitalAgentMarkdown;
}

describe("renderMarkdownMessage", () => {
  it("renders common markdown safely with highlighted code blocks", () => {
    const { renderMarkdownMessage } = loadRenderer();
    const html = renderMarkdownMessage([
      "# Plan",
      "",
      "- Ship Markdown",
      "- Keep <script>alert(1)</script> escaped",
      "",
      "[Docs](https://example.com/docs)",
      "",
      "![Chart](https://example.com/chart.png)",
      "",
      "```ts",
      "const answer: number = 42;",
      "```",
    ].join("\n"));

    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain("<li>Ship Markdown</li>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<a href="https://example.com/docs"');
    expect(html).toContain('<img src="https://example.com/chart.png" alt="Chart"');
    expect(html).toContain('<pre><code class="hljs language-ts">');
    expect(html).toContain("hljs-keyword");
  });
});
