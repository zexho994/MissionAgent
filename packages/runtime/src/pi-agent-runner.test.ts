import { describe, expect, it, vi } from "vitest";
import { runPiAgent } from "./pi-agent-runner.js";

describe("runPiAgent", () => {
  it("constructs a pi-agent with tools, session id, and initial messages", async () => {
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
      state: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
    };
    const agentFactory = vi.fn().mockReturnValue(fakeAgent);

    const result = await runPiAgent({
      apiKey: "k",
      modelProvider: "minimax-cn",
      modelId: "MiniMax-M2.7-highspeed",
      systemPrompt: "system",
      messages: [{ role: "user", content: "previous" }],
      prompt: "next",
      tools: [tool],
      sessionId: "session-1",
      timeoutSeconds: 5,
      agentFactory: agentFactory as never,
    });

    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        initialState: expect.objectContaining({
          systemPrompt: "system",
          tools: [tool],
          messages: [{ role: "user", content: "previous" }],
        }),
      }),
    );
    expect(fakeAgent.prompt).toHaveBeenCalledWith("next");
    expect(result.messages).toEqual(fakeAgent.state.messages);
  });

  it("forwards agent events to onEvent", async () => {
    let handler: ((event: unknown) => void) | undefined;
    const onEvent = vi.fn();
    const fakeAgent = {
      prompt: vi.fn().mockImplementation(async () => {
        handler?.({ type: "tool_execution_end", toolName: "web_search" });
      }),
      subscribe: vi.fn().mockImplementation((next) => {
        handler = next;
      }),
      state: { messages: [] },
    };

    await runPiAgent({
      apiKey: "k",
      modelProvider: "minimax-cn",
      modelId: "MiniMax-M2.7-highspeed",
      systemPrompt: "",
      messages: [],
      prompt: "run",
      tools: [],
      timeoutSeconds: 5,
      onEvent,
      agentFactory: (() => fakeAgent) as never,
    });

    expect(onEvent).toHaveBeenCalledWith({ type: "tool_execution_end", toolName: "web_search" });
  });
});