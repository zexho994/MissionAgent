import {
  createScheduleRule,
  createId,
  createTask,
  type Mission,
  type ScheduleRule,
} from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";
import { createHRAgent, type TeamProposal } from "./hr-agent.js";
import { createAgentFactory } from "./agent-factory.js";
import { createNegotiationService, type OwnerContext, type NegotiationSummary } from "./negotiation-service.js";

export type { NegotiationSummary };
import type { WarRoomAgent, AgentRelation, MissionSnapshot, StreamEventListener, StreamSubscription, ParsedChoice, AgentMessage } from "./mission-service.js";
import type { AgentSystemConfig } from "./system-config.js";

export interface NegotiationManagerOptions {
  llm: LlmService;
  config: AgentSystemConfig;
  agents: Map<string, WarRoomAgent>;
  agentRelations: Map<string, AgentRelation>;
  missions: Map<string, Mission>;
  tasks: Map<string, import("@digitalagent/core").Task>;
  agentMessages: Map<string, AgentMessage>;
  maxRounds?: number;
}

export class NegotiationManager {
  private readonly llm: LlmService;
  private readonly config: AgentSystemConfig;
  private readonly agents: Map<string, WarRoomAgent>;
  private readonly agentRelations: Map<string, AgentRelation>;
  private readonly missions: Map<string, Mission>;
  private readonly tasks: Map<string, import("@digitalagent/core").Task>;
  private readonly agentMessages: Map<string, AgentMessage>;
  private readonly maxRounds: number;
  private readonly activeNegotiations = new Map<string, { proposal: TeamProposal; ownerContext: OwnerContext; roundCount: number; hrAgentId: string }>();

  constructor(options: NegotiationManagerOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this.agents = options.agents;
    this.agentRelations = options.agentRelations;
    this.missions = options.missions;
    this.tasks = options.tasks;
    this.agentMessages = options.agentMessages;
    this.maxRounds = options.maxRounds ?? 3;
  }

  async startNegotiation(input: { missionId: string }, mission: Mission): Promise<TeamProposal> {
    if (!mission.brief) {
      throw new Error("Mission must have a brief before negotiation");
    }

    const hrAgentId = createId("agent");
    const hrAgentRecord: WarRoomAgent = {
      id: hrAgentId,
      missionId: mission.id,
      role: "hr",
      name: "HR Agent",
      responsibility: "Team assembly and agent coordination",
      status: "running",
      currentTaskId: undefined,
      lastAction: "Analyzing MissionBrief and proposing team",
      avatarSeed: "hr",
      sortOrder: 99,
    };
    this.agents.set(hrAgentId, hrAgentRecord);

    const hrAgent = createHRAgent({ llm: this.llm });
    const analysis = await hrAgent.receiveMissionBrief(mission.brief);
    const roleSpecs = await hrAgent.generateRoleSpecs(mission.id, analysis);
    const proposal = await hrAgent.proposeTeam(mission.id, roleSpecs, mission.brief);

    const owner = this.agentByRole(mission.id, "owner");
    const ownerContext: OwnerContext = {
      ownerAgentId: owner.id,
      preferences: {
        teamSize: [2, 5],
        maxBudget: { maxRuntimeMinutes: 180, maxTasks: 10 },
        preferredCapabilities: [],
        avoidCapabilities: [],
      },
      constraints: mission.constraints,
      previousFeedback: [],
    };

    this.activeNegotiations.set(mission.id, { proposal, ownerContext, roundCount: 0, hrAgentId });

    this.appendMessage({
      missionId: mission.id,
      fromAgentId: hrAgentId,
      toAgentId: owner.id,
      type: "team_created",
      content: `HR Agent proposes a team of ${proposal.roles.length} members. Estimated duration: ${proposal.estimatedDuration}. Risks: ${proposal.riskAssessment.join(", ")}.`,
    });

    return proposal;
  }

  async respondToNegotiation(input: { missionId: string; feedback: string }, mission: Mission): Promise<{ proposal: TeamProposal; summary?: NegotiationSummary }> {
    const stored = this.activeNegotiations.get(mission.id);
    if (!stored) {
      throw new Error("No active negotiation for this mission. Start one first.");
    }

    const { proposal, ownerContext, roundCount, hrAgentId } = stored;
    const newRoundCount = roundCount + 1;

    const owner = this.agentByRole(mission.id, "owner");

    if (newRoundCount >= this.maxRounds) {
      const summary: NegotiationSummary = {
        outcome: "escalated",
        roundsCompleted: newRoundCount,
        failureReason: `Negotiation reached max rounds (${this.maxRounds}) without agreement — user intervention required`,
        keyDecisions: [`Escalated after ${newRoundCount} rounds`],
        alternatives: [proposal],
      };

      this.activeNegotiations.set(mission.id, {
        proposal,
        ownerContext: { ...ownerContext, previousFeedback: [...ownerContext.previousFeedback, input.feedback] },
        roundCount: newRoundCount,
        hrAgentId,
      });

      this.appendMessage({
        missionId: mission.id,
        fromAgentId: hrAgentId,
        toAgentId: owner.id,
        type: "negotiation_escalated",
        content: `Negotiation could not reach agreement after ${newRoundCount} rounds. User intervention required. Last proposal had ${proposal.roles.length} roles.`,
      });

      return { proposal, summary };
    }

    const hrAgent = createHRAgent({ llm: this.llm });

    const revisedSpecs = await Promise.all(
      proposal.roles.map((spec) => hrAgent.negotiateRoleSpec(mission.id, spec, input.feedback)),
    );
    const flatSpecs = revisedSpecs.flat();
    const revisedProposal = await hrAgent.proposeTeam(mission.id, flatSpecs, mission.brief);

    const updatedContext: OwnerContext = {
      ...ownerContext,
      previousFeedback: [...ownerContext.previousFeedback, input.feedback],
    };

    this.activeNegotiations.set(mission.id, { proposal: revisedProposal, ownerContext: updatedContext, roundCount: newRoundCount, hrAgentId });

    this.appendMessage({
      missionId: mission.id,
      fromAgentId: owner.id,
      type: "owner_followup",
      content: input.feedback,
    });
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: hrAgentId,
      toAgentId: owner.id,
      type: "team_created",
      content: `HR Agent revised the team proposal based on your feedback. New team of ${revisedProposal.roles.length} members. ${revisedProposal.riskAssessment.length > 0 ? `Risks: ${revisedProposal.riskAssessment.join(", ")}` : "No major risks identified."}`,
    });

    return { proposal: revisedProposal };
  }

  confirmNegotiation(input: { missionId: string }, mission: Mission): Mission {
    const stored = this.activeNegotiations.get(mission.id);
    if (!stored) {
      throw new Error("No active negotiation for this mission");
    }

    const { proposal, hrAgentId } = stored;
    this.activeNegotiations.delete(mission.id);

    const agentFactory = createAgentFactory();
    const agents = proposal.roles.map((spec, index) =>
      agentFactory.createAgentFromRoleSpec(mission.id, spec, index + 1),
    );
    const relations = agentFactory.setupRelations(agents);

    const initialTask = createTask({
      missionId: mission.id,
      title: `Execute: ${mission.goal}`,
      dependencies: [],
      contract: {
        objective: `Execute the mission: ${mission.goal}`,
        input: {
          goal: mission.goal,
          successMetrics: mission.successMetrics,
          constraints: mission.constraints,
          teamProposal: proposal,
        },
        outputSchema: { results: "array", risks: "array" },
        successCriteria: [
          "All deliverables produced according to role specs",
          "Success metrics from mission brief are addressed",
        ],
      },
      approvalRequired: false,
    });

    const existingHr = this.agents.get(hrAgentId);
    if (existingHr) {
      this.agents.set(hrAgentId, {
        ...existingHr,
        status: "done",
        lastAction: "Team confirmed via negotiation",
        sortOrder: agents.length + 1,
      });
    }

    this.tasks.set(initialTask.id, initialTask);
    for (const agent of agents) {
      this.agents.set(agent.id, agent);
    }
    for (const relation of relations) {
      this.agentRelations.set(relation.id, relation);
    }

    const scheduleRules = this.createScheduleRulesFromProposal(mission, proposal);
    this.missions.set(mission.id, {
      ...mission,
      scheduleRules,
    });

    this.appendMessage({
      missionId: mission.id,
      fromAgentId: hrAgentId,
      type: "team_created",
      content: `Team confirmed! ${agents.length} agents deployed. Starting execution.`,
    });

    return mission;
  }

  private createScheduleRulesFromProposal(mission: Mission, proposal: TeamProposal): ScheduleRule[] {
    return (proposal.schedulePlan ?? []).map((planItem) => {
      const trigger = planItem.cronExpression
        ? {
            type: "cron" as const,
            expression: planItem.cronExpression,
            timezone: planItem.timezone ?? this.config.scheduler?.defaultTimezone ?? "Asia/Shanghai",
          }
        : {
            type: "condition" as const,
            description: planItem.conditionDescription ?? "",
            sourceAgentRole: planItem.conditionSourceRole ?? planItem.assigneeRole,
            evaluatePrompt: planItem.conditionEvaluatePrompt ?? `Check if: ${planItem.conditionDescription ?? ""}`,
          };

      return createScheduleRule({
        name: planItem.name,
        missionId: mission.id,
        enabled: true,
        trigger,
        taskTemplate: {
          title: planItem.taskDescription,
          contract: {
            objective: planItem.taskDescription,
            input: {},
            outputSchema: { report: "object" },
            successCriteria: [`Complete: ${planItem.taskDescription}`],
          },
          assigneeRole: planItem.assigneeRole,
          priority: "normal",
        },
        maxConcurrent: 1,
        metadata: { justification: planItem.justification },
      });
    });
  }

  getNegotiation(input: { missionId: string }): { proposal: TeamProposal; previousFeedback: string[] } | undefined {
    const stored = this.activeNegotiations.get(input.missionId);
    if (!stored) return undefined;
    return {
      proposal: stored.proposal,
      previousFeedback: stored.ownerContext.previousFeedback,
    };
  }

  private agentByRole(missionId: string, role: string): WarRoomAgent {
    const agent = [...this.agents.values()].find((candidate) => candidate.missionId === missionId && candidate.role === role);
    if (!agent) {
      throw new Error(`Agent not found for role: ${role}`);
    }
    return agent;
  }

  private appendMessage(input: Omit<AgentMessage, "id" | "createdAt"> & { options?: ParsedChoice[] }): void {
    const message: AgentMessage = {
      ...input,
      id: createId("message"),
      createdAt: new Date().toISOString(),
    };
    this.agentMessages.set(message.id, message);
  }
}
