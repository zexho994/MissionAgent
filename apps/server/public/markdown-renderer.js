(function (global) {
  function dependency(name, value) {
    if (!value) {
      throw new Error(`Markdown renderer dependency missing: ${name}`);
    }
    return value;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replaceAll("'", "&#39;");
  }

  function safeUrl(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    if (text.startsWith("#") || text.startsWith("/") || text.startsWith("./") || text.startsWith("../")) return text;
    const url = new URL(text, "https://digitalagent.local");
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return text;
    throw new Error(`Unsafe Markdown URL protocol: ${url.protocol}`);
  }

  function renderMarkdownMessage(value) {
    const markedApi = dependency("marked", global.marked?.marked ? global.marked : global.marked);
    const hljs = dependency("highlight.js", global.hljs);
    const renderer = new markedApi.Renderer();

    renderer.html = ({ text }) => escapeHtml(text);
    renderer.link = function ({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens || []);
      const safeHref = safeUrl(href);
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
      return `<a href="${escapeAttribute(safeHref)}"${titleAttr} target="_blank" rel="noopener noreferrer">${label}</a>`;
    };
    renderer.image = ({ href, title, text }) => {
      const safeHref = safeUrl(href);
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
      return `<img src="${escapeAttribute(safeHref)}" alt="${escapeAttribute(text || "")}"${titleAttr} loading="lazy">`;
    };
    renderer.code = ({ text, lang }) => {
      const language = String(lang || "").trim().split(/\s+/)[0] || "plaintext";
      const highlighted = hljs.getLanguage(language)
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value;
      return `<pre><code class="hljs language-${escapeAttribute(language)}">${highlighted}</code></pre>`;
    };

    return markedApi.parse(String(value ?? ""), {
      async: false,
      breaks: true,
      gfm: true,
      renderer,
    });
  }

  global.DigitalAgentMarkdown = { renderMarkdownMessage };
})(globalThis);
