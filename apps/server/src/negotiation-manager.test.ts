import { describe, it, expect, beforeEach } from "vitest";
import {
  createMission,
  type Mission,
  type MissionBrief,
} from "@digitalagent/core";
import { NegotiationManager, type NegotiationManagerOptions } from "./negotiation-manager.js";
import type { LlmService } from "@digitalagent/runtime";
import type { TeamProposal } from "./hr-agent.js";
import type { WarRoomAgent, AgentRelation, AgentMessage } from "./mission-service.js";
import type { AgentSystemConfig } from "./system-config.js";

function makeTestDeps() {
  let callCount = 0;
  const llm: LlmService = {
    call: async (_messages, options) => {
      callCount += 1;
      if (callCount === 1) {
        const content = JSON.stringify({
          requiredCapabilities: ["data_analysis"],
          estimatedTeamSize: 2,
          priorityRoles: ["data_analyst", "content_strategist"],
          complexity: "medium",
          riskFactors: [],
        });
        if (options?.onStream) {
          for (const char of content) {
            options.onStream(char);
          }
        }
        return {
          content,
          model: "test",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      }
      const content = JSON.stringify([{
        name: "DataAnalyst",
        purpose: "Analyze mission metrics",
        responsibilities: ["Track KPIs", "Generate reports"],
        allowedTools: ["web_search", "data_analyzer"],
        successCriteria: ["KPIs tracked daily"],
        budget: { maxRuntimeMinutes: 60, maxTasks: 5 },
      }]);
      if (options?.onStream) {
        for (const char of content) {
          options.onStream(char);
        }
      }
      return {
        content,
        model: "test",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      };
    },
    stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
  };

  const agents = new Map<string, WarRoomAgent>();
  const agentRelations = new Map<string, AgentRelation>();
  const missions = new Map<string, Mission>();
  const tasks = new Map<string, import("@digitalagent/core").Task>();
  const agentMessages = new Map<string, AgentMessage>();
  const config = {
    rules: [],
    agentSpecs: [],
    uiStrings: { teamPlannerDescription: "", initialTask: { title: "", objective: "" } },
  } as unknown as AgentSystemConfig;

  return { llm, config, agents, agentRelations, missions, tasks, agentMessages };
}

function makeMissionWithBrief(): Mission {
  const base = createMission({
    goal: "Grow Xiaohongshu to 1000 followers",
    successMetrics: ["followers >= 1000"],
    constraints: ["1 month timeline"],
  });
  const brief: MissionBrief = {
    goal: base.goal,
    scope: "Xiaohongshu content ops",
    constraints: [],
    successMetrics: ["followers >= 1000"],
    keyAssumptions: ["existing account"],
    targetAudience: "young women",
    timeline: "1 month",
  };
  return { ...base, brief, briefConfirmed: true };
}

function addOwner(agents: Map<string, WarRoomAgent>, missionId: string) {
  const owner: WarRoomAgent = {
    id: `owner_${missionId}`,
    missionId,
    role: "owner",
    name: "Owner",
    responsibility: "Mission oversight",
    status: "idle",
    currentTaskId: undefined,
    lastAction: "",
    avatarSeed: "owner",
    sortOrder: 0,
  };
  agents.set(owner.id, owner);
  return owner;
}

describe("NegotiationManager", () => {
  let deps: ReturnType<typeof makeTestDeps>;
  let mission: Mission;

  beforeEach(() => {
    deps = makeTestDeps();
    mission = makeMissionWithBrief();
    deps.missions.set(mission.id, mission);
    addOwner(deps.agents, mission.id);
  });

  describe("escalation mechanism", () => {
    it("should auto-escalate when maxRounds is reached", async () => {
      const manager = new NegotiationManager({
        ...deps,
        maxRounds: 1,
      } as NegotiationManagerOptions & { maxRounds?: number });

      await manager.startNegotiation({ missionId: mission.id }, mission);

      const result = await manager.respondToNegotiation(
        { missionId: mission.id, feedback: "Need more specialized roles" },
        mission,
      );

      expect(result.summary).toBeDefined();
      expect(result.summary?.outcome).toBe("escalated");
    });

    it("should allow negotiation within maxRounds", async () => {
      const manager = new NegotiationManager({
        ...deps,
        maxRounds: 3,
      } as NegotiationManagerOptions & { maxRounds?: number });

      await manager.startNegotiation({ missionId: mission.id }, mission);

      const result = await manager.respondToNegotiation(
        { missionId: mission.id, feedback: "Need more specialized roles" },
        mission,
      );

      expect(result.proposal).toBeDefined();
      expect(result.summary?.outcome).toBeUndefined();
    });

    it("should include escalation reason in summary", async () => {
      const manager = new NegotiationManager({
        ...deps,
        maxRounds: 1,
      } as NegotiationManagerOptions & { maxRounds?: number });

      await manager.startNegotiation({ missionId: mission.id }, mission);

      const result = await manager.respondToNegotiation(
        { missionId: mission.id, feedback: "Reduce team size" },
        mission,
      );

      expect(result.summary?.failureReason).toContain("max rounds");
    });

    it("should preserve negotiation state for user review after escalation", async () => {
      const manager = new NegotiationManager({
        ...deps,
        maxRounds: 1,
      } as NegotiationManagerOptions & { maxRounds?: number });

      await manager.startNegotiation({ missionId: mission.id }, mission);
      await manager.respondToNegotiation(
        { missionId: mission.id, feedback: "Different team" },
        mission,
      );

      const stored = manager.getNegotiation({ missionId: mission.id });
      expect(stored).toBeDefined();
      expect(stored?.proposal).toBeDefined();
      expect(stored?.previousFeedback).toHaveLength(1);
    });

    it("should send escalation message to owner on escalation", async () => {
      const manager = new NegotiationManager({
        ...deps,
        maxRounds: 1,
      } as NegotiationManagerOptions & { maxRounds?: number });

      await manager.startNegotiation({ missionId: mission.id }, mission);
      await manager.respondToNegotiation(
        { missionId: mission.id, feedback: "I disagree" },
        mission,
      );

      const messages = [...deps.agentMessages.values()].filter(
        (msg) => msg.missionId === mission.id,
      );
      const escalationMsg = messages.find((msg) =>
        msg.type === "negotiation_escalated",
      );
      expect(escalationMsg).toBeDefined();
      expect(escalationMsg?.content).toContain("User intervention");
    });
  });

  describe("startNegotiation", () => {
    it("should throw if mission has no brief", async () => {
      const noBriefMission = createMission({
        goal: "test",
        successMetrics: ["done"],
        constraints: ["none"],
      });
      addOwner(deps.agents, noBriefMission.id);
      const manager = new NegotiationManager(deps);

      await expect(
        manager.startNegotiation({ missionId: noBriefMission.id }, noBriefMission),
      ).rejects.toThrow("brief");
    });

    it("should return a team proposal", async () => {
      const manager = new NegotiationManager(deps);

      const proposal = await manager.startNegotiation({ missionId: mission.id }, mission);

      expect(proposal.roles.length).toBeGreaterThan(0);
      expect(proposal.missionId).toBe(mission.id);
    });

    it("enforces a single HR agent when stale duplicate HR records exist", async () => {
      deps.agents.set("stale_hr_1", {
        id: "stale_hr_1",
        missionId: mission.id,
        role: "hr",
        name: "HR",
        responsibility: "Recruiting",
        status: "running",
        currentTaskId: undefined,
        lastAction: "正在分析 MissionBrief 并招募团队",
        avatarSeed: "hr",
        sortOrder: 1,
      });
      deps.agents.set("stale_hr_2", {
        id: "stale_hr_2",
        missionId: mission.id,
        role: "hr",
        name: "HR",
        responsibility: "Recruiting",
        status: "running",
        currentTaskId: undefined,
        lastAction: "Analyzing MissionBrief and proposing team",
        avatarSeed: "hr",
        sortOrder: 2,
      });
      const manager = new NegotiationManager(deps);

      await manager.startNegotiation({ missionId: mission.id }, mission);

      const hrAgents = [...deps.agents.values()].filter(
        (agent) => agent.missionId === mission.id && agent.role === "hr",
      );
      expect(hrAgents).toHaveLength(1);
      expect(hrAgents[0]?.id).toBe("stale_hr_1");
    });

    it("emits hr_progress stream events while HR is generating", async () => {
      const events: Array<{ type: string; tokensReceived?: number; phase?: string; messageId?: string }> = [];
      const manager = new NegotiationManager({
        ...deps,
        notifyStream: (_missionId, event) => {
          events.push(event as { type: string; tokensReceived?: number; phase?: string; messageId?: string });
        },
      } as NegotiationManagerOptions);

      await manager.startNegotiation({ missionId: mission.id }, mission);

      const progressEvents = events.filter((event) => event.type === "hr_progress");
      expect(progressEvents.length).toBeGreaterThan(0);
      const last = progressEvents[progressEvents.length - 1];
      expect(last?.tokensReceived).toBeGreaterThan(0);
      expect(last?.phase).toBe("analyzing");
      expect(last?.messageId).toBeDefined();
      const doneEvent = events.find((event) => event.type === "hr_progress_done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.messageId).toBe(last?.messageId);
    });
  });

  describe("confirmNegotiation", () => {
    it("should create worker agents, HR agent, task, and relations", async () => {
      const manager = new NegotiationManager(deps);
      await manager.startNegotiation({ missionId: mission.id }, mission);

      manager.confirmNegotiation({ missionId: mission.id }, mission);

      const missionAgents = [...deps.agents.values()].filter(
        (a) => a.missionId === mission.id,
      );
      const workerAgents = missionAgents.filter(
        (a) => a.role !== "owner" && a.role !== "hr",
      );
      const hrAgent = missionAgents.find((a) => a.role === "hr");

      expect(workerAgents.length).toBeGreaterThan(0);
      expect(hrAgent).toBeDefined();
      expect(hrAgent?.name).toBe("HR Agent");
      expect(hrAgent?.status).toBe("done");
      expect([...deps.tasks.values()]).toHaveLength(1);
      expect(deps.missions.get(mission.id)?.scheduleRules.length).toBeGreaterThan(0);
    });

    it("renders HR team proposal messages in Chinese from structured proposal data", async () => {
      const manager = new NegotiationManager(deps);
      await manager.startNegotiation({ missionId: mission.id }, mission);

      const proposalMessage = [...deps.agentMessages.values()].find(
        (message) => message.missionId === mission.id && message.type === "team_created",
      );

      expect(proposalMessage?.content).toContain("HR 建议");
      expect(proposalMessage?.content).toContain("团队规模");
      expect(proposalMessage?.content).toContain("角色分工");
      expect(proposalMessage?.content).not.toContain("HR Agent proposes");
    });

    it("uses configured default timezone for schedule rules", async () => {
      deps.config.scheduler = { defaultTimezone: "UTC" };
      const manager = new NegotiationManager(deps);
      await manager.startNegotiation({ missionId: mission.id }, mission);

      manager.confirmNegotiation({ missionId: mission.id }, mission);

      const cronRule = deps.missions.get(mission.id)?.scheduleRules.find((rule) => rule.trigger.type === "cron");
      expect(cronRule?.trigger).toMatchObject({ timezone: "UTC" });
    });

    it("should propagate toolPermissions from RoleSpec to worker agents", async () => {
      const manager = new NegotiationManager(deps);
      await manager.startNegotiation({ missionId: mission.id }, mission);

      manager.confirmNegotiation({ missionId: mission.id }, mission);

      const worker = [...deps.agents.values()].find(
        (a) => a.missionId === mission.id && a.role !== "owner" && a.role !== "hr",
      );
      expect(worker?.toolPermissions).toBeDefined();
      expect(worker?.toolPermissions?.length).toBeGreaterThan(0);
    });

    it("should use consistent HR agent ID across all negotiation messages", async () => {
      const manager = new NegotiationManager(deps);
      await manager.startNegotiation({ missionId: mission.id }, mission);
      const hrAgent = [...deps.agents.values()].find(
        (a) => a.missionId === mission.id && a.role === "hr",
      );
      const hrId = hrAgent?.id;
      expect(hrId).toBeDefined();

      manager.confirmNegotiation({ missionId: mission.id }, mission);

      const hrMessages = [...deps.agentMessages.values()].filter(
        (m) => m.missionId === mission.id && m.fromAgentId === hrId,
      );
      expect(hrMessages.length).toBeGreaterThanOrEqual(2);
      const syntheticIdMessages = [...deps.agentMessages.values()].filter(
        (m) => m.missionId === mission.id && m.fromAgentId === `hr_${mission.id}`,
      );
      expect(syntheticIdMessages).toHaveLength(0);
    });
  });

  describe("createScheduleRulesFromProposal templateId expansion", () => {
    it("expands templateId to ScheduleRule using the built-in registry", () => {
      const manager = new NegotiationManager(deps);
      const proposal: TeamProposal = {
        missionId: mission.id,
        roles: [],
        proposedBy: "hr_test",
        totalBudget: { maxRuntimeMinutes: 0, maxTasks: 0 },
        estimatedDuration: "0 minutes",
        riskAssessment: [],
        collaborationPlan: { workflow: "", communicationChannels: [], decisionMaking: "" },
        schedulePlan: [
          {
            name: "daily check via template",
            assigneeRole: "data_analyst",
            taskDescription: "raw description that should be ignored",
            justification: "use built-in daily metric template",
            templateId: "daily_metric_check",
          },
        ],
        createdAt: new Date(),
      };

      const rules = (manager as unknown as {
        createScheduleRulesFromProposal: (m: Mission, p: TeamProposal) => Array<import("@digitalagent/core").ScheduleRule>;
      }).createScheduleRulesFromProposal(mission, proposal);

      expect(rules).toHaveLength(1);
      const rule = rules[0]!;
      expect(rule.taskTemplate.contract.objective).toBe("检查并报告关键指标");
      expect(rule.taskTemplate.contract.objective).not.toBe("raw description that should be ignored");
      expect(rule.taskTemplate.priority).toBe("normal");
      expect(rule.taskTemplate.title).toBe("data_analyst 每日数据检查");
      expect(rule.maxConcurrent).toBe(1);
      expect(rule.metadata).toMatchObject({
        justification: "use built-in daily metric template",
        source: "builtin",
        templateId: "daily_metric_check",
      });
      expect(rule.trigger.type).toBe("cron");
      if (rule.trigger.type === "cron") {
        expect(rule.trigger.expression).toBe("0 9 * * *");
        expect(rule.trigger.timezone).toBe("UTC");
      }
    });

    it("falls back to raw plan item when templateId is unknown", () => {
      const manager = new NegotiationManager(deps);
      const proposal: TeamProposal = {
        missionId: mission.id,
        roles: [],
        proposedBy: "hr_test",
        totalBudget: { maxRuntimeMinutes: 0, maxTasks: 0 },
        estimatedDuration: "0 minutes",
        riskAssessment: [],
        collaborationPlan: { workflow: "", communicationChannels: [], decisionMaking: "" },
        schedulePlan: [
          {
            name: "no template",
            cronExpression: "0 8 * * *",
            assigneeRole: "data_analyst",
            taskDescription: "untemplated work",
            justification: "no template available",
            templateId: "nonexistent_template_id",
          },
        ],
        createdAt: new Date(),
      };

      const rules = (manager as unknown as {
        createScheduleRulesFromProposal: (m: Mission, p: TeamProposal) => Array<import("@digitalagent/core").ScheduleRule>;
      }).createScheduleRulesFromProposal(mission, proposal);

      expect(rules).toHaveLength(1);
      const rule = rules[0]!;
      expect(rule.taskTemplate.contract.objective).toBe("untemplated work");
      expect(rule.metadata).not.toHaveProperty("source");
      expect(rule.metadata).not.toHaveProperty("templateId");
    });
  });
});
