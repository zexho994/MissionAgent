import { describe, expect, it, vi } from "vitest";
import { createLlmService, createLlmServiceFromEnv } from "./index.js";

function fakeCompleteResponse(text: string, modelId = "test-model") {
  return {
    content: [{ type: "text", text }],
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
    stopReason: "end_turn",
    model: { id: modelId, name: modelId },
  };
}

describe("createLlmService", () => {
  it("uses the configured pi-ai provider directly", async () => {
    const completeMock = vi
      .fn()
      .mockResolvedValue(fakeCompleteResponse("ok", "MiniMax-M2.7-highspeed"));
    const llm = createLlmService({
      provider: "minimax-cn",
      apiKey: "minimax-key",
      completeFn: completeMock,
    });
    await llm.call([{ role: "user", content: "hello" }]);
    const [model, , options] = completeMock.mock.calls[0]!;
    expect(model.id).toBe("MiniMax-M2.7-highspeed");
    expect(model.provider).toBe("minimax-cn");
    expect(model.baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(model.api).toBe("anthropic-messages");
    expect(options).toMatchObject({ apiKey: "minimax-key" });
  });

  it("fast-fails when API key is missing", () => {
    expect(() =>
      createLlmService({
        provider: "openai",
        apiKey: "",
      }),
    ).toThrow("LLM API key is required");
  });

  it("throws when pi-ai returns an error stop reason", async () => {
    const completeMock = vi.fn().mockResolvedValue({
      content: [],
      usage: { input: 0, output: 0, totalTokens: 0 },
      stopReason: "error",
      errorMessage: "assistantMsg.content.flatMap is not a function",
      model: { id: "MiniMax-M2.7-highspeed", name: "MiniMax" },
    });
    const llm = createLlmService({
      provider: "minimax-cn",
      apiKey: "minimax-key",
      completeFn: completeMock,
    });

    await expect(llm.call([{ role: "user", content: "hello" }])).rejects.toThrow(
      "assistantMsg.content.flatMap is not a function",
    );
    await expect(llm.call([{ role: "user", content: "hello" }])).rejects.toThrow(
      "provider=minimax-cn",
    );
  });
});

describe("createLlmServiceFromEnv", () => {
  it("fast-fails when provider is configured without an API key", () => {
    expect(() =>
      createLlmServiceFromEnv({ LLM_PROVIDER: "openai" }),
    ).toThrow("LLM API key is required");
  });

  it("uses env provider, base URL, and model", async () => {
    const completeMock = vi
      .fn()
      .mockResolvedValue(fakeCompleteResponse("ok", "custom-model"));
    const llm = createLlmServiceFromEnv(
      {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "openai-key",
        LLM_BASE_URL: "https://compatible.example/v1",
        LLM_MODEL: "custom-model",
      },
      { completeFn: completeMock },
    );
    await llm.call([{ role: "user", content: "hello" }]);
    const [model, , options] = completeMock.mock.calls[0]!;
    expect(model.id).toBe("custom-model");
    expect(model.baseUrl).toBe("https://compatible.example/v1");
    expect(options).toMatchObject({ apiKey: "openai-key" });
  });
});

describe("createLlmService (pi-ai backed)", () => {
  it("converts LlmMessage[] to pi-ai Context, calls complete(), maps response", async () => {
    const completeMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Hello back" }],
      usage: {
        input: 12,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
      stopReason: "end_turn",
      model: { id: "claude-3-5-haiku-latest", name: "Claude Haiku" },
    });

    const service = createLlmService({
      provider: "anthropic",
      apiKey: "sk-test",
      model: "claude-3-5-haiku-latest",
      completeFn: completeMock,
    });

    const response = await service.call(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Say hi" },
      ],
      { maxTokens: 64 },
    );

    expect(completeMock).toHaveBeenCalledTimes(1);
    const [model, context, options] = completeMock.mock.calls[0]!;
    expect(model.id).toBe("claude-3-5-haiku-latest");
    expect(context.systemPrompt).toBe("You are helpful.");
    expect(context.messages).toEqual([{ role: "user", content: "Say hi" }]);
    expect(options).toMatchObject({ apiKey: "sk-test", maxTokens: 64 });

    expect(response).toMatchObject({
      content: "Hello back",
      model: "claude-3-5-haiku-latest",
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      finishReason: "end_turn",
    });
  });

  it("serializes assistant history as text content blocks for pi-ai", async () => {
    const completeMock = vi.fn().mockResolvedValue(fakeCompleteResponse("ok"));
    const service = createLlmService({
      provider: "minimax-cn",
      apiKey: "sk-test",
      completeFn: completeMock,
    });

    await service.call([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi, how can I help?" },
      { role: "user", content: "Tell me a joke" },
    ]);

    const [, context] = completeMock.mock.calls[0]!;
    expect(context.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi, how can I help?" }] },
      { role: "user", content: "Tell me a joke" },
    ]);
  });
});
