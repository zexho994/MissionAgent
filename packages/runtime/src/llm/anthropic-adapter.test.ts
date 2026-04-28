import { describe, expect, it } from "vitest";
import { AnthropicLlmAdapter } from "./anthropic-adapter.js";

describe("AnthropicLlmAdapter", () => {
  it("calls the native Anthropic Messages API", async () => {
    let capturedUrl: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const adapter = new AnthropicLlmAdapter({
      apiKey: "test-key",
      defaultModel: "claude-test",
      fetch: async (input, init) => {
        capturedUrl = input;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ type: "text", text: "Hello from Claude" }],
            model: "claude-test",
            usage: { input_tokens: 7, output_tokens: 8 },
            stop_reason: "end_turn",
          }),
          text: async () => "",
        } as Response;
      },
    });

    const response = await adapter.call([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Say hello" },
    ]);

    expect(String(capturedUrl)).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedInit?.headers).toHaveProperty("x-api-key", "test-key");
    expect(capturedInit?.headers).toHaveProperty("anthropic-version", "2023-06-01");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      model: "claude-test",
      max_tokens: 1024,
      system: "Be concise.",
      messages: [{ role: "user", content: "Say hello" }],
    });
    expect(response).toMatchObject({
      content: "Hello from Claude",
      model: "claude-test",
      usage: { promptTokens: 7, completionTokens: 8, totalTokens: 15 },
      finishReason: "end_turn",
    });
  });

  it("fast-fails when multiple system messages are provided", async () => {
    const adapter = new AnthropicLlmAdapter({
      apiKey: "test-key",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    await expect(
      adapter.call([
        { role: "system", content: "one" },
        { role: "system", content: "two" },
        { role: "user", content: "hello" },
      ]),
    ).rejects.toThrow("only supports one system message");
  });

  it("streams Anthropic content deltas", async () => {
    const encoder = new TextEncoder();
    const adapter = new AnthropicLlmAdapter({
      apiKey: "test-key",
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n'));
              controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n'));
              controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'));
              controller.close();
            },
          }),
          text: async () => "",
        }) as Response,
    });
    const tokens: string[] = [];

    const response = await adapter.call([{ role: "user", content: "hello" }], {
      onStream: (token) => tokens.push(token),
    });

    expect(tokens).toEqual(["Hel", "lo"]);
    expect(response).toMatchObject({
      content: "Hello",
      finishReason: "end_turn",
      usage: { promptTokens: 0, completionTokens: 2, totalTokens: 2 },
    });
  });
});
