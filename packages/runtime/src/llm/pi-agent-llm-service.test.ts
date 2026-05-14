import { describe, expect, it, vi } from "vitest";
import { createPiAgentLlmService } from "./pi-agent-llm-service.js";

describe("createPiAgentLlmService", () => {
  it("runs pi-agent with system prompt, prior messages, latest prompt, and tools", async () => {
    const tool = {
      name: "load_skill",
      label: "Load Skill",
      description: "Load a skill",
      parameters: {} as never,
      execute: vi.fn(),
    };
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "{\"status\":\"ready\"}" }] },
        ],
      },
    };
    const agentFactory = vi.fn().mockReturnValue(fakeAgent);
    const llm = createPiAgentLlmService({
      apiKey: "k",
      modelProvider: "minimax-cn",
      modelId: "MiniMax-M2.7-highspeed",
      tools: [tool],
      agentFactory: agentFactory as never,
    });

    const response = await llm.call([
      { role: "system", content: "system-a" },
      { role: "system", content: "system-b" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "latest" },
    ]);

    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          systemPrompt: "system-a\n\nsystem-b",
          tools: [tool],
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
          ],
        }),
      }),
    );
    expect(fakeAgent.prompt).toHaveBeenCalledWith("latest");
    expect(response.content).toBe("{\"status\":\"ready\"}");
    expect(response.finishReason).toBe("stop");
  });

  it("streams final content through onStream when token events are unavailable", async () => {
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
      },
    };
    const onStream = vi.fn();
    const llm = createPiAgentLlmService({
      apiKey: "k",
      tools: [],
      agentFactory: (() => fakeAgent) as never,
    });

    await llm.call([{ role: "user", content: "say hello" }], { onStream });

    expect(onStream).toHaveBeenCalledWith("hello");
  });

  it("uses final state messages for response.content, not accumulated deltas", async () => {
    let handler: ((event: Record<string, unknown>) => void) | undefined;
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined).mockImplementation(() => {
        handler?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "intermediate text - " } });
        handler?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "more intermediate" } });
        return Promise.resolve();
      }),
      subscribe: vi.fn().mockImplementation((h: (event: Record<string, unknown>) => void) => {
        handler = h;
      }),
      state: {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "intermediate text - more intermediate" }] },
          { role: "assistant", content: [{ type: "text", text: "{\"status\":\"ready\"}" }] },
        ],
      },
    };
    const onStream = vi.fn();
    const llm = createPiAgentLlmService({
      apiKey: "k",
      tools: [],
      agentFactory: (() => fakeAgent) as never,
    });

    const response = await llm.call([{ role: "user", content: "x" }], { onStream });

    expect(response.content).toBe("{\"status\":\"ready\"}");
    expect(onStream).toHaveBeenCalledWith("intermediate text - ");
    expect(onStream).toHaveBeenCalledWith("more intermediate");
  });

  it("fails fast when no user prompt exists", async () => {
    const llm = createPiAgentLlmService({ apiKey: "k", tools: [] });

    await expect(llm.call([{ role: "system", content: "system" }]))
      .rejects.toThrow("PiAgentLlmService requires a user message");
  });

  it("fails fast when pi-agent returns no assistant text", async () => {
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: { messages: [] },
    };
    const llm = createPiAgentLlmService({
      apiKey: "k",
      tools: [],
      agentFactory: (() => fakeAgent) as never,
    });

    await expect(llm.call([{ role: "user", content: "x" }]))
      .rejects.toThrow("PiAgentLlmService returned no assistant content");
  });
});