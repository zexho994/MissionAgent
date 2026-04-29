import { describe, it, expect, beforeEach } from "vitest";
import {
  createMission,
  type Mission,
  type MissionBrief,
} from "@digitalagent/core";
import { NegotiationManager, type NegotiationManagerOptions } from "./negotiation-manager.js";
import type { LlmService } from "@digitalagent/runtime";
import type { WarRoomAgent, AgentRelation, AgentMessage } from "./mission-service.js";
import type { AgentSystemConfig } from "./system-config.js";

function makeTestDeps() {
  let callCount = 0;
  const llm: LlmService = {
    call: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: JSON.stringify({
            requiredCapabilities: ["data_analysis"],
            estimatedTeamSize: 2,
            priorityRoles: ["data_analyst", "content_strategist"],
            complexity: "medium",
            riskFactors: [],
          }),
          model: "test",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      }
      return {
        content: JSON.stringify([{
          name: "DataAnalyst",
          purpose: "Analyze mission metrics",
          responsibilities: ["Track KPIs", "Generate reports"],
          allowedTools: ["web_search", "data_analyzer"],
          successCriteria: ["KPIs tracked daily"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 5 },
        }]),
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
});
