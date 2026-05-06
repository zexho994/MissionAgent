import { describe, expect, it } from "vitest";
import { createLlmService, createLlmServiceFromEnv } from "./index.js";

function successResponse(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    model: "test-model",
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
}

describe("createLlmService", () => {
  it("creates an OpenAI-compatible service for GLM with GLM defaults", async () => {
    let capturedUrl: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const llm = createLlmService({
      provider: "glm",
      apiKey: "glm-key",
      fetch: async (input, init) => {
        capturedUrl = input;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => successResponse("ok"),
          text: async () => "",
        } as Response;
      },
    });

    if (!llm) {
      throw new Error("expected LLM service");
    }
    await llm.call([{ role: "user", content: "hello" }]);

    expect(String(capturedUrl)).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(capturedInit?.headers).toHaveProperty("authorization", "Bearer glm-key");
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({ model: "glm-4-flash" });
  });

  it("creates an OpenAI-compatible service for MiniMax with MiniMax defaults", async () => {
    let capturedUrl: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const llm = createLlmService({
      provider: "minimax",
      apiKey: "minimax-key",
      fetch: async (input, init) => {
        capturedUrl = input;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => successResponse("ok"),
          text: async () => "",
        } as Response;
      },
    });

    await llm.call([{ role: "user", content: "hello" }]);

    expect(String(capturedUrl)).toBe("https://api.minimax.io/v1/chat/completions");
    expect(capturedInit?.headers).toHaveProperty("authorization", "Bearer minimax-key");
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({ model: "MiniMax-M2.7-highspeed" });
  });

  it("creates an Anthropic service for claude provider", async () => {
    let capturedUrl: RequestInfo | URL | undefined;
    const llm = createLlmService({
      provider: "claude",
      apiKey: "claude-key",
      fetch: async (input) => {
        capturedUrl = input;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ type: "text", text: "hello" }],
            model: "claude-3-5-haiku-latest",
            usage: { input_tokens: 4, output_tokens: 5 },
            stop_reason: "end_turn",
          }),
          text: async () => "",
        } as Response;
      },
    });

    const response = await llm.call([{ role: "user", content: "hello" }]);

    expect(String(capturedUrl)).toBe("https://api.anthropic.com/v1/messages");
    expect(response.content).toBe("hello");
  });

  it("fast-fails when provider is unknown", () => {
    expect(() =>
      createLlmService({
        provider: "local" as never,
        apiKey: "key",
      }),
    ).toThrow("Unsupported LLM provider");
  });
});

describe("createLlmServiceFromEnv", () => {
  it("fast-fails when provider is configured without an API key", () => {
    expect(() =>
      createLlmServiceFromEnv({
        LLM_PROVIDER: "openai",
      }),
    ).toThrow("LLM_API_KEY is required");
  });

  it("uses env provider, base URL, and model", async () => {
    let capturedUrl: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const llm = createLlmServiceFromEnv(
      {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "openai-key",
        LLM_BASE_URL: "https://compatible.example/v1",
        LLM_MODEL: "custom-model",
      },
      {
        fetch: async (input, init) => {
          capturedUrl = input;
          capturedInit = init;
          return {
            ok: true,
            status: 200,
            json: async () => successResponse("ok"),
            text: async () => "",
          } as Response;
        },
      },
    );

    if (!llm) {
      throw new Error("expected LLM service");
    }
    await llm.call([{ role: "user", content: "hello" }]);

    expect(String(capturedUrl)).toBe("https://compatible.example/v1/chat/completions");
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({ model: "custom-model" });
  });
});
