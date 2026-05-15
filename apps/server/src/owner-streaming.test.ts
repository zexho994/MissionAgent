import { describe, expect, it } from "vitest";
import { createMission, type Mission } from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";
import { runOwnerLlmStreaming, type OwnerStreamingDeps } from "./owner-streaming.js";

describe("runOwnerLlmStreaming", () => {
  it("blocks Owner and records an explicit error when configured LLM fails", async () => {
    const harness = createHarness();
    const llm = failingLlm("LLM unavailable");

    await runOwnerLlmStreaming(llm, baseInput(), harness.deps);

    expect(harness.messages).toEqual([
      expect.objectContaining({
        type: "owner_error",
        content: "Owner LLM failed: LLM unavailable",
      }),
    ]);
    expect(harness.agentPatch).toEqual({
      status: "blocked",
      lastAction: "Owner LLM failed: LLM unavailable",
    });
    expect(harness.doneEvents).toHaveLength(1);
    expect(harness.persistCount).toBe(1);
  });

  it("treats structured ready decision with a valid brief as MissionBrief readiness", async () => {
    const harness = createHarness();
    const llm = staticLlm(JSON.stringify({
      status: "ready",
      brief: {
        goal: "Grow Xiaohongshu to 1000 followers",
        scope: "Xiaohongshu content operations",
        constraints: ["human approval"],
        successMetrics: ["followers >= 1000"],
        keyAssumptions: ["existing account"],
      },
    }));

    await runOwnerLlmStreaming(llm, baseInput(), harness.deps);

    expect(harness.mission.brief?.goal).toBe("Grow Xiaohongshu to 1000 followers");
    expect(harness.messages).toEqual([
      expect.objectContaining({ type: "mission_brief" }),
    ]);
  });

  it("does not create a MissionBrief while an Owner follow-up is unanswered", async () => {
    const harness = createHarness({
      messages: [
        { type: "owner_followup", createdAt: "2026-05-07T10:00:00.000Z" },
      ],
    });
    const llm = staticLlm(JSON.stringify({
      status: "ready",
      brief: {
        goal: "Build an HTML knowledge map",
        scope: "Framework comparison",
        constraints: [],
        successMetrics: ["HTML created"],
        keyAssumptions: [],
      },
    }));

    await runOwnerLlmStreaming(llm, baseInput(), harness.deps);

    expect(harness.mission.brief).toBeUndefined();
    expect(harness.messages).toEqual([]);
    expect(harness.agentPatch).toEqual({
      status: "idle",
      lastAction: "Waiting for user answer before generating MissionBrief",
    });
  });

  it("allows MissionBrief creation after user answers the latest Owner follow-up", async () => {
    const harness = createHarness({
      messages: [
        { type: "owner_followup", createdAt: "2026-05-07T10:00:00.000Z" },
        { type: "user_message", createdAt: "2026-05-07T10:01:00.000Z" },
      ],
    });
    const llm = staticLlm(JSON.stringify({
      status: "ready",
      brief: {
        goal: "Build an HTML knowledge map",
        scope: "Framework comparison",
        constraints: [],
        successMetrics: ["HTML created"],
        keyAssumptions: [],
      },
    }));

    await runOwnerLlmStreaming(llm, baseInput(), harness.deps);

    expect(harness.mission.brief?.goal).toBe("Build an HTML knowledge map");
    expect(harness.messages).toEqual([
      expect.objectContaining({ type: "mission_brief" }),
    ]);
  });

  it("keeps structured needs_info decision as follow-up and does not create a brief", async () => {
    const harness = createHarness();
    const llm = staticLlm(JSON.stringify({
      status: "needs_info",
      question: "Who is the target audience?",
    }));

    await runOwnerLlmStreaming(llm, baseInput(), harness.deps);

    expect(harness.mission.brief).toBeUndefined();
    expect(harness.messages).toEqual([
      expect.objectContaining({
        type: "owner_followup",
        content: "Who is the target audience?",
      }),
    ]);
  });

  it("forwards owner LLM tool events to the mission stream", async () => {
    const harness = createHarness();
    const llm: LlmService = {
      call: async (_messages, options) => {
        options?.onToolEvent?.({
          status: "start",
          traceLabel: "Owner",
          toolName: "load_skill",
          toolCallId: "tool-1",
          args: { path: "digitalagent/SKILL.md" },
        });
        const content = JSON.stringify({ status: "needs_info", question: "What should we test?" });
        options?.onStream?.(content);
        return {
          content,
          model: "test",
          usage: { promptTokens: 0, completionTokens: content.length, totalTokens: content.length },
          finishReason: "stop",
        };
      },
      stats: () => ({ totalCalls: 1, totalPromptTokens: 0, totalCompletionTokens: 0 }),
    };

    await runOwnerLlmStreaming(llm, baseInput(), harness.deps);

    expect(harness.toolEvents).toEqual([
      {
        status: "start",
        traceLabel: "Owner",
        toolName: "load_skill",
        toolCallId: "tool-1",
        args: { path: "digitalagent/SKILL.md" },
      },
    ]);
  });
});

function baseInput() {
  return {
    missionId: "mission-1",
    ownerId: "owner-1",
    systemPrompt: "system",
    userMessage: "goal",
    llmMessages: undefined,
    isCreation: true,
  };
}

function createHarness(options: { messages?: Array<{ type: string; createdAt: string }> } = {}) {
  let mission: Mission = {
    ...createMission({
      goal: "Operate Xiaohongshu",
      successMetrics: ["metric"],
      constraints: ["constraint"],
    }),
    id: "mission-1",
  };
  const messages: Array<{ type: string; content: string }> = [];
  const doneEvents: unknown[] = [];
  const toolEvents: unknown[] = [];
  let agentPatch: { status: string; lastAction: string } | undefined;
  let persistCount = 0;

  const deps: OwnerStreamingDeps = {
    getMission: () => mission,
    getMessages: () => options.messages ?? [],
    setMission: (next) => { mission = next; },
    appendMessage: (msg) => { messages.push({ type: msg.type, content: msg.content }); },
    updateAgent: (_id, patch) => { agentPatch = patch; },
    notifyStream: (_missionId, event) => {
      if (event.type === "done") doneEvents.push(event);
    },
    notifyToolCall: (_missionId, event) => {
      toolEvents.push(event);
    },
    persist: () => { persistCount += 1; },
  };

  return {
    get mission() { return mission; },
    messages,
    doneEvents,
    toolEvents,
    get agentPatch() { return agentPatch; },
    get persistCount() { return persistCount; },
    deps,
  };
}

function staticLlm(content: string): LlmService {
  return {
    call: async (_messages, options) => {
      options?.onStream?.(content);
      return {
        content,
        model: "test",
        usage: { promptTokens: 0, completionTokens: content.length, totalTokens: content.length },
        finishReason: "stop",
      };
    },
    stats: () => ({ totalCalls: 1, totalPromptTokens: 0, totalCompletionTokens: 0 }),
  };
}

function failingLlm(message: string): LlmService {
  return {
    call: async () => { throw new Error(message); },
    stats: () => ({ totalCalls: 1, totalPromptTokens: 0, totalCompletionTokens: 0 }),
  };
}
