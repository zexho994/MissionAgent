import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";
import { FakeLlmAdapter } from "@digitalagent/runtime";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("InMemoryMissionService", () => {
  it("creates a mission with default success metrics from config when not provided", () => {
    const service = new InMemoryMissionService();

    const mission = service.createMission({
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

  it("creates a mission with user-provided metrics and constraints", () => {
    const service = new InMemoryMissionService();

    const mission = service.createMission({
      goal: "Grow Xiaohongshu account to 1000 followers",
      successMetrics: ["followers >= 1000"],
      constraints: ["human approval before publishing"],
    });

    expect(mission.successMetrics).toEqual(["followers >= 1000"]);
    expect(mission.constraints).toEqual(["human approval before publishing"]);
  });

  it("activates a mission to create team, agents, and first task", () => {
    const service = new InMemoryMissionService();

    const mission = service.createMission({
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

  it("does not re-activate a mission that already has tasks", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({ goal: "Test goal" });
    service.activateMission({ missionId: mission.id });
    const firstTaskCount = service.snapshot().tasks.length;

    service.activateMission({ missionId: mission.id });

    expect(service.snapshot().tasks).toHaveLength(firstTaskCount);
  });

  it("keeps war room state isolated between multiple missions", () => {
    const service = new InMemoryMissionService();

    const first = service.createMission({
      goal: "First mission",
      successMetrics: ["first metric"],
      constraints: ["first constraint"],
    });
    service.activateMission({ missionId: first.id });
    const second = service.createMission({
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

  it("links worker agent activity to tasks, tool calls, and artifacts", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({ goal: "Create a harness learning image" });
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

  it("persists mission state to a local JSON file and reloads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "digitalagent-store-"));
    try {
      const storageFile = join(dir, "mission-store.json");
      const service = new InMemoryMissionService({ storageFile });
      const mission = service.createMission({ goal: "学习 harness 并生成知识图" });
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

  it("continues an existing mission conversation without creating a new mission", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({ goal: "学习 harness 并生成知识图" });
    service.activateMission({ missionId: mission.id });

    service.continueMission({
      missionId: mission.id,
      message: "图片风格要更像像素头像",
    });

    const snapshot = service.snapshot();
    expect(snapshot.missions).toHaveLength(1);
    expect(snapshot.agentMessages.some((message) => message.type === "user_message" && message.content.includes("像素头像"))).toBe(true);
    expect(snapshot.agentMessages.some((message) => message.type === "owner_followup" && message.content.includes("当前 Mission"))).toBe(true);
  });

  it("submits an execution artifact and creates a review", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({
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

  it("tracks failed executions without hiding the error", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({
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

  it("rejects artifacts with empty or missing OpenClaw output", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({
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

  it("can retry a task after reviewer requests revision", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({
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

    const mission = service.createMission({ goal: "运营小红书账号" });

    expect(mission.goal).toBe("运营小红书账号");
    expect(fake.stats().totalCalls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const messages = service.snapshot().agentMessages.filter((message) => message.missionId === mission.id);
    expect(messages.some((message) => message.type === "owner_followup" && message.content.includes("目标人群"))).toBe(true);
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

    const mission = service.createMission({ goal: "运营小红书账号" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    service.continueMission({ missionId: mission.id, message: "目标人群是年轻女性" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const snapshot = service.snapshot();
    const updatedMission = snapshot.missions.find((m) => m.id === mission.id);
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

    const mission = service.createMission({ goal: "运营小红书账号" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    service.continueMission({ missionId: mission.id, message: "补充信息" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const withBrief = service.snapshot().missions.find((m) => m.id === mission.id);
    if (!withBrief?.brief) throw new Error("brief should exist");

    const confirmed = service.confirmBrief({ missionId: mission.id });

    expect(confirmed.briefConfirmed).toBe(true);
    expect(confirmed.successMetrics).toEqual(["followers >= 1000"]);
    expect(confirmed.constraints).toEqual(["human approval"]);
  });

  it("falls back to template response when LLM is not configured", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({ goal: "运营小红书账号" });

    service.continueMission({ missionId: mission.id, message: "补充信息" });

    const messages = service.snapshot().agentMessages.filter((message) => message.missionId === mission.id);
    expect(messages.some((message) => message.type === "owner_followup" && message.content.includes("补充信息"))).toBe(true);
  });
});
