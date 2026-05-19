import { describe, expect, it } from "vitest";
import { PiSdkAdapter } from "./pi-sdk-adapter.js";
import { createWebSearchTool } from "./pi-extensions/web-search.js";

const SMOKE = process.env.PI_SMOKE === "1";

describe.skipIf(!SMOKE)("PiSdkAdapter smoke (real LLM)", () => {
  it("completes a minimal prompt and yields a final assistant message", async () => {
    const apiKey =
      process.env.LLM_API_KEY ??
      process.env.MINIMAX_API_KEY ??
      process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "PI_SMOKE=1 set but LLM_API_KEY/MINIMAX_API_KEY/ANTHROPIC_API_KEY not provided",
      );
    }
    const adapter = new PiSdkAdapter({
      apiKey,
      modelProvider: process.env.LLM_PROVIDER ?? "minimax-cn",
      modelId: process.env.LLM_MODEL ?? "MiniMax-M2.7-highspeed",
      tools: [createWebSearchTool({})],
    });

    const result = await adapter.runAgentTask({
      message: "Reply with exactly the word OK.",
      timeoutSeconds: 60,
      systemPrompt: "You are a test fixture. Reply tersely.",
      sessionId: "smoke-stage-2",
    });

    expect(result.status).toBe("completed");
    expect(JSON.stringify(result.output)).toMatch(/OK/i);
  }, 90_000);
});
