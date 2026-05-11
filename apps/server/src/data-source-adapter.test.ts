import { describe, expect, it } from "vitest";
import {
  DataSourceAdapterRegistry,
  HttpDataSourceAdapter,
  type DataSourceAdapter,
} from "./data-source-adapter.js";

describe("DataSourceAdapterRegistry", () => {
  it("returns registered adapter by type", () => {
    const stub: DataSourceAdapter = {
      async fetch() {
        return { ok: true, data: { hello: "world" }, attemptCount: 1 };
      },
    };
    const reg = new DataSourceAdapterRegistry();
    reg.register("stub", stub);
    expect(reg.get("stub")).toBe(stub);
  });

  it("throws when unknown type requested", () => {
    const reg = new DataSourceAdapterRegistry();
    expect(() => reg.get("unknown")).toThrow(/no adapter/i);
  });

  it("has() returns false for unregistered types", () => {
    const reg = new DataSourceAdapterRegistry();
    expect(reg.has("stub")).toBe(false);
  });
});

describe("HttpDataSourceAdapter", () => {
  it("fetches via injected fetch and returns parsed JSON", async () => {
    let called: { url: string; init?: RequestInit | undefined } | undefined;
    const fakeFetch = async (url: string, init?: RequestInit) => {
      called = { url, init };
      return new Response(JSON.stringify({ rows: [1, 2, 3] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new HttpDataSourceAdapter({ fetch: fakeFetch });
    const result = await adapter.fetch({ url: "https://x/api", method: "GET" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ rows: [1, 2, 3] });
    expect(called?.url).toBe("https://x/api");
    expect(called?.init?.method).toBe("GET");
  });

  it("returns error on non-2xx", async () => {
    const fakeFetch = async () => new Response("nope", { status: 503 });
    const adapter = new HttpDataSourceAdapter({
      fetch: fakeFetch,
      sleep: async () => undefined,
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    });
    const result = await adapter.fetch({ url: "https://x/api", method: "GET" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/503/);
  });

  it("returns error when fetch throws", async () => {
    const fakeFetch = async () => {
      throw new Error("network down");
    };
    const adapter = new HttpDataSourceAdapter({
      fetch: fakeFetch,
      sleep: async () => undefined,
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    });
    const result = await adapter.fetch({ url: "https://x", method: "GET" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("network down");
  });

  it("returns error when url is missing", async () => {
    const adapter = new HttpDataSourceAdapter({ fetch: async () => new Response() });
    const result = await adapter.fetch({ method: "GET" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/url/i);
  });

  it("forwards headers and body for POST", async () => {
    let captured: { init?: RequestInit | undefined } | undefined;
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      captured = { init };
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const adapter = new HttpDataSourceAdapter({ fetch: fakeFetch });
    await adapter.fetch({
      url: "https://x",
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: '{"q":"test"}',
    });
    expect(captured?.init?.method).toBe("POST");
    expect(captured?.init?.body).toBe('{"q":"test"}');
    const headers = captured?.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer token");
  });

  it("retries on transient failure and succeeds on a later attempt", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls < 3) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new HttpDataSourceAdapter({
      fetch: fakeFetch,
      sleep: async () => undefined,
      retry: { maxAttempts: 3, initialDelayMs: 1 },
    });
    const result = await adapter.fetch({ url: "https://x", method: "GET" });
    expect(result.ok).toBe(true);
    expect(result.attemptCount).toBe(3);
  });

  it("returns failure with attemptCount=maxAttempts when all attempts fail", async () => {
    const fakeFetch = async () => new Response("err", { status: 500 });
    const adapter = new HttpDataSourceAdapter({
      fetch: fakeFetch,
      sleep: async () => undefined,
      retry: { maxAttempts: 3, initialDelayMs: 1 },
    });
    const result = await adapter.fetch({ url: "https://x", method: "GET" });
    expect(result.ok).toBe(false);
    expect(result.attemptCount).toBe(3);
  });

  it("uses exponential backoff between attempts", async () => {
    const sleeps: number[] = [];
    const fakeFetch = async () => new Response("err", { status: 500 });
    const adapter = new HttpDataSourceAdapter({
      fetch: fakeFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retry: { maxAttempts: 4, initialDelayMs: 100 },
    });
    await adapter.fetch({ url: "https://x", method: "GET" });
    expect(sleeps).toEqual([100, 200, 400]);
  });
});
