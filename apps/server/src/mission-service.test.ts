import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { createScheduleRule } from "@digitalagent/core";
import { InMemoryMissionService } from "./mission-service.js";
import { FakeLlmAdapter } from "@digitalagent/runtime";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("InMemoryMissionService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function diagnosisBriefLlm() {
    return new FakeLlmAdapter(() => JSON.stringify({
      goal: "Run a mission",
      scope: "Execution test",
      constraints: [],
      successMetrics: ["Mission is runnable"],
      keyAssumptions: [],
    }));
  }

  function missionPlanJson(goal = "Run a mission") {
    return JSON.stringify({
      goal,
      successMetrics: ["Mission is runnable"],
      phases: [
        {
          name: "Launch",
          objective: "Start execution cleanly",
          deliverables: ["Initial task plan"],
          successCriteria: ["Execution can start"],
        },
      ],
      workstreams: [
        {
          name: "Execution",
          objective: "Deliver mission output",
          requiredRole: "researcher",
          responsibilities: ["Run the first task"],
          firstTaskGoal: "Complete the first task",
        },
      ],
      reportingLines: [
        {
          fromRole: "researcher",
          toRole: "owner",
          cadence: "daily",
          purpose: "Progress reporting",
        },
      ],
      scheduleRhythms: [
        {
          name: "Daily check",
          cadence: "daily",
          ownerRole: "owner",
          purpose: "Review execution status",
        },
      ],
      risks: ["Runner may be unavailable"],
      checkpoints: ["First task completed"],
    });
  }

  function diagnosisLlmWithPlan() {
    return new FakeLlmAdapter((messages) => {
      if (messages[0]?.content.includes("Owner planning workflow")) {
        return missionPlanJson();
      }
      return JSON.stringify({
        goal: "Run a mission",
        scope: "Execution test",
        constraints: [],
        successMetrics: ["Mission is runnable"],
        keyAssumptions: [],
      });
    });
  }

  async function waitForBrief(service: InMemoryMissionService, missionId: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const mission = service.snapshot().missions.find((candidate) => candidate.id === missionId);
      if (mission?.brief) return mission;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("brief should exist");
  }

  async function createConfirmedMission(service: InMemoryMissionService) {
    const mission = await service.createMission({ goal: "Run a mission" });
    await service.continueMission({
      missionId: mission.id,
      message: "Audience is developers. Timeline is one month.",
    });
    await waitForBrief(service, mission.id);
    service.confirmBrief({ missionId: mission.id });
    return mission;
  }

  async function createConfirmedActivatedMission(service: InMemoryMissionService) {
    const mission = await createConfirmedMission(service);
    service.activateMission({ missionId: mission.id });
    return mission;
  }

  async function confirmPlanForMission(service: InMemoryMissionService, missionId: string) {
    const plan = await service.generateMissionPlan({ missionId });
    service.confirmMissionPlan({ missionId, planId: plan.id });
    return plan;
  }

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
    const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
    const mission = await createConfirmedMission(service);
    await confirmPlanForMission(service, mission.id);

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

  it("creates outcome evaluation when execution result is approved", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.submitExecutionResult({
      missionId: mission.id,
      taskId: task!.id,
      executionId: execution.id,
      content: {
        openclaw: {
          payloads: [{ text: "Grow a GitHub repository with next actions for repository growth and review cadence" }],
        },
      },
      evidence: ["openclaw:local"],
    });

    const snapshot = service.snapshot();
    expect(snapshot.missionOutcomeEvaluations).toHaveLength(1);
    expect(snapshot.missionOutcomeEvaluations[0]).toMatchObject({
      missionId: mission.id,
      taskId: task!.id,
      source: "execution_result",
      outcome: "advanced",
    });
    expect(snapshot.taskFailureAnalyses).toHaveLength(0);
    expect(snapshot.knowledgeEntries.some((entry) => entry.key.startsWith("feedback:"))).toBe(true);
  });

  it("creates failure analysis when execution result is rejected", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.submitExecutionResult({
      missionId: mission.id,
      taskId: task!.id,
      executionId: execution.id,
      content: { openclaw: "" },
      evidence: ["openclaw:local"],
    });

    const snapshot = service.snapshot();
    expect(snapshot.missionOutcomeEvaluations).toHaveLength(1);
    expect(snapshot.taskFailureAnalyses).toHaveLength(1);
    expect(snapshot.taskFailureAnalyses[0]).toMatchObject({
      missionId: mission.id,
      taskId: task!.id,
      failureType: "low_quality_output",
    });
  });

  it("creates blocked feedback when execution fails", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({
      executionId: execution.id,
      error: "OpenClaw timed out",
    });

    const snapshot = service.snapshot();
    expect(snapshot.missionOutcomeEvaluations).toHaveLength(1);
    expect(snapshot.missionOutcomeEvaluations[0]?.outcome).toBe("blocked");
    expect(snapshot.taskFailureAnalyses).toHaveLength(1);
    expect(snapshot.taskFailureAnalyses[0]?.failureType).toBe("execution_error");
  });

  it("persists and restores feedback records", async () => {
    const storageFile = join(tmpdir(), `digitalagent-feedback-${Date.now()}.json`);
    const service = new InMemoryMissionService({ storageFile });
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({
      executionId: execution.id,
      error: "OpenClaw timed out",
    });

    const reloaded = new InMemoryMissionService({ storageFile });
    expect(reloaded.snapshot().missionOutcomeEvaluations).toHaveLength(1);
    expect(reloaded.snapshot().taskFailureAnalyses).toHaveLength(1);
  });

  it("returns feedback summary with latest records and counts", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({
      executionId: execution.id,
      error: "OpenClaw timed out",
    });

    expect(service.getFeedbackSummary(mission.id)).toMatchObject({
      missionId: mission.id,
      counts: {
        evaluations: 1,
        failureAnalyses: 1,
        strategyAdjustments: 0,
      },
    });
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

  it("diagnoses a new mission as briefing", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow GitHub repositories" });

    expect(service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true })).toMatchObject({
      missionId: mission.id,
      stage: "briefing",
      ready: false,
      signals: {
        briefConfirmed: false,
        hasPlan: false,
        teamReady: false,
        hasInitialTasks: false,
        hasExecutionRunner: true,
        hasScheduleRules: false,
        hasRunningExecution: false,
      },
    });
    expect(service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true }).blockers).toEqual([
      expect.objectContaining({ code: "brief_not_confirmed" }),
    ]);
  });

  it("diagnoses a brief-confirmed mission without plan as missing_plan", async () => {
    const service = new InMemoryMissionService({
      llm: new FakeLlmAdapter(() => JSON.stringify({
        goal: "Grow GitHub repositories",
        scope: "GitHub growth",
        constraints: ["one month"],
        successMetrics: ["two repositories exceed 1k stars"],
        keyAssumptions: ["developer audience"],
      })),
    });
    const mission = await createConfirmedMission(service);

    const diagnosis = service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true });

    expect(diagnosis.stage).toBe("missing_plan");
    expect(diagnosis.blockers[0]).toMatchObject({
      code: "mission_plan_missing",
    });
  });

  describe("MissionPlan", () => {
    it("generates and stores a draft MissionPlan only after brief confirmation", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);

      const plan = await service.generateMissionPlan({ missionId: mission.id });

      expect(plan.status).toBe("draft");
      expect(plan.revision).toBe(1);
      expect(plan.createdAt).toBeInstanceOf(Date);
      expect(plan.goal).toBe("Run a mission");
      expect(service.snapshot().plans).toEqual([plan]);
      expect(service.getMissionPlan({ missionId: mission.id, planId: plan.id })).toEqual(plan);
      const owner = service.snapshot().agents.find((agent) => agent.missionId === mission.id && agent.role === "owner");
      const planMessages = service.snapshot().agentMessages.filter(
        (message) => message.missionId === mission.id && message.type === "task_plan",
      );
      expect(planMessages).toHaveLength(1);
      expect(planMessages[0]).toMatchObject({
        fromAgentId: owner?.id,
        content: "Owner generated MissionPlan revision 1.",
      });
      expect(planMessages[0]?.id).toEqual(expect.any(String));
    });

    it("returns the latest draft MissionPlan when no plan has been confirmed", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);

      const plan = await service.generateMissionPlan({ missionId: mission.id });

      expect(service.getMissionPlan({ missionId: mission.id })).toEqual(plan);
    });

    it("uses a larger LLM budget for MissionPlan generation", async () => {
      const fake = new FakeLlmAdapter((messages) => {
        if (messages[0]?.content.includes("Owner planning workflow")) return missionPlanJson("Run a mission");
        return JSON.stringify({
          goal: "Run a mission",
          scope: "Execution test",
          constraints: [],
          successMetrics: ["Mission is runnable"],
          keyAssumptions: [],
        });
      });
      const service = new InMemoryMissionService({ llm: fake });
      const mission = await createConfirmedMission(service);

      await service.generateMissionPlan({ missionId: mission.id });

      expect(fake.getLastOptions()).toMatchObject({
        maxTokens: 3000,
        timeoutMs: 90000,
      });
    });

    it("fails fast when plan generation prerequisites or parser output are invalid", async () => {
      const noLlmService = new InMemoryMissionService();
      const mission = await noLlmService.createMission({ goal: "Run a mission" });
      (mission as any).brief = {
        goal: "Run a mission",
        scope: "Execution test",
        constraints: [],
        successMetrics: ["Mission is runnable"],
        keyAssumptions: [],
      };
      (mission as any).briefConfirmed = true;
      await expect(noLlmService.generateMissionPlan({ missionId: mission.id })).rejects.toThrow("LLM is required");

      const unconfirmed = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const unconfirmedMission = await unconfirmed.createMission({ goal: "Run a mission" });
      await waitForBrief(unconfirmed, unconfirmedMission.id);
      await expect(unconfirmed.generateMissionPlan({ missionId: unconfirmedMission.id })).rejects.toThrow(
        "MissionBrief must be confirmed",
      );

      const badLlm = new InMemoryMissionService({
        llm: new FakeLlmAdapter((messages) => {
          if (messages[0]?.content.includes("Owner planning workflow")) return "plain text";
          return JSON.stringify({
            goal: "Run a mission",
            scope: "Execution test",
            constraints: [],
            successMetrics: ["Mission is runnable"],
            keyAssumptions: [],
          });
        }),
      });
      const badMission = await createConfirmedMission(badLlm);
      await expect(badLlm.generateMissionPlan({ missionId: badMission.id })).rejects.toThrow(
        "No JSON object found in LLM response",
      );
      expect(badLlm.snapshot().plans).toHaveLength(0);
    });

    it("supersedes existing drafts when generating a new draft", async () => {
      let planCount = 0;
      const service = new InMemoryMissionService({
        llm: new FakeLlmAdapter((messages) => {
          if (messages[0]?.content.includes("Owner planning workflow")) {
            planCount += 1;
            return missionPlanJson(`Run a mission revision ${planCount}`);
          }
          return JSON.stringify({
            goal: "Run a mission",
            scope: "Execution test",
            constraints: [],
            successMetrics: ["Mission is runnable"],
            keyAssumptions: [],
          });
        }),
      });
      const mission = await createConfirmedMission(service);

      const first = await service.generateMissionPlan({ missionId: mission.id });
      const second = await service.generateMissionPlan({ missionId: mission.id, feedback: "Make it sharper" });

      expect(second.revision).toBe(2);
      expect(second.feedback).toBe("Make it sharper");
      expect(service.getMissionPlan({ missionId: mission.id, planId: first.id })?.status).toBe("superseded");
      expect(service.getMissionPlan({ missionId: mission.id, planId: second.id })?.status).toBe("draft");
    });

    it("confirms a draft plan, sets the mission pointer, and supersedes older confirmed plans", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);
      const first = await service.generateMissionPlan({ missionId: mission.id });
      service.confirmMissionPlan({ missionId: mission.id, planId: first.id });
      const second = await service.generateMissionPlan({ missionId: mission.id, feedback: "Revise after review" });
      service.confirmMissionPlan({ missionId: mission.id, planId: second.id });
      const confirmedSecond = service.getMissionPlan({ missionId: mission.id, planId: second.id });

      expect(service.getMissionPlan({ missionId: mission.id, planId: first.id })?.confirmedAt).toBeInstanceOf(Date);
      expect(confirmedSecond?.status).toBe("confirmed");
      expect(service.getMissionPlan({ missionId: mission.id, planId: first.id })?.status).toBe("superseded");
      expect(service.snapshot().missions.find((candidate) => candidate.id === mission.id)?.confirmedPlanId).toBe(
        second.id,
      );
      expect(service.getMissionPlan({ missionId: mission.id })).toEqual(confirmedSecond);
    });

    it("returns a newer draft as the current MissionPlan after a confirmed plan is revised", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);
      const confirmed = await service.generateMissionPlan({ missionId: mission.id });
      service.confirmMissionPlan({ missionId: mission.id, planId: confirmed.id });

      const revision = await service.generateMissionPlan({ missionId: mission.id, feedback: "Revise after review" });

      expect(service.getMissionPlan({ missionId: mission.id })).toEqual(revision);
      expect(service.getMissionPlan({ missionId: mission.id, planId: confirmed.id })?.status).toBe("confirmed");
    });

    it("fails fast when confirming a non-draft MissionPlan", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);
      const plan = await service.generateMissionPlan({ missionId: mission.id });
      service.confirmMissionPlan({ missionId: mission.id, planId: plan.id });

      expect(() => service.confirmMissionPlan({ missionId: mission.id, planId: plan.id })).toThrow(
        "Only draft MissionPlan can be confirmed",
      );
    });

    it("returns the updated Mission after confirming a MissionPlan", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);
      const plan = await service.generateMissionPlan({ missionId: mission.id });

      const updatedMission = service.confirmMissionPlan({ missionId: mission.id, planId: plan.id });

      expect(updatedMission.id).toBe(mission.id);
      expect(updatedMission.confirmedPlanId).toBe(plan.id);
    });

    it("persists and reloads plans with Date fields intact", async () => {
      const dir = mkdtempSync(join(tmpdir(), "digitalagent-plan-store-"));
      try {
        const storageFile = join(dir, "mission-store.json");
        const service = new InMemoryMissionService({ storageFile, llm: diagnosisLlmWithPlan() });
        const mission = await createConfirmedMission(service);
        const plan = await service.generateMissionPlan({ missionId: mission.id });
        service.confirmMissionPlan({ missionId: mission.id, planId: plan.id });

        const reloaded = new InMemoryMissionService({ storageFile });
        const reloadedPlan = reloaded.getMissionPlan({ missionId: mission.id });

        expect(reloadedPlan?.createdAt).toBeInstanceOf(Date);
        expect(reloadedPlan?.confirmedAt).toBeInstanceOf(Date);
        expect(reloaded.snapshot().plans[0]?.id).toBe(plan.id);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails fast when confirmedPlanId points at a corrupt missing plan", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);
      const plan = await service.generateMissionPlan({ missionId: mission.id });
      service.confirmMissionPlan({ missionId: mission.id, planId: plan.id });
      (service.snapshot().missions.find((candidate) => candidate.id === mission.id) as any).confirmedPlanId = "plan_missing";

      expect(() => service.getMissionPlan({ missionId: mission.id })).toThrow("Confirmed MissionPlan not found");
    });

    it("returns a newer draft instead of a corrupt confirmedPlanId when the draft supersedes it", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);
      const plan = await service.generateMissionPlan({ missionId: mission.id });
      service.confirmMissionPlan({ missionId: mission.id, planId: plan.id });
      const revision = await service.generateMissionPlan({ missionId: mission.id, feedback: "Revise after review" });
      (service.snapshot().missions.find((candidate) => candidate.id === mission.id) as any).confirmedPlanId = "plan_missing";

      expect(service.getMissionPlan({ missionId: mission.id })).toEqual(revision);
    });

    it("keeps hasPlan false for confirmed draft and true only for confirmed MissionPlan state", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);
      const draft = await service.generateMissionPlan({ missionId: mission.id });

      expect(service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true }).signals.hasPlan).toBe(false);

      service.confirmMissionPlan({ missionId: mission.id, planId: draft.id });

      expect(service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true }).signals.hasPlan).toBe(true);
    });

    it("treats a newer draft revision as missing_plan until it is confirmed", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);
      const confirmed = await service.generateMissionPlan({ missionId: mission.id });
      service.confirmMissionPlan({ missionId: mission.id, planId: confirmed.id });

      const revision = await service.generateMissionPlan({ missionId: mission.id, feedback: "Revise after review" });
      const draftDiagnosis = service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true });

      expect(draftDiagnosis.stage).toBe("missing_plan");
      expect(draftDiagnosis.signals.hasPlan).toBe(false);

      service.confirmMissionPlan({ missionId: mission.id, planId: revision.id });

      expect(service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true }).signals.hasPlan).toBe(true);
    });

    it("fails HR activation fast when no current confirmed MissionPlan exists", async () => {
      const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
      const mission = await createConfirmedMission(service);
      const plan = await service.generateMissionPlan({ missionId: mission.id });
      service.confirmMissionPlan({ missionId: mission.id, planId: plan.id });
      await service.generateMissionPlan({ missionId: mission.id, feedback: "Revise before activation" });

      await expect(service.activateMissionWithHR({ missionId: mission.id })).rejects.toThrow(
        "Mission requires a confirmed MissionPlan before activation",
      );
      expect(() => service.beginMissionActivation({ missionId: mission.id })).toThrow(
        "Mission requires a confirmed MissionPlan before activation",
      );
      expect(service.snapshot().tasks.filter((task) => task.missionId === mission.id)).toHaveLength(0);
    });
  });

  it("keeps missing plan ahead of running execution state", async () => {
    const service = new InMemoryMissionService({
      llm: new FakeLlmAdapter(() => JSON.stringify({
        goal: "Run a mission",
        scope: "Execution test",
        constraints: [],
        successMetrics: ["Mission is runnable"],
        keyAssumptions: [],
      })),
    });
    const mission = await createConfirmedActivatedMission(service);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    service.startExecution({ missionId: mission.id, taskId: task!.id });

    const diagnosis = service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true });

    expect(diagnosis.stage).toBe("missing_plan");
    expect(diagnosis.blockers).toEqual([
      expect.objectContaining({ code: "mission_plan_missing" }),
    ]);
  });

  it("keeps missing plan ahead of failed execution blockers", async () => {
    const service = new InMemoryMissionService({
      llm: new FakeLlmAdapter(() => JSON.stringify({
        goal: "Run a mission",
        scope: "Execution test",
        constraints: [],
        successMetrics: ["Mission is runnable"],
        keyAssumptions: [],
      })),
    });
    const mission = await createConfirmedActivatedMission(service);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });
    service.failExecution({ executionId: execution.id, error: "runner unavailable" });

    const diagnosis = service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true });

    expect(diagnosis.stage).toBe("missing_plan");
    expect(diagnosis.blockers).toEqual([
      expect.objectContaining({ code: "mission_plan_missing" }),
    ]);
  });

  it("diagnoses running and blocked states only after prerequisite gates are ready", async () => {
    const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
    const runningMission = await createConfirmedActivatedMission(service);
    await confirmPlanForMission(service, runningMission.id);
    addOwnerDailyRule(service, runningMission.id);
    const runningTask = service.snapshot().tasks.find((candidate) => candidate.missionId === runningMission.id);
    expect(runningTask).toBeDefined();
    service.startExecution({ missionId: runningMission.id, taskId: runningTask!.id });

    expect(service.getAutopilotDiagnosis(runningMission.id, { hasExecutionRunner: true }).stage).toBe("running");

    const blockedMission = await createConfirmedActivatedMission(service);
    await confirmPlanForMission(service, blockedMission.id);
    addOwnerDailyRule(service, blockedMission.id);
    const blockedTask = service.snapshot().tasks.find((candidate) => candidate.missionId === blockedMission.id);
    expect(blockedTask).toBeDefined();
    const execution = service.startExecution({ missionId: blockedMission.id, taskId: blockedTask!.id });
    service.failExecution({ executionId: execution.id, error: "runner unavailable" });

    const blockedDiagnosis = service.getAutopilotDiagnosis(blockedMission.id, { hasExecutionRunner: true });
    expect(blockedDiagnosis.stage).toBe("blocked");
    expect(blockedDiagnosis.blockers).toEqual([
      expect.objectContaining({ code: "execution_blocked" }),
    ]);
  });

  it("fails fast when autopilot runtime signals are missing", async () => {
    const service = new InMemoryMissionService({ llm: diagnosisBriefLlm() });
    const mission = await createConfirmedMission(service);

    expect(() => service.getAutopilotDiagnosis(mission.id, {} as any)).toThrow(
      "Autopilot runtime signal hasExecutionRunner must be boolean",
    );
  });

  it("diagnoses missing execution runner when executable tasks exist", async () => {
    const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
    const mission = await createConfirmedActivatedMission(service);
    await confirmPlanForMission(service, mission.id);

    const diagnosis = service.getAutopilotDiagnosis(mission.id, {
      hasExecutionRunner: false,
    });

    expect(diagnosis.stage).toBe("missing_execution_runner");
    expect(diagnosis.blockers.some((blocker) => blocker.code === "execution_runner_missing")).toBe(true);
  });

  it("diagnoses missing schedule after earlier blockers are cleared", async () => {
    const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
    const mission = await createConfirmedActivatedMission(service);
    await confirmPlanForMission(service, mission.id);

    const diagnosis = service.getAutopilotDiagnosis(mission.id, {
      hasExecutionRunner: true,
    });

    expect(diagnosis.stage).toBe("missing_schedule");
    expect(diagnosis.blockers.some((blocker) => blocker.code === "schedule_rules_missing")).toBe(true);
  });

  it("does not keep diagnosis blocked after a failed task is retried successfully", async () => {
    const service = new InMemoryMissionService({ llm: diagnosisLlmWithPlan() });
    const mission = await createConfirmedActivatedMission(service);
    await confirmPlanForMission(service, mission.id);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const firstExecution = service.startExecution({ missionId: mission.id, taskId: task!.id });
    service.failExecution({ executionId: firstExecution.id, error: "runner unavailable" });
    const retryExecution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.submitExecutionResult({
      executionId: retryExecution.id,
      missionId: mission.id,
      taskId: task!.id,
      content: {
        openclaw: {
          payloads: [{ text: "Mission is runnable and execution completed successfully" }],
        },
      },
      evidence: ["openclaw:local"],
    });

    const diagnosis = service.getAutopilotDiagnosis(mission.id, {
      hasExecutionRunner: true,
    });

    expect(diagnosis.stage).not.toBe("blocked");
    expect(diagnosis.blockers.some((blocker) => blocker.code === "execution_blocked")).toBe(false);
  });

  it("does not treat a blocked owner as an execution blocker", async () => {
    const failingLlm = {
      call: async () => { throw new Error("LLM unavailable"); },
      stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
    };
    const service = new InMemoryMissionService({ llm: failingLlm as any });
    const mission = await service.createMission({ goal: "Grow GitHub repositories" });
    await Promise.resolve();

    const diagnosis = service.getAutopilotDiagnosis(mission.id, {
      hasExecutionRunner: true,
    });

    expect(diagnosis.stage).toBe("briefing");
    expect(diagnosis.blockers.some((blocker) => blocker.code === "execution_blocked")).toBe(false);
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

  function addCronRule(
    service: InMemoryMissionService,
    missionId: string,
    input: { name: string; expression: string; title: string; assigneeRole?: string },
  ) {
    const rule = createScheduleRule({
      name: input.name,
      missionId,
      enabled: true,
      trigger: { type: "cron", expression: input.expression, timezone: "UTC" },
      taskTemplate: {
        title: input.title,
        contract: {
          objective: input.title,
          input: {},
          outputSchema: {},
          successCriteria: ["Scheduled task is created"],
        },
        assigneeRole: input.assigneeRole ?? "owner",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
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

  it("returns an empty automation summary when a mission has no schedule rules", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    expect(service.getAutomationSummary(mission.id)).toEqual({
      missionId: mission.id,
      rulesCount: 0,
      automationPaused: false,
      currentScheduledTasks: [],
    });
  });

  it("returns the next cron action in the automation summary", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: {},
          outputSchema: {},
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "owner",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
    });
    service.addScheduleRule(mission.id, rule);

    const summary = service.getAutomationSummary(mission.id);

    expect(summary.rulesCount).toBe(1);
    expect(summary.nextAction).toEqual({
      ruleId: rule.id,
      ruleName: "Daily check",
      nextRunAt: expect.any(String),
      assigneeRole: "owner",
      assigneeAgentId: expect.stringMatching(/^agent_/),
      taskTitle: "Check yesterday's GitHub growth metrics",
    });
  });

  it("includes current scheduled tasks and the latest trigger event in the automation summary", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: {},
          outputSchema: {},
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "owner",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
    });
    service.addScheduleRule(mission.id, rule);
    service.triggerScheduleRule(mission.id, rule.id);

    const summary = service.getAutomationSummary(mission.id);

    expect(summary.currentScheduledTasks).toEqual([
      {
        taskId: expect.stringMatching(/^task_/),
        ruleId: rule.id,
        title: "Check yesterday's GitHub growth metrics",
        status: "draft",
        assigneeAgentId: expect.stringMatching(/^agent_/),
      },
    ]);
    expect(summary.lastTrigger).toEqual({
      ruleId: rule.id,
      ruleName: "Daily check",
      taskId: expect.stringMatching(/^task_/),
      status: "created",
      message: "Scheduled task \"Check yesterday's GitHub growth metrics\" created.",
      createdAt: expect.any(String),
    });
  });

  it("triggerNextScheduleRule creates a task from the nearest enabled cron rule", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: {},
          outputSchema: {},
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "owner",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
    });
    service.addScheduleRule(mission.id, rule);

    const task = service.triggerNextScheduleRule(mission.id);

    expect(task.scheduleRuleId).toBe(rule.id);
    expect(task.title).toBe("Check yesterday's GitHub growth metrics");
    expect(service.getAutomationSummary(mission.id).lastTrigger?.status).toBe("created");
  });

  it("triggerNextScheduleRule chooses the earliest overdue cron rule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    addCronRule(service, mission.id, {
      name: "Late overdue check",
      expression: "0 10 * * *",
      title: "Run the later overdue check",
    });
    const earliest = addCronRule(service, mission.id, {
      name: "Early overdue check",
      expression: "0 9 * * *",
      title: "Run the earliest overdue check",
    });
    vi.setSystemTime(new Date("2026-04-30T11:00:00Z"));

    const task = service.triggerNextScheduleRule(mission.id);

    expect(task.scheduleRuleId).toBe(earliest.id);
    expect(task.title).toBe("Run the earliest overdue check");
  });

  it("triggerNextScheduleRule chooses the nearest future cron rule when none are overdue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    addCronRule(service, mission.id, {
      name: "Noon check",
      expression: "0 12 * * *",
      title: "Run the noon check",
    });
    const nearest = addCronRule(service, mission.id, {
      name: "Morning check",
      expression: "0 9 * * *",
      title: "Run the morning check",
    });
    vi.setSystemTime(new Date("2026-04-30T08:00:00Z"));

    const task = service.triggerNextScheduleRule(mission.id);

    expect(task.scheduleRuleId).toBe(nearest.id);
    expect(task.title).toBe("Run the morning check");
  });

  it("triggerNextScheduleRule rejects missions without enabled cron rules", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    expect(() => service.triggerNextScheduleRule(mission.id)).toThrow("No enabled cron schedule rule available");
  });

  it("triggerNextScheduleRule rejects missing assignee agents", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: {},
          outputSchema: {},
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "data_analyst",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
    });
    service.addScheduleRule(mission.id, rule);

    expect(() => service.triggerNextScheduleRule(mission.id)).toThrow('No agent found for role "data_analyst"');
  });

  it("triggerNextScheduleRule rejects rules already at max concurrency", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    addCronRule(service, mission.id, {
      name: "Daily check",
      expression: "0 9 * * *",
      title: "Check yesterday's GitHub growth metrics",
    });

    service.triggerNextScheduleRule(mission.id);
    vi.setSystemTime(new Date("2026-04-30T00:00:01Z"));

    expect(() => service.triggerNextScheduleRule(mission.id)).toThrow(
      "Schedule rule is already at max concurrency",
    );
    expect(service.getAutomationSummary(mission.id).lastTrigger).toEqual(
      expect.objectContaining({
        status: "failed",
        message: "Schedule rule is already at max concurrency.",
      }),
    );
  });

  it("triggerNextScheduleRule persists failed trigger events for missing assignee agents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digitalagent-trigger-next-failed-"));
    try {
      const storageFile = join(dir, "mission-store.json");
      const service = new InMemoryMissionService({ storageFile });
      const mission = await service.createMission({ goal: "Track GitHub growth" });
      const rule = addCronRule(service, mission.id, {
        name: "Daily analyst check",
        expression: "0 9 * * *",
        title: "Check yesterday's GitHub growth metrics",
        assigneeRole: "data_analyst",
      });

      expect(() => service.triggerNextScheduleRule(mission.id)).toThrow('No agent found for role "data_analyst"');

      const reloaded = new InMemoryMissionService({ storageFile });
      expect(reloaded.snapshot().scheduleTriggerEvents).toEqual([
        expect.objectContaining({
          missionId: mission.id,
          ruleId: rule.id,
          ruleName: "Daily analyst check",
          status: "failed",
          message: 'No agent found for role "data_analyst".',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("creates a daily schedule rule from a lightweight template", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    const rule = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "daily_check",
      assigneeRole: "owner",
      taskGoal: "Check yesterday's GitHub growth metrics",
    });

    expect(rule.trigger).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "UTC" });
    expect(rule.taskTemplate.title).toBe("Check yesterday's GitHub growth metrics");
    expect(rule.taskTemplate.contract.objective).toBe("Check yesterday's GitHub growth metrics");
    expect(rule.metadata).toEqual({ createdBy: "user_template", templateType: "daily_check" });
  });

  it("creates a weekly schedule rule from a lightweight template", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    const rule = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "weekly_review",
      assigneeRole: "owner",
      taskGoal: "Review weekly GitHub growth and plan next actions",
    });

    expect(rule.trigger).toEqual({ type: "cron", expression: "0 9 * * 1", timezone: "UTC" });
    expect(rule.name).toBe("Weekly review");
  });

  it("creates a condition schedule rule from a lightweight template", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    const rule = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "condition_response",
      sourceAgentRole: "owner",
      condition: "Stars dropped for two consecutive days",
      responseAssigneeRole: "owner",
      responseTaskGoal: "Diagnose the drop and recommend a correction",
    });

    expect(rule.trigger).toEqual({
      type: "condition",
      description: "Stars dropped for two consecutive days",
      sourceAgentRole: "owner",
      evaluatePrompt: "Return true when this condition is met: Stars dropped for two consecutive days",
    });
    expect(rule.taskTemplate.assigneeRole).toBe("owner");
    expect(rule.taskTemplate.title).toBe("Diagnose the drop and recommend a correction");
  });

  it("rejects unsupported biweekly template explicitly", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    expect(() =>
      service.createScheduleRuleFromTemplate(mission.id, {
        templateType: "biweekly_review",
        assigneeRole: "owner",
        taskGoal: "Review every two weeks",
      } as never),
    ).toThrow("Unsupported schedule template: biweekly_review");
  });

  it("pauses and resumes only automation-toggle-paused rules", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const enabled = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "daily_check",
      assigneeRole: "owner",
      taskGoal: "Check yesterday's GitHub growth metrics",
    });
    const manuallyDisabled = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "weekly_review",
      assigneeRole: "owner",
      taskGoal: "Review weekly GitHub growth",
    });
    service.updateScheduleRule(mission.id, manuallyDisabled.id, { enabled: false });

    service.pauseMissionAutomation(mission.id);

    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === enabled.id)?.enabled).toBe(false);
    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === enabled.id)?.metadata.pausedByAutomationToggle).toBe(true);
    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === manuallyDisabled.id)?.metadata.pausedByAutomationToggle).toBeUndefined();
    expect(service.getAutomationSummary(mission.id).automationPaused).toBe(true);

    service.resumeMissionAutomation(mission.id);

    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === enabled.id)?.enabled).toBe(true);
    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === enabled.id)?.metadata.pausedByAutomationToggle).toBeUndefined();
    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === manuallyDisabled.id)?.enabled).toBe(false);
  });

  it("pauses and resumes template rules created while automation is paused", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "daily_check",
      assigneeRole: "owner",
      taskGoal: "Check yesterday's GitHub growth metrics",
    });

    service.pauseMissionAutomation(mission.id);
    const createdWhilePaused = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "weekly_review",
      assigneeRole: "owner",
      taskGoal: "Review weekly GitHub growth",
    });

    expect(createdWhilePaused.enabled).toBe(false);
    expect(createdWhilePaused.metadata.pausedByAutomationToggle).toBe(true);
    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === createdWhilePaused.id)).toEqual(
      expect.objectContaining({
        enabled: false,
        metadata: expect.objectContaining({ pausedByAutomationToggle: true }),
      }),
    );
    expect(service.getAutomationSummary(mission.id).automationPaused).toBe(true);

    service.resumeMissionAutomation(mission.id);

    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === createdWhilePaused.id)).toEqual(
      expect.objectContaining({
        enabled: true,
        metadata: expect.not.objectContaining({ pausedByAutomationToggle: true }),
      }),
    );
  });

  it("does not resume rules manually disabled while automation-toggle paused", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "daily_check",
      assigneeRole: "owner",
      taskGoal: "Check yesterday's GitHub growth metrics",
    });

    service.pauseMissionAutomation(mission.id);
    service.updateScheduleRule(mission.id, rule.id, { enabled: false });
    service.resumeMissionAutomation(mission.id);

    const updated = service.getScheduleRules(mission.id).find((candidate) => candidate.id === rule.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.metadata.pausedByAutomationToggle).toBeUndefined();
  });

  it("does not start automation-toggle schedulers for inactive missions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T08:00:00Z"));
    const dir = mkdtempSync(join(tmpdir(), "digitalagent-inactive-automation-"));
    try {
      const storageFile = join(dir, "mission-store.json");
      const initial = new InMemoryMissionService({ storageFile });
      const mission = await initial.createMission({ goal: "Track GitHub growth" });
      const stored = initial.snapshot();
      stored.missions = stored.missions.map((candidate) =>
        candidate.id === mission.id ? { ...candidate, status: "paused" } : candidate,
      );
      rmSync(storageFile, { force: true });
      const inactiveStore = {
        schemaVersion: 1,
        ...stored,
      };
      writeFileSync(storageFile, `${JSON.stringify(inactiveStore, null, 2)}\n`, "utf8");
      const service = new InMemoryMissionService({ storageFile });
      service.createScheduleRuleFromTemplate(mission.id, {
        templateType: "daily_check",
        assigneeRole: "owner",
        taskGoal: "Check yesterday's GitHub growth metrics",
      });

      service.pauseMissionAutomation(mission.id);
      service.resumeMissionAutomation(mission.id);
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(service.snapshot().tasks).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("HR-driven activation with negotiation", () => {
    let callCount: number;
    let fake: FakeLlmAdapter;

    beforeEach(() => {
      callCount = 0;
      fake = new FakeLlmAdapter((messages) => {
        callCount += 1;
        const lastMsg = messages[messages.length - 1]?.content ?? "";
        if (messages[0]?.content.includes("Owner planning workflow")) {
          return missionPlanJson();
        }
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
      await confirmPlanForMission(service, mission.id);

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
      await confirmPlanForMission(service, mission.id);
      await service.activateMissionWithHR({ missionId: mission.id });

      service.confirmNegotiation({ missionId: mission.id });

      const snapshot = service.snapshot();
      expect(snapshot.agents.filter((a) => a.missionId === mission.id).length).toBeGreaterThanOrEqual(2);
      expect(snapshot.tasks).toHaveLength(1);
    });

    it("fails fast when HR activation has no confirmed MissionPlan", async () => {
      const service = new InMemoryMissionService({ llm: fake });
      const mission = await service.createMission({
        goal: "Create a harness learning image",
        successMetrics: ["image prompt"],
        constraints: ["concise"],
      });

      await expect(service.activateMissionWithHR({ missionId: mission.id })).rejects.toThrow(
        "Mission requires a confirmed MissionPlan before activation",
      );

      const snapshot = service.snapshot();
      expect(snapshot.tasks).toHaveLength(0);
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
