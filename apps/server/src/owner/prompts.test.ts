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

  it("includes skill tool directives for DigitalAgent capabilities", () => {
    const prompt = buildOwnerSystemPrompt(
      "You are a project manager",
      "Ask clarifying questions",
      '{"goal":"..."}',
    );

    expect(prompt).toContain("list_skill_files");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("digitalagent/SKILL.md");
    expect(prompt).toContain("Do not rewrite DigitalAgent internal mission execution into an external software-building project");
  });

  it("anchors Owner identity to DigitalAgent instead of external multi-agent frameworks", () => {
    const prompt = buildOwnerSystemPrompt(
      "You are a project manager",
      "Ask clarifying questions",
      '{"goal":"..."}',
    );

    expect(prompt).toContain("You are the Owner Agent inside DigitalAgent");
    expect(prompt).toContain("DigitalAgent is the current self-developed mission execution system");
    expect(prompt).toContain("Do not ask whether the user is using CrewAI, AutoGen, or another external multi-agent framework");
    expect(prompt).toContain("MUST call load_skill with digitalagent/SKILL.md before asking a follow-up");
    expect(prompt).toContain("agent, mission, collaboration, 协作, 测试, 验证");
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
