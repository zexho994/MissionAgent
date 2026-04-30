import { describe, expect, it, beforeEach } from "vitest";
import { createScheduleRule } from "@digitalagent/core";
import { InMemoryMissionService } from "./mission-service.js";
import { FakeLlmAdapter } from "@digitalagent/runtime";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("InMemoryMissionService", () => {
  it("creates a mission with default success metrics from config when not provided", async () => {
    const service = new InMemoryMissionService();

    const mission = await service.createMission({
      goal: "学习 harness 并生成一张知识图",
    });

    expect(mission.successMetrics).toContain("目标结果已经被 Owner 明确");
    expect(mission.constraints).toContain("需求不清楚时，先让用户用选择或填写补充");
    const snapshot = service.snapshot();
    expect(snapshot.missions).toHaveLength(1);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.role).toBe("owner");
    expect(snapshot.tasks).toHaveLength(0);
    expect(snapshot.agentMessages).toHaveLength(0);
  });

  it("creates a mission with user-provided metrics and constraints", async () => {
    const service = new InMemoryMissionService();

    const mission = await service.createMission({
      goal: "Grow Xiaohongshu account to 1000 followers",
      successMetrics: ["followers >= 1000"],
      constraints: ["human approval before publishing"],
    });

    expect(mission.successMetrics).toEqual(["followers >= 1000"]);
    expect(mission.constraints).toEqual(["human approval before publishing"]);
  });

  it("activates a mission to create team, agents, and first task", async () => {
    const service = new InMemoryMissionService();

    const mission = await service.createMission({
      goal: "Create a harness learning image",
      successMetrics: ["core knowledge map", "image prompt"],
      constraints: ["concise"],
    });

    service.activateMission({ missionId: mission.id });

    const snapshot = service.snapshot();
    expect(snapshot.agents.map((agent) => agent.role)).toEqual([
      "owner",
      "hr",
      "researcher",
      "image_creator",
      "reviewer",
    ]);
    expect(snapshot.agents.every((agent) => agent.missionId === mission.id)).toBe(true);
    expect(snapshot.agentRelations).toHaveLength(snapshot.agents.length - 1);
    expect(snapshot.agentRelations.map((relation) => relation.label)).toContain("提交产出审核 / 反馈修正");
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.title).toBe("Define knowledge structure and first image production plan");
  });

  it("marks HR as recruiting before activation work completes", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({
      goal: "Grow a GitHub account",
      successMetrics: ["two repos over 1000 stars"],
      constraints: ["one month"],
    });

    service.beginMissionActivation({ missionId: mission.id });

    const snapshot = service.snapshot();
    const hr = snapshot.agents.find((agent) => agent.missionId === mission.id && agent.role === "hr");
    expect(hr?.status).toBe("running");
    expect(hr?.lastAction).toContain("招募团队");
    expect(snapshot.tasks.filter((task) => task.missionId === mission.id)).toHaveLength(0);
    expect(snapshot.agentMessages.some((message) => message.missionId === mission.id && message.content.includes("正在分析 MissionBrief"))).toBe(true);
  });

  it("does not re-activate a mission that already has tasks", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Test goal" });
    service.activateMission({ missionId: mission.id });
    const firstTaskCount = service.snapshot().tasks.length;

    service.activateMission({ missionId: mission.id });

    expect(service.snapshot().tasks).toHaveLength(firstTaskCount);
  });

  it("keeps war room state isolated between multiple missions", async () => {
    const service = new InMemoryMissionService();

    const first = await service.createMission({
      goal: "First mission",
      successMetrics: ["first metric"],
      constraints: ["first constraint"],
    });
    service.activateMission({ missionId: first.id });
    const second = await service.createMission({
      goal: "Second mission",
      successMetrics: ["second metric"],
      constraints: ["second constraint"],
    });
    service.activateMission({ missionId: second.id });

    const snapshot = service.snapshot();
    expect(snapshot.missions).toHaveLength(2);
    expect(snapshot.agents.filter((agent) => agent.missionId === first.id).length).toBeGreaterThanOrEqual(4);
    expect(snapshot.agents.filter((agent) => agent.missionId === second.id).length).toBeGreaterThanOrEqual(4);
    expect(snapshot.tasks.filter((task) => task.missionId === first.id)).toHaveLength(1);
    expect(snapshot.tasks.filter((task) => task.missionId === second.id)).toHaveLength(1);
  });

  it("links worker agent activity to tasks, tool calls, and artifacts", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Create a harness learning image" });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({
      missionId: mission.id,
      taskId: task.id,
    });
    service.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: {
        openclaw: {
          payloads: [{ text: "Harness learning image prompt and core knowledge map" }],
        },
      },
      evidence: ["openclaw:local"],
    });

    const snapshot = service.snapshot();
    const worker = snapshot.agents.find((agent) => agent.role === "researcher" && agent.missionId === mission.id);
    if (!worker) throw new Error("missing worker");

    expect(snapshot.tasks.some((candidate) => candidate.assigneeAgentId === "openclaw_runner")).toBe(true);
    expect(snapshot.toolCalls.some((call) => call.agentId === worker.id && call.status === "completed")).toBe(true);
    expect(snapshot.agentMessages.some((message) => message.fromAgentId === worker.id && message.type === "execution_completed")).toBe(true);
    expect(snapshot.artifacts.some((artifact) => artifact.taskId === task.id)).toBe(true);
  });

  it("persists mission state to a local JSON file and reloads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digitalagent-store-"));
    try {
      const storageFile = join(dir, "mission-store.json");
      const service = new InMemoryMissionService({ storageFile });
      const mission = await service.createMission({ goal: "学习 harness 并生成知识图" });
      service.activateMission({ missionId: mission.id });

      const reloaded = new InMemoryMissionService({ storageFile });
      const snapshot = reloaded.snapshot();

      expect(snapshot.missions[0]?.id).toBe(mission.id);
      expect(snapshot.tasks).toHaveLength(1);
      expect(snapshot.agents.length).toBeGreaterThan(0);
      expect(snapshot.agentRelations.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues an existing mission conversation without creating a new mission", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "学习 harness 并生成知识图" });
    service.activateMission({ missionId: mission.id });

    await service.continueMission({
      missionId: mission.id,
      message: "图片风格要更像像素头像",
    });

    const snapshot = service.snapshot();
    expect(snapshot.missions).toHaveLength(1);
    expect(snapshot.agentMessages.some((message) => message.type === "user_message" && message.content.includes("像素头像"))).toBe(true);
    expect(snapshot.agentMessages.some((message) => message.type === "owner_followup" && message.content.includes("当前 Mission"))).toBe(true);
  });

  it("submits an execution artifact and creates a review", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({
      goal: "Grow Xiaohongshu account",
      successMetrics: ["daily review generated"],
      constraints: ["human approval before publishing"],
    });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({
      missionId: mission.id,
      taskId: task.id,
    });

    const result = service.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: {
        openclaw: {
          payloads: [{ text: "Xiaohongshu account growth plan: daily review generated successfully" }],
          meta: { durationMs: 5000 },
        },
      },
      evidence: ["openclaw:local"],
    });

    expect(result.artifact.taskId).toBe(task.id);
    expect(result.review.decision).toBe("approve");
    expect(service.snapshot().tasks[0]?.status).toBe("completed");
    expect(service.snapshot().executions[0]?.status).toBe("completed");
    expect(service.snapshot().toolCalls[0]?.status).toBe("completed");
    expect(service.snapshot().decisions[0]?.decision).toBe("approve");
  });

  it("tracks failed executions without hiding the error", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({
      goal: "Grow Xiaohongshu account",
      successMetrics: ["daily review generated"],
      constraints: ["human approval before publishing"],
    });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({
      missionId: mission.id,
      taskId: task.id,
    });

    const failed = service.failExecution({
      executionId: execution.id,
      error: "OpenClaw command failed",
    });

    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("OpenClaw command failed");
    expect(service.snapshot().toolCalls[0]?.status).toBe("failed");
    expect(service.snapshot().agentMessages.at(-1)?.type).toBe("execution_failed");
  });

  it("rejects artifacts with empty or missing OpenClaw output", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({
      goal: "Generate a marketing image",
      successMetrics: ["image produced"],
      constraints: ["human approval before publishing"],
    });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({
      missionId: mission.id,
      taskId: task.id,
    });

    const result = service.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: { text: "some text" },
      evidence: ["openclaw:local"],
    });

    expect(result.review.decision).toBe("reject");
    expect(service.snapshot().tasks[0]?.status).toBe("failed");
  });

  it("can retry a task after reviewer requests revision", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({
      goal: "Generate a learning image",
      successMetrics: ["image prompt"],
      constraints: ["concise"],
    });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const firstExecution = service.startExecution({
      missionId: mission.id,
      taskId: task.id,
    });
    service.submitExecutionResult({
      executionId: firstExecution.id,
      missionId: mission.id,
      taskId: task.id,
      content: {
        openclaw: {
          payloads: [{ text: "Short text about image prompt without actual image generation" }],
        },
      },
      evidence: ["openclaw:local"],
    });

    expect(service.snapshot().tasks[0]?.status).toBe("revision_needed");

    const retry = service.startExecution({
      missionId: mission.id,
      taskId: task.id,
    });

    expect(retry.status).toBe("running");
    expect(service.snapshot().tasks[0]?.status).toBe("running");
    expect(service.snapshot().taskEvents.at(-1)?.type).toBe("execution.started");
  });

  it("uses LLM to generate initial Owner question when configured", async () => {
    const fake = new FakeLlmAdapter(() => "请问你的目标人群是谁？");
    const service = new InMemoryMissionService({ llm: fake });

    const mission = await service.createMission({ goal: "运营小红书账号" });

    expect(mission.goal).toBe("运营小红书账号");
    expect(fake.stats().totalCalls).toBe(1);

    const messages = service.snapshot().agentMessages.filter((message) => message.missionId === mission.id);
    expect(messages.some((message) => message.type === "owner_followup" && message.content.includes("目标人群"))).toBe(true);
  });

  it("marks Owner as thinking before returning the first LLM-backed mission snapshot", async () => {
    const pendingLlm = {
      call: () => new Promise<never>(() => {}),
      stats: () => ({ totalCalls: 1, totalPromptTokens: 0, totalCompletionTokens: 0 }),
    };
    const service = new InMemoryMissionService({ llm: pendingLlm });

    const mission = await service.createMission({ goal: "运营小红书账号" });

    const owner = service.snapshot().agents.find((agent) => agent.missionId === mission.id && agent.role === "owner");
    expect(owner?.status).toBe("thinking");
    expect(owner?.lastAction).toBe("Processing initial user goal");
  });

  it("uses LLM for multi-turn conversation and generates MissionBrief", async () => {
    let callCount = 0;
    const fake = new FakeLlmAdapter(() => {
      callCount += 1;
      if (callCount <= 1) return "请问你的目标人群是谁？";
      return JSON.stringify({
        goal: "运营小红书账号到1000粉丝",
        scope: "小红书平台内容运营",
        constraints: ["human approval before publishing"],
        successMetrics: ["followers >= 1000"],
        keyAssumptions: ["existing account"],
        targetAudience: "年轻女性",
        timeline: "1个月",
      });
    });
    const service = new InMemoryMissionService({ llm: fake });

    await service.createMission({ goal: "运营小红书账号" });

    await service.continueMission({ missionId: service.snapshot().missions[0]!.id, message: "目标人群是年轻女性" });

    const snapshot = service.snapshot();
    const updatedMission = snapshot.missions[0];
    expect(updatedMission?.brief).toBeDefined();
    expect(updatedMission?.brief?.goal).toBe("运营小红书账号到1000粉丝");
    expect(updatedMission?.brief?.successMetrics).toEqual(["followers >= 1000"]);
  });

  it("confirms a MissionBrief and updates mission metrics", async () => {
    const fake = new FakeLlmAdapter(() => JSON.stringify({
      goal: "运营小红书账号到1000粉丝",
      scope: "小红书平台",
      constraints: ["human approval"],
      successMetrics: ["followers >= 1000"],
      keyAssumptions: ["existing account"],
    }));
    const service = new InMemoryMissionService({ llm: fake });

    await service.createMission({ goal: "运营小红书账号" });

    await service.continueMission({ missionId: service.snapshot().missions[0]!.id, message: "补充信息" });

    const withBrief = service.snapshot().missions[0];
    if (!withBrief?.brief) throw new Error("brief should exist");

    const confirmed = service.confirmBrief({ missionId: withBrief.id });

    expect(confirmed.briefConfirmed).toBe(true);
    expect(confirmed.successMetrics).toEqual(["followers >= 1000"]);
    expect(confirmed.constraints).toEqual(["human approval"]);
  });

  it("falls back to template response when LLM is not configured", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "运营小红书账号" });

    await service.continueMission({ missionId: mission.id, message: "补充信息" });

    const messages = service.snapshot().agentMessages.filter((message) => message.missionId === mission.id);
    expect(messages.some((message) => message.type === "owner_followup" && message.content.includes("补充信息"))).toBe(true);
  });

  it("forces summary request when maxGatheringTurns is reached", async () => {
    let callCount = 0;
    const fake = new FakeLlmAdapter(() => {
      callCount += 1;
      if (callCount <= 2) return "请补充更多细节";
      return JSON.stringify({
        goal: "运营小红书账号",
        scope: "小红书",
        constraints: [],
        successMetrics: ["运营完成"],
        keyAssumptions: [],
      });
    });
    const service = new InMemoryMissionService({ llm: fake });

    await service.createMission({ goal: "运营小红书账号" });
    const missionId = service.snapshot().missions[0]!.id;

    await service.continueMission({ missionId, message: "补充1" });
    await service.continueMission({ missionId, message: "补充2" });
    await service.continueMission({ missionId, message: "补充3" });
    await service.continueMission({ missionId, message: "补充4" });
    await service.continueMission({ missionId, message: "补充5" });

    const snapshot = service.snapshot();
    expect(snapshot.missions[0]?.brief).toBeDefined();
  });

  it("blocks Owner instead of using template fallback when configured LLM fails", async () => {
    const failingLlm = {
      call: async () => { throw new Error("LLM unavailable"); },
      stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
    };
    const service = new InMemoryMissionService({ llm: failingLlm as any });

    const mission = await service.createMission({ goal: "运营小红书账号" });
    await Promise.resolve();

    const messages = service.snapshot().agentMessages.filter((message) => message.missionId === mission.id);
    expect(messages.some((message) => message.type === "owner_followup")).toBe(false);
    expect(messages).toEqual([
      expect.objectContaining({
        type: "owner_error",
        content: expect.stringContaining("Owner LLM failed: LLM unavailable"),
      }),
    ]);
    expect(service.snapshot().agents.find((agent) => agent.role === "owner")?.status).toBe("blocked");
  });

  it("triggers agent collaboration reports after execution completes", async () => {
    const fake = new FakeLlmAdapter(() => JSON.stringify({
      message: "我已复盘执行产出：互动数据有下降风险，建议内容策划调整选题。",
      type: "agent_report",
      mentionedAgentIds: [],
      shouldPropagate: false,
      action: { type: "acknowledge" },
    }));
    const service = new InMemoryMissionService({ llm: fake });
    const mission = await service.createMission({
      goal: "运营一个小红书账号，一个月涨到1000粉丝",
      successMetrics: ["followers >= 1000"],
      constraints: ["human approval before publishing"],
    });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({ missionId: mission.id, taskId: task.id });

    service.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: {
        openclaw: {
          payloads: [{ text: "Xiaohongshu account growth plan: daily review generated successfully" }],
        },
      },
      evidence: ["openclaw:local"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = service.snapshot();
    const report = snapshot.agentMessages.find((message) => message.type === "agent_report");
    expect(report?.content).toContain("互动数据有下降风险");
    expect(report?.threadId).toBeDefined();
    expect(snapshot.threads).toContainEqual(expect.objectContaining({
      id: report?.threadId,
      missionId: mission.id,
      status: "resolved",
    }));
  });

  it("lets users trigger a conversation with a specific agent", async () => {
    const fake = new FakeLlmAdapter(() => JSON.stringify({
      message: "我会根据当前 Mission 产出一个简短行动建议。",
      type: "agent_chat",
      mentionedAgentIds: [],
      shouldPropagate: false,
      action: { type: "acknowledge" },
    }));
    const service = new InMemoryMissionService({ llm: fake });
    const mission = await service.createMission({ goal: "Create a harness learning image" });
    service.activateMission({ missionId: mission.id });
    const targetAgent = service.snapshot().agents.find((agent) => agent.role === "researcher");
    if (!targetAgent) throw new Error("missing target agent");

    const reply = await service.triggerAgentConversation({
      missionId: mission.id,
      agentId: targetAgent.id,
      message: "请汇报你当前看到的关键风险",
    });

    const snapshot = service.snapshot();
    expect(reply.type).toBe("agent_chat");
    expect(reply.content).toContain("简短行动建议");
    expect(reply.threadId).toBeDefined();
    expect(snapshot.agentMessages.some((message) => message.type === "user_message" && message.toAgentId === targetAgent.id)).toBe(true);
    expect(snapshot.threads.find((thread) => thread.id === reply.threadId)?.participantAgentIds).toContain(targetAgent.id);
  });

  it("parses fenced JSON agent conversation responses", async () => {
    const fake = new FakeLlmAdapter(() => [
      "```json",
      JSON.stringify({
        message: "我已识别线程隔离风险，建议先补并发对话测试。",
        type: "agent_report",
        mentionedAgentIds: [],
        shouldPropagate: false,
        action: { type: "acknowledge" },
      }, null, 2),
      "```",
    ].join("\n"));
    const service = new InMemoryMissionService({ llm: fake });
    const mission = await service.createMission({ goal: "Validate agent collaboration threads" });
    service.activateMission({ missionId: mission.id });
    const targetAgent = service.snapshot().agents.find((agent) => agent.role !== "owner");
    if (!targetAgent) throw new Error("missing target agent");

    const reply = await service.triggerAgentConversation({
      missionId: mission.id,
      agentId: targetAgent.id,
      message: "请汇报当前最大风险",
    });

    expect(reply.type).toBe("agent_report");
    expect(reply.content).toBe("我已识别线程隔离风险，建议先补并发对话测试。");
  });

  function addOwnerDailyRule(service: InMemoryMissionService, missionId: string) {
    const rule = createScheduleRule({
      name: "Daily check",
      missionId,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: { templateType: "daily_check" },
          outputSchema: { summary: "string" },
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "owner",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: { createdBy: "test" },
    });
    service.addScheduleRule(missionId, rule);
    return rule;
  }

  function addConditionRule(service: InMemoryMissionService, missionId: string, assigneeRole: string) {
    const rule = createScheduleRule({
      name: "Condition check",
      missionId,
      enabled: true,
      trigger: {
        type: "condition",
        description: "Owner signal is ready",
        sourceAgentRole: "owner",
        evaluatePrompt: "Is the owner signal ready?",
      },
      taskTemplate: {
        title: "Follow up on owner signal",
        contract: {
          objective: "Follow up on owner signal",
          input: { templateType: "condition_check" },
          outputSchema: { summary: "string" },
          successCriteria: ["Follow-up is summarized"],
        },
        assigneeRole,
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: { createdBy: "test" },
    });
    service.addScheduleRule(missionId, rule);
    return rule;
  }

  type TestScheduler = {
    evaluateConditions(context: {
      completedTaskAssigneeRole: string;
      artifactContent: string;
      missionGoal: string;
    }): Promise<void>;
  };

  function schedulerFor(service: InMemoryMissionService, missionId: string): TestScheduler {
    return (service as unknown as { getOrCreateScheduler(missionId: string): TestScheduler }).getOrCreateScheduler(missionId);
  }

  it("records a structured trigger event when a schedule rule is triggered", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const owner = service.snapshot().agents.find((agent) => agent.missionId === mission.id && agent.role === "owner");
    if (!owner) throw new Error("missing owner");

    const rule = addOwnerDailyRule(service, mission.id);

    service.triggerScheduleRule(mission.id, rule.id);

    const snapshot = service.snapshot();
    expect(snapshot.scheduleTriggerEvents).toHaveLength(1);
    expect(snapshot.scheduleTriggerEvents[0]).toEqual({
      id: expect.stringMatching(/^schedule_trigger_/),
      missionId: mission.id,
      ruleId: rule.id,
      ruleName: "Daily check",
      taskId: expect.stringMatching(/^task_/),
      status: "created",
      message: "Scheduled task \"Check yesterday's GitHub growth metrics\" created.",
      createdAt: expect.any(String),
    });
  });

  it("persists schedule trigger events across reloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digitalagent-trigger-events-"));
    try {
      const storageFile = join(dir, "mission-store.json");
      const service = new InMemoryMissionService({ storageFile });
      const mission = await service.createMission({ goal: "Track GitHub growth" });
      const rule = addOwnerDailyRule(service, mission.id);
      service.triggerScheduleRule(mission.id, rule.id);

      const reloaded = new InMemoryMissionService({ storageFile });

      expect(reloaded.snapshot().scheduleTriggerEvents).toHaveLength(1);
      expect(reloaded.snapshot().scheduleTriggerEvents[0]?.ruleId).toBe(rule.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a skipped trigger event when a manual schedule trigger has no matching agent", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = createScheduleRule({
      name: "Missing role check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check unavailable specialist queue",
        contract: {
          objective: "Check unavailable specialist queue",
          input: { templateType: "missing_role_check" },
          outputSchema: { summary: "string" },
          successCriteria: ["Skipped trigger is visible"],
        },
        assigneeRole: "missing_specialist",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: { createdBy: "test" },
    });
    service.addScheduleRule(mission.id, rule);

    service.triggerScheduleRule(mission.id, rule.id);

    expect(service.snapshot().scheduleTriggerEvents).toEqual([
      expect.objectContaining({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: "Missing role check",
        status: "skipped",
        message: "No agent found for role \"missing_specialist\".",
      }),
    ]);
  });

  it("records a created trigger event when the scheduler creates a task", async () => {
    const service = new InMemoryMissionService({ llm: new FakeLlmAdapter(() => "true") });
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = addConditionRule(service, mission.id, "owner");
    const scheduler = schedulerFor(service, mission.id);

    await scheduler.evaluateConditions({
      completedTaskAssigneeRole: "owner",
      artifactContent: JSON.stringify({ ready: true }),
      missionGoal: mission.goal,
    });

    expect(service.snapshot().scheduleTriggerEvents).toEqual([
      expect.objectContaining({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: "Condition check",
        taskId: expect.stringMatching(/^task_/),
        status: "created",
        message: "Scheduled task \"Follow up on owner signal\" created.",
      }),
    ]);
  });

  it("records a skipped trigger event when the scheduler cannot find an assignee", async () => {
    const service = new InMemoryMissionService({ llm: new FakeLlmAdapter(() => "true") });
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = addConditionRule(service, mission.id, "missing_specialist");
    const scheduler = schedulerFor(service, mission.id);

    await scheduler.evaluateConditions({
      completedTaskAssigneeRole: "owner",
      artifactContent: JSON.stringify({ ready: true }),
      missionGoal: mission.goal,
    });

    expect(service.snapshot().scheduleTriggerEvents).toEqual([
      expect.objectContaining({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: "Condition check",
        status: "skipped",
        message: "No agent found for role \"missing_specialist\".",
      }),
    ]);
  });

  describe("HR-driven activation with negotiation", () => {
    let callCount: number;
    let fake: FakeLlmAdapter;

    beforeEach(() => {
      callCount = 0;
      fake = new FakeLlmAdapter((messages) => {
        callCount += 1;
        const lastMsg = messages[messages.length - 1]?.content ?? "";
        // Owner conversation: return brief JSON
        if (lastMsg.includes("补充信息") || lastMsg.includes("目标人群")) {
          return JSON.stringify({
            goal: "运营小红书账号到1000粉丝",
            scope: "小红书平台",
            constraints: ["human approval"],
            successMetrics: ["followers >= 1000"],
            keyAssumptions: ["existing account"],
          });
        }
        // HR agent: mission analysis
        if (callCount <= 3) {
          return JSON.stringify({
            requiredCapabilities: ["content_creation", "data_analysis"],
            estimatedTeamSize: 2,
            priorityRoles: ["data_analyst"],
            complexity: "medium",
            riskFactors: [],
          });
        }
        // HR agent: role specs
        return JSON.stringify([{
          name: "DataAnalyst",
          purpose: "Analyze mission metrics",
          responsibilities: ["Track KPIs", "Generate reports"],
          allowedTools: ["web_search", "data_analyzer"],
          successCriteria: ["KPIs tracked daily"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 5 },
        }]);
      });
    });

    it("starts negotiation when activating with HR and brief confirmed", async () => {
      const service = new InMemoryMissionService({ llm: fake });
      const mission = await service.createMission({
        goal: "运营小红书账号到1000粉丝",
        successMetrics: ["followers >= 1000"],
        constraints: ["1 month"],
      });
      await service.continueMission({ missionId: mission.id, message: "目标人群是年轻女性" });
      service.confirmBrief({ missionId: mission.id });

      await service.activateMissionWithHR({ missionId: mission.id });

      const snapshot = service.snapshot();
      expect(snapshot.tasks).toHaveLength(0);
      const negotiation = service.getNegotiation({ missionId: mission.id });
      expect(negotiation).toBeDefined();
      expect(negotiation!.proposal.roles.length).toBeGreaterThan(0);
    });

    it("creates team after confirming negotiation", async () => {
      const service = new InMemoryMissionService({ llm: fake });
      const mission = await service.createMission({
        goal: "运营小红书账号到1000粉丝",
        successMetrics: ["followers >= 1000"],
        constraints: ["1 month"],
      });
      await service.continueMission({ missionId: mission.id, message: "补充信息" });
      service.confirmBrief({ missionId: mission.id });
      await service.activateMissionWithHR({ missionId: mission.id });

      service.confirmNegotiation({ missionId: mission.id });

      const snapshot = service.snapshot();
      expect(snapshot.agents.filter((a) => a.missionId === mission.id).length).toBeGreaterThanOrEqual(2);
      expect(snapshot.tasks).toHaveLength(1);
    });

    it("falls back to keyword matching when no brief is confirmed", async () => {
      const service = new InMemoryMissionService({ llm: fake });
      const mission = await service.createMission({
        goal: "Create a harness learning image",
        successMetrics: ["image prompt"],
        constraints: ["concise"],
      });

      await service.activateMissionWithHR({ missionId: mission.id });

      const snapshot = service.snapshot();
      expect(snapshot.agents.filter((a) => a.missionId === mission.id).length).toBeGreaterThanOrEqual(3);
      expect(snapshot.tasks).toHaveLength(1);
      expect(service.getNegotiation({ missionId: mission.id })).toBeUndefined();
    });
  });

  describe("knowledge base", () => {
    it("should set and get knowledge entries for a mission", async () => {
      const service = new InMemoryMissionService();
      const mission = await service.createMission({ goal: "test" });

      const entry = service.setKnowledge({
        missionId: mission.id,
        key: "daily_metrics",
        value: JSON.stringify({ followers: 500 }),
        agentId: "agent_analyst",
      });

      expect(entry.missionId).toBe(mission.id);
      expect(entry.key).toBe("daily_metrics");

      const retrieved = service.getKnowledge({ missionId: mission.id, key: "daily_metrics" });
      expect(retrieved).toBeDefined();
      expect(retrieved?.value).toBe(JSON.stringify({ followers: 500 }));
    });

    it("should update existing entry when key already exists", async () => {
      const service = new InMemoryMissionService();
      const mission = await service.createMission({ goal: "test" });

      service.setKnowledge({
        missionId: mission.id,
        key: "metrics",
        value: "v1",
        agentId: "a1",
      });
      const updated = service.setKnowledge({
        missionId: mission.id,
        key: "metrics",
        value: "v2",
        agentId: "a2",
      });

      expect(updated.value).toBe("v2");
      expect(updated.sourceAgentId).toBe("a2");
      expect(service.listKnowledge({ missionId: mission.id })).toHaveLength(1);
    });

    it("should list knowledge entries for a mission", async () => {
      const service = new InMemoryMissionService();
      const mission = await service.createMission({ goal: "test" });

      service.setKnowledge({ missionId: mission.id, key: "k1", value: "v1", agentId: "a1" });
      service.setKnowledge({ missionId: mission.id, key: "k2", value: "v2", agentId: "a1" });

      const entries = service.listKnowledge({ missionId: mission.id });
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.key)).toEqual(["k1", "k2"]);
    });

    it("should include knowledge entries in snapshot", async () => {
      const service = new InMemoryMissionService();
      const mission = await service.createMission({ goal: "test" });

      service.setKnowledge({ missionId: mission.id, key: "k1", value: "v1", agentId: "a1" });

      const snapshot = service.snapshot();
      expect(snapshot.knowledgeEntries).toHaveLength(1);
      expect(snapshot.knowledgeEntries[0]?.key).toBe("k1");
    });

    it("should throw when setting knowledge for non-existent mission", async () => {
      const service = new InMemoryMissionService();
      expect(() =>
        service.setKnowledge({ missionId: "nope", key: "k", value: "v", agentId: "a" }),
      ).toThrow("Mission not found");
    });
  });

});
