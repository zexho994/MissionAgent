import { describe, expect, it } from "vitest";
import { FakeLlmAdapter } from "./fake-llm-adapter.js";

describe("FakeLlmAdapter", () => {
  it("returns the handler result and tracks stats", async () => {
    const fake = new FakeLlmAdapter((messages) => {
      const last = messages.at(-1);
      return `Echo: ${last?.content ?? ""}`;
    });

    const response = await fake.call([
      { role: "user", content: "hello" },
    ]);

    expect(response.content).toBe("Echo: hello");
    expect(response.model).toBe("fake-llm");
    expect(response.usage.totalTokens).toBeGreaterThan(0);
    expect(response.finishReason).toBe("stop");

    const stats = fake.stats();
    expect(stats.totalCalls).toBe(1);
    expect(stats.lastCallAt).toBeDefined();
  });

  it("tracks last messages sent", async () => {
    const fake = new FakeLlmAdapter(() => "ok");

    await fake.call([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "test" },
    ]);

    expect(fake.getLastMessages()).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "test" },
    ]);
  });

  it("accumulates stats across multiple calls", async () => {
    const fake = new FakeLlmAdapter(() => "response");

    await fake.call([{ role: "user", content: "first" }]);
    await fake.call([{ role: "user", content: "second" }]);

    expect(fake.stats().totalCalls).toBe(2);
  });
});
