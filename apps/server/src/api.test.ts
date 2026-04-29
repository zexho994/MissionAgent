import { describe, expect, it } from "vitest";
import { handleApiRequest } from "./api.js";
import { InMemoryMissionService } from "./mission-service.js";
import { FakeLlmAdapter } from "@digitalagent/runtime";
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

  it("starts mission activation asynchronously so the UI can show HR recruiting", async () => {
    const missions = new InMemoryMissionService();
    const createResponse = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions",
        body: {
          goal: "Grow GitHub account to two 1k-star repos",
          successMetrics: ["two repos over 1000 stars"],
          constraints: ["one month"],
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const missionId = (createResponse.body as { mission: { id: string } }).mission.id;

    const response = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions/activate-async",
        body: { missionId },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(response.status).toBe(202);
    const snapshot = (response.body as { snapshot: MissionSnapshot }).snapshot;
    const hr = snapshot.agents.find((agent) => agent.missionId === missionId && agent.role === "hr");
    expect(hr?.status).toBe("running");
    expect(snapshot.tasks.filter((task) => task.missionId === missionId)).toHaveLength(0);
  });

  it("continues an existing mission instead of creating a new one", async () => {
    const missions = new InMemoryMissionService();
    const mission = await missions.createMission({ goal: "学习 harness 并生成知识图" });
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
    const mission = await missions.createMission({
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

  it("confirms a MissionBrief via the API", async () => {
    const fake = new FakeLlmAdapter(() => JSON.stringify({
      goal: "运营小红书账号到1000粉丝",
      scope: "小红书平台",
      constraints: ["human approval"],
      successMetrics: ["followers >= 1000"],
      keyAssumptions: ["existing account"],
    }));
    const missions = new InMemoryMissionService({ llm: fake });

    const createResponse = await handleApiRequest(
      { method: "POST", path: "/api/missions", body: { goal: "运营小红书账号" } },
      { missions, openclaw: fakeOpenClaw() },
    );
    const missionId = (createResponse.body as { mission: { id: string } }).mission.id;

    await handleApiRequest(
      { method: "POST", path: "/api/missions/continue", body: { missionId, message: "目标人群是年轻女性" } },
      { missions, openclaw: fakeOpenClaw() },
    );

    const confirmResponse = await handleApiRequest(
      { method: "POST", path: "/api/missions/confirm-brief", body: { missionId } },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(confirmResponse.status).toBe(200);
    const confirmed = (confirmResponse.body as { mission: { briefConfirmed: boolean; successMetrics: string[] } }).mission;
    expect(confirmed.briefConfirmed).toBe(true);
    expect(confirmed.successMetrics).toEqual(["followers >= 1000"]);
  });

  it("converses with an agent and reads the created thread via the API", async () => {
    const fake = new FakeLlmAdapter(() => JSON.stringify({
      message: "我会先整理上下文，再给出下一步建议。",
      type: "agent_chat",
      mentionedAgentIds: [],
      shouldPropagate: false,
      action: { type: "acknowledge" },
    }));
    const missions = new InMemoryMissionService({ llm: fake });
    const mission = await missions.createMission({ goal: "学习 harness 并生成知识图" });
    missions.activateMission({ missionId: mission.id });
    const agent = missions.snapshot().agents.find((candidate) => candidate.role === "researcher");
    if (!agent) throw new Error("missing agent");

    const converseResponse = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions/converse",
        body: {
          missionId: mission.id,
          agentId: agent.id,
          message: "请说明当前风险",
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(converseResponse.status).toBe(200);
    const converseBody = converseResponse.body as { message: { threadId: string } };
    expect(converseBody.message.threadId).toBeTruthy();

    const threadsResponse = await handleApiRequest(
      { method: "GET", path: `/api/missions/threads?missionId=${mission.id}` },
      { missions, openclaw: fakeOpenClaw() },
    );
    expect(threadsResponse.status).toBe(200);
    expect((threadsResponse.body as { threads: unknown[] }).threads).toHaveLength(1);

    const threadResponse = await handleApiRequest(
      { method: "GET", path: `/api/missions/threads/${converseBody.message.threadId}` },
      { missions, openclaw: fakeOpenClaw() },
    );
    expect(threadResponse.status).toBe(200);
    expect((threadResponse.body as { messages: Array<{ content: string }> }).messages.some((message) => message.content.includes("下一步建议"))).toBe(true);
  });
});

describe("schedule API endpoints", () => {
  async function createMissionViaApi(missions: InMemoryMissionService): Promise<string> {
    const createResp = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions",
        body: {
          goal: "Test mission",
          successMetrics: ["test metric"],
          constraints: ["test constraint"],
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    return (createResp.body as { mission: { id: string } }).mission.id;
  }

  async function addScheduleRule(missions: InMemoryMissionService, missionId: string): Promise<string> {
    const addResp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule`,
        body: {
          name: "Daily check",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          taskTemplate: {
            title: "Check data",
            contract: {
              objective: "Check data",
              input: {},
              outputSchema: {},
              successCriteria: ["Report generated"],
            },
            assigneeRole: "data-analyst",
            priority: "normal",
          },
          maxConcurrent: 1,
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    expect(addResp.status).toBe(201);
    return (addResp.body as { rule: { id: string } }).rule.id;
  }

  it("GET /api/missions/:id/schedule returns schedule rules", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);

    const resp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${missionId}/schedule` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(200);
    expect((resp.body as { rules: unknown[] }).rules).toEqual([]);
  });

  it("POST /api/missions/:id/schedule adds a schedule rule", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);

    const ruleId = await addScheduleRule(missions, missionId);

    expect(ruleId).toMatch(/^schedule_/);
  });

  it("POST /api/missions/:id/schedule returns 400 for missing mission", async () => {
    const missions = new InMemoryMissionService();
    const resp = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions/nonexistent/schedule",
        body: {
          name: "Daily check",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          taskTemplate: {
            title: "Check data",
            contract: {
              objective: "Check data",
              input: {},
              outputSchema: {},
              successCriteria: ["Report generated"],
            },
            assigneeRole: "data-analyst",
            priority: "normal",
          },
          maxConcurrent: 1,
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(400);
  });

  it("DELETE /api/missions/:id/schedule/:ruleId removes a rule", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId);

    const delResp = await handleApiRequest(
      { method: "DELETE", path: `/api/missions/${missionId}/schedule/${ruleId}` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(delResp.status).toBe(200);

    const listResp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${missionId}/schedule` },
      { missions, openclaw: fakeOpenClaw() },
    );
    expect((listResp.body as { rules: unknown[] }).rules).toHaveLength(0);
  });

  it("PATCH /api/missions/:id/schedule/:ruleId updates a rule", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId);

    const patchResp = await handleApiRequest(
      {
        method: "PATCH",
        path: `/api/missions/${missionId}/schedule/${ruleId}`,
        body: { enabled: false },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(patchResp.status).toBe(200);
    expect((patchResp.body as { rule: { enabled: boolean } }).rule.enabled).toBe(false);
  });

  it("POST /api/missions/:id/schedule/:ruleId/trigger manually triggers", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId);

    const triggerResp = await handleApiRequest(
      { method: "POST", path: `/api/missions/${missionId}/schedule/${ruleId}/trigger`, body: {} },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(triggerResp.status).toBe(200);
    expect((triggerResp.body as { triggered: boolean }).triggered).toBe(true);
  });
});
