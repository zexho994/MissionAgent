import { describe, expect, it, vi } from "vitest";
import { createPassToNextAgentTool } from "./agent-handoff.js";

describe("createPassToNextAgentTool", () => {
  function makeDeps(overrides: Partial<Parameters<typeof createPassToNextAgentTool>[0]> = {}) {
    return {
      missionId: "mission-1",
      sourceTaskId: "task-1",
      sourceAgentId: "agent-1",
      createFollowupTask: vi.fn(async () => ({ created: true as const, taskId: "task-2" })),
      appendMessage: vi.fn(() => undefined),
      ...overrides,
    };
  }

  it("calls createFollowupTask with payload mapped from params", async () => {
    const deps = makeDeps();
    const tool = createPassToNextAgentTool(deps);

    const result = await tool.execute("call-99", {
      nextRole: "玩家2",
      objective: "继续接龙,首字'缰'",
      reason: "我接了'信马由缰'",
      inputContext: { lastIdiom: "信马由缰", chainLength: 3 },
    });

    expect(deps.createFollowupTask).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(deps.createFollowupTask).mock.calls[0]![0];
    expect(payload).toMatchObject({
      missionId: "mission-1",
      triggeringEventId: "handoff:task-1:call-99",
      payload: {
        objective: "继续接龙,首字'缰'",
        assigneeRole: "玩家2",
        reason: "我接了'信马由缰'",
        sourceTaskId: "task-1",
        inputContext: { lastIdiom: "信马由缰", chainLength: 3 },
      },
    });
    expect(result.details).toMatchObject({ created: true, taskId: "task-2" });
  });

  it("appends an agent_chat message describing the handoff", async () => {
    const deps = makeDeps();
    const tool = createPassToNextAgentTool(deps);

    await tool.execute("call-1", {
      nextRole: "玩家2",
      objective: "x",
      reason: "我做完了",
    });

    expect(deps.appendMessage).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(deps.appendMessage).mock.calls[0]![0];
    expect(msg).toMatchObject({
      missionId: "mission-1",
      fromAgentId: "agent-1",
      type: "agent_chat",
    });
    expect(msg.content).toContain("玩家2");
    expect(msg.content).toContain("我做完了");
  });

  it("returns failure result when createFollowupTask refuses (no_assignee)", async () => {
    const deps = makeDeps({
      createFollowupTask: vi.fn(async () => ({
        created: false as const,
        reason: "no_assignee" as const,
        escalateMessageSent: true,
      })),
    });
    const tool = createPassToNextAgentTool(deps);

    const result = await tool.execute("c1", { nextRole: "不存在的角色", objective: "x", reason: "y" });
    expect(result.details).toMatchObject({ created: false, reason: "no_assignee" });
  });

  it("uses empty inputContext when not provided", async () => {
    const deps = makeDeps();
    const tool = createPassToNextAgentTool(deps);

    await tool.execute("c1", { nextRole: "玩家2", objective: "x", reason: "y" });

    const payload = vi.mocked(deps.createFollowupTask).mock.calls[0]![0];
    expect(payload.payload.inputContext).toEqual({});
  });
});
