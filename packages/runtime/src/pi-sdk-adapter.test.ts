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
});
