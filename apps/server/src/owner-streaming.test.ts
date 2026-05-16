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
    const llm = sequencedLlm([JSON.stringify({
      status: "ready",
      brief: {
        goal: "Grow Xiaohongshu to 1000 followers",
        scope: "Xiaohongshu content operations",
        constraints: ["human approval"],
        successMetrics: ["followers >= 1000"],
        keyAssumptions: ["existing account"],
      },
    }), JSON.stringify({ requirements: [] }), JSON.stringify({ status: "pass", reasons: [] })], []);

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
    const llm = sequencedLlm([JSON.stringify({
      status: "ready",
      brief: {
        goal: "Build an HTML knowledge map",
        scope: "Framework comparison",
        constraints: [],
        successMetrics: ["HTML created"],
        keyAssumptions: [],
      },
    }), JSON.stringify({ requirements: [] }), JSON.stringify({ status: "pass", reasons: [] })], []);

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

  it("retries once with parse feedback when Owner returns invalid MissionBrief JSON", async () => {
    const harness = createHarness({
      messages: [
        { type: "owner_followup", createdAt: "2026-05-07T10:00:00.000Z" },
        { type: "user_message", createdAt: "2026-05-07T10:01:00.000Z" },
      ],
    });
    const invalidJson = '{"goal":"Run 5 agents","scope":"Mission","constraints":["5 agents"]，"successMetrics":["50 turns"],"keyAssumptions":[]}';
    const validJson = JSON.stringify({
      goal: "Run 5 agents",
      scope: "Mission",
      constraints: ["5 agents"],
      successMetrics: ["50 turns"],
      keyAssumptions: [],
    });
    const calls: Array<{ role: string; content: string }[]> = [];
    const llm = sequencedLlm([
      invalidJson,
      validJson,
      JSON.stringify({ requirements: [] }),
      JSON.stringify({ status: "pass", reasons: [] }),
    ], calls);

    await runOwnerLlmStreaming(llm, baseInput(), harness.deps);

    expect(calls).toHaveLength(4);
    expect(calls[1]?.at(-1)?.content).toContain("Previous Owner response JSON parse error");
    expect(calls[1]?.at(-1)?.content).toContain(invalidJson);
    expect(calls[2]?.at(-1)?.content).toContain("Mission contract extraction");
    expect(calls[3]?.at(-1)?.content).toContain("MissionBrief contract validation");
    expect(harness.mission.brief?.goal).toBe("Run 5 agents");
    expect(harness.messages).toEqual([
      expect.objectContaining({ type: "mission_brief" }),
    ]);
  });

  it("repairs a MissionBrief once when LLM semantic review finds omitted user constraints", async () => {
    const harness = createHarness();
    const weakBrief = JSON.stringify({
      status: "ready",
      brief: {
        goal: "Organize a group idiom-chain game",
        scope: "Family entertainment activity",
        constraints: ["5 or more people can participate"],
        successMetrics: ["Players enjoy the game"],
        keyAssumptions: [],
      },
    });
    const repairedBrief = JSON.stringify({
      status: "ready",
      brief: {
        goal: "Run a 5-agent collaborative idiom-chain mission",
        scope: "5 runtime agents take turns producing the next idiom",
        constraints: ["Must use exactly 5 participating agents", "Agents must take turns"],
        successMetrics: ["Complete 50 idiom-chain turns"],
        keyAssumptions: [],
      },
    });
    const calls: Array<{ role: string; content: string }[]> = [];
    const responses = [
      weakBrief,
      JSON.stringify({ requirements: ["The mission must use exactly 5 agents.", "The chain must complete 50 turns."] }),
      JSON.stringify({
        status: "fail",
        reasons: [
          "The candidate softened the user requirement from 5 agents to 5 or more people.",
          "The candidate omitted the required 50 turns.",
        ],
      }),
      repairedBrief,
      JSON.stringify({ status: "pass", reasons: [] }),
    ];
    const llm = sequencedLlm(responses, calls);

    await runOwnerLlmStreaming(llm, {
      ...baseInput(),
      userMessage: "5 个 agent 协作玩成语接龙,每个 agent 轮流给出下一个成语,完成 50 次接龙才算成功。",
    }, harness.deps);

    expect(calls).toHaveLength(5);
    expect(calls[1]?.at(-1)?.content).toContain("Mission contract extraction");
    expect(calls[2]?.at(-1)?.content).toContain("MissionBrief contract validation");
    expect(calls[3]?.at(-1)?.content).toContain("The candidate omitted the required 50 turns.");
    expect(calls[3]?.at(-1)?.content).toContain("The chain must complete 50 turns.");
    expect(harness.mission.brief?.constraints).toContain("Must use exactly 5 participating agents");
    expect(harness.mission.brief?.successMetrics).toContain("Complete 50 idiom-chain turns");
    expect(harness.messages).toEqual([
      expect.objectContaining({
        type: "mission_brief",
        content: repairedBrief,
      }),
    ]);
  });

  it("fastfails when MissionBrief semantic review still fails after one repair", async () => {
    const harness = createHarness();
    const weakBrief = JSON.stringify({
      status: "ready",
      brief: {
        goal: "Organize a group game",
        scope: "Entertainment",
        constraints: ["5 or more people"],
        successMetrics: ["Have fun"],
        keyAssumptions: [],
      },
    });
    const calls: Array<{ role: string; content: string }[]> = [];
    const llm = sequencedLlm([
      weakBrief,
      JSON.stringify({ requirements: ["The mission must use exactly 5 agents.", "The chain must complete 50 turns."] }),
      JSON.stringify({ status: "fail", reasons: ["Missing required 50 turns."] }),
      weakBrief,
      JSON.stringify({ status: "fail", reasons: ["Still missing required 50 turns."] }),
    ], calls);

    await runOwnerLlmStreaming(llm, {
      ...baseInput(),
      userMessage: "5 个 agent 协作玩成语接龙,每个 agent 轮流给出下一个成语,完成 50 次接龙才算成功。",
    }, harness.deps);

    expect(calls).toHaveLength(5);
    expect(harness.mission.brief).toBeUndefined();
    expect(harness.messages).toEqual([
      expect.objectContaining({
        type: "owner_error",
        content: expect.stringContaining("Owner MissionBrief contract validation failed after repair retry: Still missing required 50 turns."),
      }),
    ]);
    expect(harness.agentPatch).toEqual({
      status: "blocked",
      lastAction: expect.stringContaining("Owner MissionBrief contract validation failed after repair retry: Still missing required 50 turns."),
    });
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

function sequencedLlm(
  responses: string[],
  calls: Array<{ role: string; content: string }[]>,
): LlmService {
  return {
    call: async (messages, options) => {
      calls.push(messages);
      const content = responses[calls.length - 1];
      if (!content) throw new Error(`Unexpected LLM call ${calls.length}`);
      options?.onStream?.(content);
      return {
        content,
        model: "test",
        usage: { promptTokens: 0, completionTokens: content.length, totalTokens: content.length },
        finishReason: "stop",
      };
    },
    stats: () => ({ totalCalls: calls.length, totalPromptTokens: 0, totalCompletionTokens: 0 }),
  };
}

function failingLlm(message: string): LlmService {
  return {
    call: async () => { throw new Error(message); },
    stats: () => ({ totalCalls: 1, totalPromptTokens: 0, totalCompletionTokens: 0 }),
  };
}
