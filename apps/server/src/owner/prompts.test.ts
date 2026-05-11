import { describe, expect, it } from "vitest";
import { buildOwnerSystemPrompt, buildConversationMessages } from "./prompts.js";
import type { AgentMessage } from "../mission-service.js";

describe("buildOwnerSystemPrompt", () => {
  it("combines system prompt, instruction, and schema", () => {
    const prompt = buildOwnerSystemPrompt(
      "You are a project manager",
      "Ask clarifying questions",
      '{"goal":"..."}',
    );

    expect(prompt).toContain("You are a project manager");
    expect(prompt).toContain("Ask clarifying questions");
    expect(prompt).toContain('{"goal":"..."}');
    expect(prompt).toContain("ONLY ask ONE question per response");
    expect(prompt).toContain("A. ");
  });
});

describe("buildConversationMessages", () => {
  it("builds message array from agent history with current message", () => {
    const history: AgentMessage[] = [
      { id: "1", missionId: "m1", fromAgentId: "user", type: "user_message", content: "I want to grow followers", createdAt: "" },
      { id: "2", missionId: "m1", fromAgentId: "owner", type: "owner_followup", content: "What platform?", createdAt: "" },
    ];

    const messages = buildConversationMessages("system prompt", history, "Xiaohongshu");

    expect(messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "I want to grow followers" },
      { role: "assistant", content: "What platform?" },
      { role: "user", content: "Xiaohongshu" },
    ]);
  });

  it("filters out non-conversation message types", () => {
    const history: AgentMessage[] = [
      { id: "1", missionId: "m1", fromAgentId: "agent", type: "execution_started", content: "Started", createdAt: "" },
      { id: "2", missionId: "m1", fromAgentId: "user", type: "user_message", content: "Hello", createdAt: "" },
    ];

    const messages = buildConversationMessages("system", history, "World");

    expect(messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ]);
  });

  it("handles empty history", () => {
    const messages = buildConversationMessages("system", [], "first message");

    expect(messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "first message" },
    ]);
  });
});
