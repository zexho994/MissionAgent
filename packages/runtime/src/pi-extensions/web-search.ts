/**
 * Web search pi extension (pi-agent-core AgentTool shape).
 *
 * Two exports:
 * - `searchWeb`: pure function that calls a Brave-shaped JSON web search API.
 * - `createWebSearchTool`: factory that returns an `AgentTool` consumed by the pi-agent-core Agent.
 *
 * Backend is configured via:
 * - `WEB_SEARCH_API_KEY` env var (or `apiKey` option) — required; without it the tool returns empty results.
 * - `WEB_SEARCH_BACKEND_URL` env var (or `endpoint` option) — defaults to Brave Search.
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

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

export interface WebSearchToolOptions {
  apiKey?: string;
  endpoint?: string;
  fetch?: typeof fetch;
}

const WebSearchParameters = Type.Object({
  query: Type.String({ description: "Search query string" }),
  count: Type.Optional(
    Type.Number({ description: "Maximum results to return (optional)" }),
  ),
});

export function createWebSearchTool(
  toolOptions: WebSearchToolOptions = {},
): AgentTool<typeof WebSearchParameters> {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web. Returns a JSON list of {url, title, snippet}. Sources are also exposed via tool result details.",
    parameters: WebSearchParameters,
    async execute(_toolCallId, params) {
      const opts: SearchOptions = { query: params.query };
      if (params.count !== undefined) opts.count = params.count;
      if (toolOptions.apiKey !== undefined) opts.apiKey = toolOptions.apiKey;
      if (toolOptions.endpoint !== undefined) opts.endpoint = toolOptions.endpoint;
      if (toolOptions.fetch !== undefined) opts.fetch = toolOptions.fetch;
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
  };
}
