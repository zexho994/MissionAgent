/**
 * Web search pi extension.
 *
 * Two exports:
 * - `searchWeb`: pure function (tested) that calls a Brave-shaped JSON web search API.
 * - default: pi extension factory that registers a `web_search` tool wrapping `searchWeb`.
 *
 * Backend is configured via:
 * - `WEB_SEARCH_API_KEY` env var (or `apiKey` option) — required; without it the tool returns empty results.
 * - `WEB_SEARCH_BACKEND_URL` env var (or `endpoint` option) — defaults to Brave Search.
 *
 * The pi extension default export is untyped (`pi: any`) because the project does not
 * depend on `@earendil-works/pi-coding-agent`. Pi loads the extension via jiti at runtime;
 * types are not required for execution.
 */

const DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface SearchResult {
  url: string;
  title?: string;
  snippet?: string;
}

export interface SearchOptions {
  query: string;
  fetch?: typeof fetch;
  apiKey?: string;
  endpoint?: string;
  count?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  raw?: unknown;
  note?: string;
}

export async function searchWeb(options: SearchOptions): Promise<SearchResponse> {
  const apiKey = options.apiKey ?? process.env.WEB_SEARCH_API_KEY;
  if (!apiKey) {
    return {
      results: [],
      note: "Web search disabled: missing API key (set WEB_SEARCH_API_KEY)",
    };
  }

  const endpoint = options.endpoint ?? process.env.WEB_SEARCH_BACKEND_URL ?? DEFAULT_ENDPOINT;
  const url = new URL(endpoint);
  url.searchParams.set("q", options.query);
  if (options.count) {
    url.searchParams.set("count", String(options.count));
  }

  const fetchFn = options.fetch ?? fetch;
  const response = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Web search request failed: ${response.status} ${response.statusText || ""}`.trim(),
    );
  }

  const payload = (await response.json()) as {
    web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
  };
  const rawResults = payload?.web?.results ?? [];

  const results: SearchResult[] = [];
  for (const item of rawResults) {
    if (!item || typeof item.url !== "string") {
      continue;
    }
    const result: SearchResult = { url: item.url };
    if (typeof item.title === "string") result.title = item.title;
    if (typeof item.description === "string") result.snippet = item.description;
    results.push(result);
  }

  return { results, raw: payload };
}

const WEB_SEARCH_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query string",
    },
    count: {
      type: "number",
      description: "Maximum results to return (optional)",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function webSearchExtension(pi: any) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web. Returns a JSON list of {url, title, snippet}. Sources are also exposed via tool result details.",
    parameters: WEB_SEARCH_TOOL_PARAMETERS,
    async execute(_toolCallId: string, params: { query: string; count?: number }) {
      const opts: SearchOptions = { query: params.query };
      if (params.count !== undefined) opts.count = params.count;
      const search = await searchWeb(opts);
      const text =
        search.results.length === 0
          ? search.note ?? "No results found."
          : JSON.stringify(search.results, null, 2);
      return {
        content: [{ type: "text", text }],
        details: {
          searchResults: search.results,
          sources: search.results,
          searchKeyword: params.query,
        },
      };
    },
  });
}
