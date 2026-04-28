import { describe, expect, it } from "vitest";
import { handleApiRequest } from "./api.js";
import { InMemoryMissionService } from "./mission-service.js";
import type { OpenClawCliAdapter } from "@digitalagent/runtime";
import type { MissionSnapshot } from "./mission-service.js";

function fakeOpenClaw(): Pick<OpenClawCliAdapter, "health" | "runAgentTask"> {
  return {
    async health() {
      return { available: true, version: "test-openclaw" };
    },
    async runAgentTask() {
      return {
        status: "completed",
        output: { text: "team plan generated" },
        stderr: "",
      };
    },
  };
}

describe("handleApiRequest", () => {
  it("returns health with OpenClaw status and current snapshot counts", async () => {
    const response = await handleApiRequest(
      { method: "GET", path: "/api/health" },
      { missions: new InMemoryMissionService(), openclaw: fakeOpenClaw() },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
        ok: true,
        openclaw: { available: true, version: "test-openclaw" },
        counts: { missions: 0, tasks: 0, artifacts: 0, reviews: 0, executions: 0 },
      });
  });

  it("creates a mission with default metrics when not provided", async () => {
    const missions = new InMemoryMissionService();

    const createResponse = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions",
        body: { goal: "学习 harness 并生成知识图" },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(createResponse.status).toBe(201);
    const snapshot = missions.snapshot();
    expect(snapshot.missions).toHaveLength(1);
    expect(snapshot.missions[0]?.successMetrics).toContain("目标结果已经被 Owner 明确");
  });

  it("creates a mission with user-provided metrics and activates it", async () => {
    const missions = new InMemoryMissionService();

    const createResponse = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions",
        body: {
          goal: "Grow Xiaohongshu account to 1000 followers",
          successMetrics: ["followers >= 1000"],
          constraints: ["human approval before publishing"],
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(createResponse.status).toBe(201);
    expect(missions.snapshot().missions[0]?.successMetrics).toEqual(["followers >= 1000"]);

    const activateResponse = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions/activate",
        body: { missionId: missions.snapshot().missions[0]?.id },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(activateResponse.status).toBe(200);
    expect(missions.snapshot().tasks).toHaveLength(1);
  });

  it("continues an existing mission instead of creating a new one", async () => {
    const missions = new InMemoryMissionService();
    const mission = missions.createMission({ goal: "学习 harness 并生成知识图" });
    missions.activateMission({ missionId: mission.id });

    const response = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions/continue",
        body: {
          missionId: mission.id,
          message: "补充：头像要更像参考图",
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(response.status).toBe(200);
    const snapshot = missions.snapshot();
    expect(snapshot.missions).toHaveLength(1);
    expect(snapshot.agentMessages.some((message) => message.type === "user_message")).toBe(true);
    expect(snapshot.agentMessages.some((message) => message.type === "owner_followup")).toBe(true);
  });

  it("starts an OpenClaw task and exposes running execution state immediately", async () => {
    const missions = new InMemoryMissionService();
    const pendingOpenClaw: Pick<OpenClawCliAdapter, "health" | "runAgentTask"> = {
      async health() {
        return { available: true, version: "test-openclaw" };
      },
      runAgentTask() {
        return new Promise(() => {});
      },
    };
    const mission = missions.createMission({
      goal: "Grow Xiaohongshu account",
      successMetrics: ["daily review generated"],
      constraints: ["human approval before publishing"],
    });
    missions.activateMission({ missionId: mission.id });
    const task = missions.snapshot().tasks[0];
    if (!task) throw new Error("missing task");

    const response = await handleApiRequest(
      {
        method: "POST",
        path: "/api/openclaw/run",
        body: {
          missionId: mission.id,
          taskId: task.id,
          message: "Create a first execution plan",
        },
      },
      { missions, openclaw: pendingOpenClaw },
    );

    expect(response.status).toBe(202);
    const body = response.body as { execution: { taskId: string; status: string } };
    expect(body.execution.taskId).toBe(task.id);
    expect(body.execution.status).toBe("running");
    expect(missions.snapshot().executions[0]?.status).toBe("running");
  });
});
