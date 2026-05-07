import { afterEach, describe, expect, it, vi } from "vitest";
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

function apiLlmWithPlan() {
  return new FakeLlmAdapter((messages) => {
    if (messages[0]?.content.includes("Owner planning workflow")) {
      return JSON.stringify({
        goal: "Run a mission",
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
    return JSON.stringify({
      goal: "Run a mission",
      scope: "Execution test",
      constraints: ["human approval"],
      successMetrics: ["Mission is runnable"],
      keyAssumptions: [],
    });
  });
}

async function createMissionWithConfirmedPlan(missions: InMemoryMissionService): Promise<string> {
  const mission = await missions.createMission({ goal: "Run a mission" });
  await missions.continueMission({
    missionId: mission.id,
    message: "Audience is developers. Timeline is one month.",
  });
  missions.confirmBrief({ missionId: mission.id });
  const plan = await missions.generateMissionPlan({ missionId: mission.id });
  missions.confirmMissionPlan({ missionId: mission.id, planId: plan.id });
  return mission.id;
}

async function createMissionWithConfirmedBrief(missions: InMemoryMissionService): Promise<string> {
  const mission = await missions.createMission({ goal: "Run a mission" });
  await missions.continueMission({
    missionId: mission.id,
    message: "Audience is developers. Timeline is one month.",
  });
  missions.confirmBrief({ missionId: mission.id });
  return mission.id;
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it("rejects API activation when no current MissionPlan is confirmed", async () => {
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

    expect(activateResponse.status).toBe(400);
    expect(activateResponse.body).toMatchObject({
      error: expect.stringContaining("Mission requires a confirmed MissionPlan before activation"),
    });
    expect(missions.snapshot().tasks).toHaveLength(0);
  });

  it("starts mission activation asynchronously so the UI can show HR recruiting", async () => {
    const missions = new InMemoryMissionService({ llm: apiLlmWithPlan() });
    const missionId = await createMissionWithConfirmedPlan(missions);

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

  it("reuses the recruiting HR agent when async activation starts negotiation", async () => {
    vi.useFakeTimers();
    const missions = new InMemoryMissionService({ llm: apiLlmWithPlan() });
    const missionId = await createMissionWithConfirmedPlan(missions);

    const response = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions/activate-async",
        body: { missionId },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const recruitingHr = missions.snapshot().agents.find(
      (agent) => agent.missionId === missionId && agent.role === "hr",
    );

    expect(response.status).toBe(202);
    expect(recruitingHr).toBeDefined();

    await vi.runAllTimersAsync();

    const hrAgents = missions.snapshot().agents.filter(
      (agent) => agent.missionId === missionId && agent.role === "hr",
    );
    expect(hrAgents).toHaveLength(1);
    expect(hrAgents[0]?.id).toBe(recruitingHr?.id);
    expect(hrAgents[0]?.status).toBe("idle");
    expect(missions.getNegotiation({ missionId })).toBeDefined();
  });

  it("confirms HR negotiation through the documented API route", async () => {
    const missions = new InMemoryMissionService({ llm: apiLlmWithPlan() });
    const missionId = await createMissionWithConfirmedPlan(missions);
    await missions.activateMissionWithHR({ missionId });

    const response = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions/negotiate/confirm",
        body: { missionId },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(response.status).toBe(200);
    const snapshot = (response.body as { snapshot: MissionSnapshot }).snapshot;
    expect(snapshot.agents.some((agent) => agent.missionId === missionId && agent.role !== "owner" && agent.role !== "hr")).toBe(true);
    expect(snapshot.tasks.filter((task) => task.missionId === missionId)).toHaveLength(1);
    expect(missions.getNegotiation({ missionId })).toBeUndefined();
  });

  it("rejects async API activation before creating HR work when no MissionPlan is confirmed", async () => {
    const missions = new InMemoryMissionService();
    const mission = await missions.createMission({ goal: "Run a mission" });

    const response = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions/activate-async",
        body: { missionId: mission.id },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("Mission requires a confirmed MissionPlan before activation"),
    });
    const snapshot = missions.snapshot();
    expect(snapshot.tasks.filter((task) => task.missionId === mission.id)).toHaveLength(0);
    expect(snapshot.agents.find((agent) => agent.missionId === mission.id && agent.role === "hr")).toBeUndefined();
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

  it("deletes a mission and removes its scoped records from the snapshot", async () => {
    const missions = new InMemoryMissionService();
    const mission = await missions.createMission({ goal: "学习 harness 并生成知识图" });
    missions.activateMission({ missionId: mission.id });

    const response = await handleApiRequest(
      {
        method: "DELETE",
        path: `/api/missions/${mission.id}`,
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(response.status).toBe(200);
    const snapshot = missions.snapshot();
    expect(snapshot.missions).toHaveLength(0);
    expect(snapshot.tasks.filter((task) => task.missionId === mission.id)).toHaveLength(0);
    expect(snapshot.executions.filter((execution) => execution.missionId === mission.id)).toHaveLength(0);
    expect(snapshot.agents.filter((agent) => agent.missionId === mission.id)).toHaveLength(0);
    expect(snapshot.agentMessages.filter((message) => message.missionId === mission.id)).toHaveLength(0);
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

  it("GET /api/missions/:id/autopilot-diagnosis reports briefing when OpenClaw is available", async () => {
    const missions = new InMemoryMissionService();
    const mission = await missions.createMission({ goal: "Grow GitHub repositories" });

    const response = await handleApiRequest(
      { method: "GET", path: `/api/missions/${mission.id}/autopilot-diagnosis` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      diagnosis: {
        missionId: mission.id,
        stage: "briefing",
        ready: false,
        signals: {
          hasExecutionRunner: true,
        },
      },
    });
  });

  it("GET /api/missions/:id/autopilot-diagnosis reports unavailable OpenClaw runner", async () => {
    const missions = new InMemoryMissionService();
    const mission = await missions.createMission({ goal: "Grow GitHub repositories" });
    const unavailableOpenClaw: Pick<OpenClawCliAdapter, "health" | "runAgentTask"> = {
      async health() {
        return { available: false };
      },
      async runAgentTask() {
        throw new Error("OpenClaw unavailable");
      },
    };

    const response = await handleApiRequest(
      { method: "GET", path: `/api/missions/${mission.id}/autopilot-diagnosis` },
      { missions, openclaw: unavailableOpenClaw },
    );

    expect(response.status).toBe(200);
    expect((response.body as { diagnosis: { signals: { hasExecutionRunner: boolean } } }).diagnosis.signals.hasExecutionRunner).toBe(false);
  });

  it("GET /api/missions/:id/plan returns no plan before generation", async () => {
    const missions = new InMemoryMissionService();
    const mission = await missions.createMission({ goal: "Run a mission" });

    const response = await handleApiRequest(
      { method: "GET", path: `/api/missions/${mission.id}/plan` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  it("generates and confirms a MissionPlan via API", async () => {
    const missions = new InMemoryMissionService({ llm: apiLlmWithPlan() });
    const missionId = await createMissionWithConfirmedBrief(missions);

    const generateResponse = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/plan/generate`,
        body: { feedback: "Include analytics." },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(generateResponse.status).toBe(200);
    const generated = generateResponse.body as {
      plan: { id: string; status: string; feedback: string };
      snapshot: MissionSnapshot;
    };
    expect(generated.plan.status).toBe("draft");
    expect(generated.plan.feedback).toBe("Include analytics.");
    expect(generated.snapshot.plans.some((plan) => plan.id === generated.plan.id)).toBe(true);

    const confirmResponse = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/plan/confirm`,
        body: { planId: generated.plan.id },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(confirmResponse.status).toBe(200);
    const confirmed = confirmResponse.body as {
      mission: { confirmedPlanId: string };
      plan: { id: string; status: string };
      snapshot: MissionSnapshot;
    };
    expect(confirmed.mission.confirmedPlanId).toBe(generated.plan.id);
    expect(confirmed.plan).toMatchObject({ id: generated.plan.id, status: "confirmed" });
    expect(confirmed.snapshot.missions.find((mission) => mission.id === missionId)?.confirmedPlanId).toBe(generated.plan.id);

    const diagnosisResponse = await handleApiRequest(
      { method: "GET", path: `/api/missions/${missionId}/autopilot-diagnosis` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(diagnosisResponse.status).toBe(200);
    expect((diagnosisResponse.body as { diagnosis: { signals: { hasPlan: boolean } } }).diagnosis.signals.hasPlan).toBe(true);
  });

  it("rejects malformed MissionPlan API inputs", async () => {
    const missions = new InMemoryMissionService({ llm: apiLlmWithPlan() });
    const missionId = await createMissionWithConfirmedBrief(missions);

    const malformedFeedback = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/plan/generate`,
        body: { feedback: 42 },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(malformedFeedback.status).toBe(400);
    expect(malformedFeedback.body).toMatchObject({ error: "feedback must be a non-empty string" });

    const malformedConfirm = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/plan/confirm`,
        body: {},
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(malformedConfirm.status).toBe(400);
    expect(malformedConfirm.body).toMatchObject({ error: "planId must be a non-empty string" });
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

  it("returns mission feedback summary", async () => {
    const missions = new InMemoryMissionService();
    const mission = await missions.createMission({ goal: "Grow a GitHub repository" });
    missions.activateMission({ missionId: mission.id });
    const task = missions.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = missions.startExecution({ missionId: mission.id, taskId: task!.id });
    missions.failExecution({ executionId: execution.id, error: "OpenClaw timed out" });

    const resp = await handleApiRequest(
      {
        method: "GET",
        path: `/api/missions/${mission.id}/feedback-summary`,
        body: undefined,
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(200);
    expect(resp.body).toMatchObject({
      summary: {
        missionId: mission.id,
        counts: {
          evaluations: 1,
          failureAnalyses: 1,
          strategyAdjustments: 0,
        },
      },
    });
  });

  it("returns feedback record collections", async () => {
    const missions = new InMemoryMissionService();
    const mission = await missions.createMission({ goal: "Grow a GitHub repository" });
    missions.activateMission({ missionId: mission.id });
    const task = missions.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = missions.startExecution({ missionId: mission.id, taskId: task!.id });
    missions.failExecution({ executionId: execution.id, error: "OpenClaw timed out" });

    const evaluations = await handleApiRequest(
      {
        method: "GET",
        path: `/api/missions/${mission.id}/feedback/evaluations`,
        body: undefined,
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const failureAnalyses = await handleApiRequest(
      {
        method: "GET",
        path: `/api/missions/${mission.id}/feedback/failure-analyses`,
        body: undefined,
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const strategyAdjustments = await handleApiRequest(
      {
        method: "GET",
        path: `/api/missions/${mission.id}/feedback/strategy-adjustments`,
        body: undefined,
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(evaluations.status).toBe(200);
    expect((evaluations.body as { evaluations: unknown[] }).evaluations).toHaveLength(1);
    expect(failureAnalyses.status).toBe(200);
    expect((failureAnalyses.body as { failureAnalyses: unknown[] }).failureAnalyses).toHaveLength(1);
    expect(strategyAdjustments.status).toBe(200);
    expect((strategyAdjustments.body as { strategyAdjustments: unknown[] }).strategyAdjustments).toHaveLength(0);
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

  async function addScheduleRule(
    missions: InMemoryMissionService,
    missionId: string,
    overrides: { assigneeRole?: string; title?: string } = {},
  ): Promise<string> {
    const addResp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule`,
        body: {
          name: "Daily check",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          taskTemplate: {
            title: overrides.title ?? "Check data",
            contract: {
              objective: "Check data",
              input: {},
              outputSchema: {},
              successCriteria: ["Report generated"],
            },
            assigneeRole: overrides.assigneeRole ?? "data-analyst",
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
    const ruleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner" });

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

  it("PATCH /api/missions/:id/schedule/:ruleId rejects invalid updates without corrupting state", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId);

    const patchResp = await handleApiRequest(
      {
        method: "PATCH",
        path: `/api/missions/${missionId}/schedule/${ruleId}`,
        body: { maxConcurrent: 0 },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(patchResp.status).toBe(400);
    const rule = missions.getScheduleRules(missionId).find((candidate) => candidate.id === ruleId);
    expect(rule?.maxConcurrent).toBe(1);
  });

  it("PATCH /api/missions/:id/schedule/:ruleId rejects unsupported fields", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId);

    const patchResp = await handleApiRequest(
      {
        method: "PATCH",
        path: `/api/missions/${missionId}/schedule/${ruleId}`,
        body: { id: "schedule_bad" },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(patchResp.status).toBe(400);
    expect(missions.getScheduleRules(missionId)[0]?.id).toBe(ruleId);
  });

  it("PATCH /api/missions/:id/schedule/:ruleId restarts scheduler when trigger changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T08:59:00Z"));

    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner" });

    const patchResp = await handleApiRequest(
      {
        method: "PATCH",
        path: `/api/missions/${missionId}/schedule/${ruleId}`,
        body: {
          trigger: {
            type: "condition",
            description: "Engagement drops",
            sourceAgentRole: "owner",
            evaluatePrompt: "Return true if engagement drops.",
          },
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const listResp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${missionId}/schedule` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(patchResp.status).toBe(200);
    const rules = (listResp.body as { rules: Array<{ id: string; nextRunAt?: string }> }).rules;
    expect(rules.find((rule) => rule.id === ruleId)?.nextRunAt).toBeUndefined();
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

  it("manual trigger links created task to schedule rule", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner" });

    await handleApiRequest(
      { method: "POST", path: `/api/missions/${missionId}/schedule/${ruleId}/trigger`, body: {} },
      { missions, openclaw: fakeOpenClaw() },
    );

    const scheduledTask = missions.snapshot().tasks.find((task) => task.scheduleRuleId === ruleId);
    expect(scheduledTask?.title).toBe("Check data");
  });

  it("starts cron scheduler when first rule is added to an active mission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T08:59:00Z"));

    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const before = missions.snapshot().tasks.length;

    await addScheduleRule(missions, missionId, { assigneeRole: "owner", title: "Cron-created task" });
    vi.advanceTimersByTime(60_000);

    const scheduledTask = missions.snapshot().tasks.find((task) => task.title === "Cron-created task");
    expect(missions.snapshot().tasks.length).toBe(before + 1);
    expect(scheduledTask?.scheduleRuleId).toMatch(/^schedule_/);
  });

  it("GET /api/missions/:id/schedule exposes nextRunAt for cron rules", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T08:59:00Z"));

    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner" });

    const resp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${missionId}/schedule` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(200);
    const rules = (resp.body as { rules: Array<{ id: string; nextRunAt?: string }> }).rules;
    expect(rules.find((rule) => rule.id === ruleId)?.nextRunAt).toBe("2026-04-29T09:00:00.000Z");
  });

  it("GET /api/missions/:id/automation-summary returns automation summary", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    await addScheduleRule(missions, missionId, { assigneeRole: "owner" });

    const resp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${missionId}/automation-summary` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(200);
    expect((resp.body as { summary: { rulesCount: number; nextAction?: { ruleName: string } } }).summary.rulesCount).toBe(1);
    expect((resp.body as { summary: { nextAction?: { ruleName: string } } }).summary.nextAction?.ruleName).toBe("Daily check");
  });

  it("POST /api/missions/:id/schedule/trigger-next creates the next scheduled task", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner" });

    const resp = await handleApiRequest(
      { method: "POST", path: `/api/missions/${missionId}/schedule/trigger-next`, body: {} },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(200);
    expect((resp.body as { task: { scheduleRuleId: string } }).task.scheduleRuleId).toBe(ruleId);
    expect((resp.body as { snapshot: MissionSnapshot }).snapshot.scheduleTriggerEvents).toHaveLength(1);
  });

  it("POST /api/missions/:id/schedule/templates creates a daily rule", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);

    const resp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule/templates`,
        body: {
          templateType: "daily_check",
          assigneeRole: "owner",
          taskGoal: "Check yesterday's GitHub growth metrics",
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(201);
    expect((resp.body as { rule: { metadata: Record<string, unknown> } }).rule.metadata.templateType).toBe("daily_check");
  });

  it("POST /api/missions/:id/schedule/templates rejects biweekly rules", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);

    const resp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule/templates`,
        body: {
          templateType: "biweekly_review",
          assigneeRole: "owner",
          taskGoal: "Review every two weeks",
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toContain("Unsupported schedule template: biweekly_review");
  });

  it("POST pause and resume toggle automation without restoring manually disabled rules", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const enabledRuleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner" });
    const disabledRuleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner", title: "Weekly review" });
    missions.updateScheduleRule(missionId, disabledRuleId, { enabled: false });

    const pauseResp = await handleApiRequest(
      { method: "POST", path: `/api/missions/${missionId}/schedule/pause`, body: {} },
      { missions, openclaw: fakeOpenClaw() },
    );
    const resumeResp = await handleApiRequest(
      { method: "POST", path: `/api/missions/${missionId}/schedule/resume`, body: {} },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(pauseResp.status).toBe(200);
    expect(resumeResp.status).toBe(200);
    expect(missions.getScheduleRules(missionId).find((rule) => rule.id === enabledRuleId)?.enabled).toBe(true);
    expect(missions.getScheduleRules(missionId).find((rule) => rule.id === disabledRuleId)?.enabled).toBe(false);
  });
});
