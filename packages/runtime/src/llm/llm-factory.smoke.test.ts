import { describe, expect, it } from "vitest";
import { createLlmServiceFromEnv } from "./llm-factory.js";

const SMOKE = process.env.PI_SMOKE === "1";

describe.skipIf(!SMOKE)("llm-factory smoke (real pi-ai call)", () => {
  it("returns a non-empty response from a real provider", async () => {
    const env = {
      LLM_PROVIDER: process.env.LLM_PROVIDER ?? "anthropic",
      LLM_API_KEY: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY,
      LLM_MODEL: process.env.LLM_MODEL ?? "claude-3-5-haiku-latest",
    };
    if (!env.LLM_API_KEY) {
      throw new Error("PI_SMOKE=1 set but LLM_API_KEY/ANTHROPIC_API_KEY not provided");
    }
    const svc = createLlmServiceFromEnv(env);
    const response = await svc.call(
      [
        { role: "system", content: "Reply with exactly the word OK." },
        { role: "user", content: "Reply now." },
      ],
      { maxTokens: 16 },
    );
    expect(response.content.trim().length).toBeGreaterThan(0);
    expect(response.usage.totalTokens).toBeGreaterThan(0);
  }, 30_000);
});
