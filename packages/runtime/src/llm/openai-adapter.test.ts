import { describe, expect, it } from "vitest";
import { OpenAiLlmAdapter } from "./openai-adapter.js";

function mockFetch(responses: Array<{ ok: boolean; body: unknown }>): typeof fetch {
  let index = 0;
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const mock = responses[index++] ?? responses.at(-1);
    if (!mock) throw new Error("no mock response");
    return {
      ok: mock.ok,
      status: mock.ok ? 200 : 500,
      json: async () => mock.body,
      text: async () => JSON.stringify(mock.body),
    } as Response;
  };
}

function successResponse(content: string) {
  return {
    ok: true,
    body: {
      choices: [{ message: { content }, finish_reason: "stop" }],
      model: "test-model",
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
  };
}

describe("OpenAiLlmAdapter", () => {
  it("calls the OpenAI-compatible endpoint and returns parsed response", async () => {
    const adapter = new OpenAiLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.test.com/v1",
      fetch: mockFetch([successResponse("Hello from LLM")]),
    });

    const response = await adapter.call([
      { role: "user", content: "Say hello" },
    ]);

    expect(response.content).toBe("Hello from LLM");
    expect(response.model).toBe("test-model");
    expect(response.usage.totalTokens).toBe(30);
  });

  it("tracks call stats", async () => {
    const adapter = new OpenAiLlmAdapter({
      apiKey: "test-key",
      fetch: mockFetch([
        successResponse("first"),
        successResponse("second"),
      ]),
    });

    await adapter.call([{ role: "user", content: "one" }]);
    await adapter.call([{ role: "user", content: "two" }]);

    const stats = adapter.stats();
    expect(stats.totalCalls).toBe(2);
    expect(stats.totalPromptTokens).toBe(20);
    expect(stats.totalCompletionTokens).toBe(40);
  });

  it("retries on transient errors and succeeds", async () => {
    const adapter = new OpenAiLlmAdapter({
      apiKey: "test-key",
      maxRetries: 2,
      fetch: mockFetch([
        { ok: false, body: { error: "timeout" } },
        successResponse("recovered"),
      ]),
    });

    const response = await adapter.call([
      { role: "user", content: "retry test" },
    ]);

    expect(response.content).toBe("recovered");
  });

  it("throws after exhausting retries", async () => {
    const adapter = new OpenAiLlmAdapter({
      apiKey: "test-key",
      maxRetries: 1,
      fetch: mockFetch([
        { ok: false, body: "permanent error" },
        { ok: false, body: "still failing" },
      ]),
    });

    await expect(
      adapter.call([{ role: "user", content: "fail test" }]),
    ).rejects.toThrow("LLM API error");
  });

  it("throws timeout error when abort fires", async () => {
    const adapter = new OpenAiLlmAdapter({
      apiKey: "test-key",
      timeoutMs: 1,
      fetch: async (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new DOMException("Aborted", "AbortError");
            reject(error);
          });
        }),
    });

    await expect(
      adapter.call([{ role: "user", content: "timeout test" }]),
    ).rejects.toThrow("timed out");
  });

  it("sends request with correct headers and body", async () => {
    let capturedInit: RequestInit | undefined;
    const adapter = new OpenAiLlmAdapter({
      apiKey: "my-api-key",
      baseUrl: "https://api.test.com/v1",
      defaultModel: "gpt-4",
      fetch: async (_input, init) => {
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => successResponse("ok").body,
          text: async () => "",
        } as Response;
      },
    });

    await adapter.call([{ role: "user", content: "test" }]);

    expect(capturedInit?.headers).toHaveProperty("authorization", "Bearer my-api-key");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe("gpt-4");
    expect(body.messages).toEqual([{ role: "user", content: "test" }]);
  });
});
