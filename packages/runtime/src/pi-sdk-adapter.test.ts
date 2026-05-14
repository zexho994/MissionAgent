import { describe, expect, it, vi } from "vitest";
import { PiSdkAdapter } from "./pi-sdk-adapter.js";

describe("PiSdkAdapter", () => {
  it("runs an agent task and returns completed status with the final state", async () => {
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: {
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        ],
      },
    };
    const agentFactory = vi.fn().mockReturnValue(fakeAgent);

    const adapter = new PiSdkAdapter({
      apiKey: "k",
      agentFactory: agentFactory as never,
    });

    const result = await adapter.runAgentTask({
      message: "do it",
      timeoutSeconds: 5,
      sessionId: "mission-123",
    });

    expect(fakeAgent.prompt).toHaveBeenCalledWith("do it");
    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "mission-123" }),
    );
    expect(result.status).toBe("completed");
    expect(result.output).toEqual(
      expect.objectContaining({ messages: expect.any(Array) }),
    );
    expect(result.sources).toEqual([]);
  });

  it("collects sources from tool_execution_end events for web_search", async () => {
    let captured: ((event: any) => void) | null = null;
    const fakeAgent = {
      prompt: vi.fn().mockImplementation(async () => {
        if (captured) {
          captured({
            type: "tool_execution_end",
            toolName: "web_search",
            result: {
              ok: true,
              details: {
                results: [
                  { url: "https://a.example", title: "A", snippet: "snip-a" },
                  { url: "https://b.example", title: "B" },
                ],
                searchKeyword: "hello",
              },
            },
          });
        }
      }),
      subscribe: vi.fn().mockImplementation((handler: any) => {
        captured = handler;
      }),
      state: { messages: [] },
    };

    const adapter = new PiSdkAdapter({
      apiKey: "k",
      agentFactory: (() => fakeAgent) as never,
    });

    const result = await adapter.runAgentTask({
      message: "search hello",
      timeoutSeconds: 5,
    });

    expect(result.sources).toEqual([
      { url: "https://a.example", title: "A", snippet: "snip-a", searchKeyword: "hello" },
      { url: "https://b.example", title: "B", searchKeyword: "hello" },
    ]);
  });

  it("uses the configured pi-ai provider directly for agent execution", async () => {
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: { messages: [] },
    };
    const agentFactory = vi.fn().mockReturnValue(fakeAgent);

    const adapter = new PiSdkAdapter({
      apiKey: "k",
      modelProvider: "minimax-cn",
      modelId: "MiniMax-M2.7-highspeed",
      agentFactory: agentFactory as never,
    });

    await adapter.runAgentTask({
      message: "do it",
      timeoutSeconds: 5,
    });

    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          model: expect.objectContaining({
            provider: "minimax-cn",
            baseUrl: "https://api.minimaxi.com/anthropic",
          }),
        }),
      }),
    );
  });

  it("returns failed status when prompt throws (exception isolation fence)", async () => {
    const fakeAgent = {
      prompt: vi.fn().mockRejectedValue(new Error("pi blew up")),
      subscribe: vi.fn(),
      state: { messages: [{ role: "user", content: "x" }] },
    };

    const adapter = new PiSdkAdapter({
      apiKey: "k",
      agentFactory: (() => fakeAgent) as never,
    });

    const result = await adapter.runAgentTask({
      message: "x",
      timeoutSeconds: 5,
    });

    expect(result).toMatchObject({
      status: "failed",
      stderr: "pi blew up",
      error: "pi blew up",
      output: { messages: [], error: "pi blew up" },
    });
  });

  it("returns failed status when prompt does not resolve in time", async () => {
    const fakeAgent = {
      prompt: vi.fn().mockImplementation(() => new Promise(() => {})),
      subscribe: vi.fn(),
      state: { messages: [] },
    };

    const adapter = new PiSdkAdapter({
      apiKey: "k",
      agentFactory: (() => fakeAgent) as never,
    });

    const result = await adapter.runAgentTask({
      message: "x",
      timeoutSeconds: 0.05,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timed out/);
  });
});
