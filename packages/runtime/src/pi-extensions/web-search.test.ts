import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { searchWeb, createWebSearchTool } from "./web-search.js";

describe("searchWeb", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.WEB_SEARCH_API_KEY;
    delete process.env.WEB_SEARCH_BACKEND_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns parsed Brave-shaped results when fetch resolves successfully", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [
            { url: "https://example.com/a", title: "A", description: "About A" },
            { url: "https://example.com/b", title: "B", description: "About B" },
          ],
        },
      }),
    } as unknown as Response);

    const result = await searchWeb({
      query: "test",
      fetch: fetchMock,
      apiKey: "test-key",
    });

    expect(result.results).toEqual([
      { url: "https://example.com/a", title: "A", snippet: "About A" },
      { url: "https://example.com/b", title: "B", snippet: "About B" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("q=test");
    expect((init as RequestInit).headers).toMatchObject({
      "X-Subscription-Token": "test-key",
      Accept: "application/json",
    });
  });

  it("returns empty results array when API responds with empty results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    } as unknown as Response);

    const result = await searchWeb({ query: "x", fetch: fetchMock, apiKey: "k" });
    expect(result.results).toEqual([]);
  });

  it("returns empty results when web key is missing in response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const result = await searchWeb({ query: "x", fetch: fetchMock, apiKey: "k" });
    expect(result.results).toEqual([]);
  });

  it("throws when backend returns 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    } as unknown as Response);

    await expect(
      searchWeb({ query: "x", fetch: fetchMock, apiKey: "k" }),
    ).rejects.toThrow(/503|Service Unavailable/);
  });

  it("returns empty results without calling fetch when apiKey is missing", async () => {
    const fetchMock = vi.fn();
    const result = await searchWeb({ query: "x", fetch: fetchMock });
    expect(result.results).toEqual([]);
    expect(result.note).toMatch(/api key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses overridden endpoint URL when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    } as unknown as Response);

    await searchWeb({
      query: "x",
      fetch: fetchMock,
      apiKey: "k",
      endpoint: "https://custom.example.com/search",
    });

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/custom\.example\.com\/search/);
  });

  it("reads apiKey and endpoint from env when not passed explicitly", async () => {
    process.env.WEB_SEARCH_API_KEY = "env-key";
    process.env.WEB_SEARCH_BACKEND_URL = "https://env.example.com/search";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    } as unknown as Response);

    await searchWeb({ query: "x", fetch: fetchMock });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/env\.example\.com\/search/);
    expect((init as RequestInit).headers).toMatchObject({
      "X-Subscription-Token": "env-key",
    });
  });
});

describe("createWebSearchTool", () => {
  it("returns an AgentTool with web_search shape", () => {
    const tool = createWebSearchTool({ apiKey: "k", endpoint: "https://api.test" });
    expect(tool.name).toBe("web_search");
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("execute calls searchWeb with toolOptions overrides and returns details with sources", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [{ url: "https://x.example", title: "X", description: "snip-x" }],
        },
      }),
    } as unknown as Response);

    const tool = createWebSearchTool({
      apiKey: "k",
      endpoint: "https://api.test",
      fetch: fetchMock,
    });

    const result = await tool.execute({
      args: { query: "hello" },
    } as Parameters<typeof tool.execute>[0]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("q=hello");
    expect((init as RequestInit).headers).toMatchObject({ "X-Subscription-Token": "k" });

    expect(result.details).toMatchObject({
      searchKeyword: "hello",
      sources: [{ url: "https://x.example", title: "X", snippet: "snip-x" }],
    });
  });
});
