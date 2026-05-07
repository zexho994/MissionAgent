import {
  createScheduleRule,
  createId,
  createTask,
  type Mission,
  type ScheduleRule,
  SchedulePlanGenerationError,
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
  notifyStream?: HrStreamNotifier;
}

type HrStreamNotifier = (
  missionId: string,
  event: {
    type: "hr_progress" | "hr_progress_done";
    messageId: string;
    tokensReceived?: number;
    phase?: "analyzing" | "negotiating";
  },
) => void;

export interface StoredNegotiationState {
  missionId: string;
  proposal: TeamProposal;
  ownerContext: OwnerContext;
  roundCount: number;
  hrAgentId: string;
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
  private readonly notifyStream: HrStreamNotifier | undefined;
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
    this.notifyStream = options.notifyStream;
  }

  async startNegotiation(input: { missionId: string }, mission: Mission): Promise<TeamProposal> {
    if (!mission.brief) {
      throw new Error("Mission must have a brief before negotiation");
    }

    const hrAgentRecord = this.getOrCreateHrAgent(mission.id);
    const hrAgentId = hrAgentRecord.id;

    const stream = this.startHrStream(mission.id, "analyzing");
    let proposal: TeamProposal;
    try {
      const hrAgent = createHRAgent({
        llm: this.llm,
        ...(stream.onToken === undefined ? {} : { onToken: stream.onToken }),
      });
      const { analysis, roleSpecs } = await hrAgent.analyzeAndPlan(mission.id, mission.brief);
      this.appendMessage({
        missionId: mission.id,
        fromAgentId: hrAgentId,
        type: "agent_notify",
        content: `HR 已完成 MissionBrief 分析并生成 ${roleSpecs.length} 个角色规格（共 ${analysis.estimatedTeamSize} 个核心角色，复杂度 ${analysis.complexity}），正在整理团队提案。`,
      });
      try {
        proposal = await hrAgent.proposeTeam(mission.id, roleSpecs, mission.brief);
      } catch (error) {
        if (error instanceof SchedulePlanGenerationError) {
          this.appendMessage({
            missionId: mission.id,
            fromAgentId: hrAgentId,
            type: "team_planning_failed",
            content: `Schedule planning failed: ${error.reason}`,
          });
        }
        throw error;
      }
    } finally {
      stream.done();
    }

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
      content: formatTeamProposalMessage(proposal),
    });
    this.agents.set(hrAgentId, {
      ...hrAgentRecord,
      status: "idle",
      lastAction: "Waiting for Owner team decision",
    });

    return proposal;
  }

  private getOrCreateHrAgent(missionId: string): WarRoomAgent {
    const existingAgents = [...this.agents.values()].filter((agent) => agent.missionId === missionId && agent.role === "hr");
    const existing = existingAgents[0];
    for (const duplicate of existingAgents.slice(1)) {
      this.agents.delete(duplicate.id);
    }
    const hrAgentRecord: WarRoomAgent = {
      ...(existing ?? {
        id: createId("agent"),
        missionId,
        role: "hr",
        name: "HR Agent",
        responsibility: "Team assembly and agent coordination",
        currentTaskId: undefined,
        avatarSeed: "hr",
        sortOrder: 99,
      }),
      status: "running",
      lastAction: "Analyzing MissionBrief and proposing team",
    };
    this.agents.set(hrAgentRecord.id, hrAgentRecord);
    return hrAgentRecord;
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

    const stream = this.startHrStream(mission.id, "negotiating");
    let revisedProposal: TeamProposal;
    try {
      const hrAgent = createHRAgent({
        llm: this.llm,
        ...(stream.onToken === undefined ? {} : { onToken: stream.onToken }),
      });

      const revisedSpecs = await Promise.all(
        proposal.roles.map((spec) => hrAgent.negotiateRoleSpec(mission.id, spec, input.feedback)),
      );
      const flatSpecs = revisedSpecs.flat();
      try {
        revisedProposal = await hrAgent.proposeTeam(mission.id, flatSpecs, mission.brief);
      } catch (error) {
        if (error instanceof SchedulePlanGenerationError) {
          this.appendMessage({
            missionId: mission.id,
            fromAgentId: hrAgentId,
            type: "team_planning_failed",
            content: `Schedule planning failed: ${error.reason}`,
          });
        }
        throw error;
      }
    } finally {
      stream.done();
    }

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
      content: formatTeamProposalMessage(revisedProposal, "HR 已根据你的反馈更新团队提案。"),
    });
    const hrAgentRecord = this.agents.get(hrAgentId);
    if (!hrAgentRecord) {
      throw new Error(`HR agent not found for negotiation: ${hrAgentId}`);
    }
    this.agents.set(hrAgentId, {
      ...hrAgentRecord,
      status: "idle",
      lastAction: "Waiting for Owner team decision",
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
      content: `团队已确认：${agents.length} 个 agent 已部署，正在自动启动首个任务。`,
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

  snapshot(): StoredNegotiationState[] {
    return [...this.activeNegotiations.entries()].map(([missionId, stored]) => ({
      missionId,
      proposal: stored.proposal,
      ownerContext: stored.ownerContext,
      roundCount: stored.roundCount,
      hrAgentId: stored.hrAgentId,
    }));
  }

  restore(states: StoredNegotiationState[]): void {
    this.activeNegotiations.clear();
    for (const state of states) {
      const mission = this.missions.get(state.missionId);
      if (!mission) {
        throw new Error(`Cannot restore negotiation for missing mission: ${state.missionId}`);
      }
      if (!this.agents.has(state.hrAgentId)) {
        throw new Error(`Cannot restore negotiation for missing HR agent: ${state.hrAgentId}`);
      }
      this.activeNegotiations.set(state.missionId, {
        proposal: {
          ...state.proposal,
          createdAt: new Date(state.proposal.createdAt),
        },
        ownerContext: state.ownerContext,
        roundCount: state.roundCount,
        hrAgentId: state.hrAgentId,
      });
    }
  }

  private agentByRole(missionId: string, role: string): WarRoomAgent {
    const agent = [...this.agents.values()].find((candidate) => candidate.missionId === missionId && candidate.role === role);
    if (!agent) {
      throw new Error(`Agent not found for role: ${role}`);
    }
    return agent;
  }

  private startHrStream(
    missionId: string,
    phase: "analyzing" | "negotiating",
  ): { onToken: ((token: string) => void) | undefined; done: () => void } {
    const notifier = this.notifyStream;
    if (!notifier) {
      return { onToken: undefined, done: () => undefined };
    }

    const messageId = createId("hr_thinking");
    const throttleMs = 100;
    let tokensReceived = 0;
    let lastEmitAt = 0;
    let alreadyDone = false;

    notifier(missionId, { type: "hr_progress", messageId, tokensReceived, phase });

    const flush = () => {
      lastEmitAt = Date.now();
      notifier(missionId, { type: "hr_progress", messageId, tokensReceived, phase });
    };

    return {
      onToken: (token: string) => {
        tokensReceived += token.length;
        if (Date.now() - lastEmitAt >= throttleMs) {
          flush();
        }
      },
      done: () => {
        if (alreadyDone) return;
        alreadyDone = true;
        if (tokensReceived > 0) flush();
        notifier(missionId, { type: "hr_progress_done", messageId, tokensReceived, phase });
      },
    };
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

function formatTeamProposalMessage(proposal: TeamProposal, lead = "HR 建议采用以下团队配置。"): string {
  const roles = proposal.roles.map((role, index) => {
    const responsibilities = role.responsibilities.length > 0
      ? `职责：${role.responsibilities.join("、")}`
      : "职责：按 MissionBrief 执行相关工作";
    return `${index + 1}. ${role.name}：${role.purpose}。${responsibilities}`;
  });
  const risks = proposal.riskAssessment.length > 0
    ? proposal.riskAssessment.join("；")
    : "暂无重大风险";
  const schedule = proposal.schedulePlan.length > 0
    ? proposal.schedulePlan.map((item) => `- ${item.name}：${item.taskDescription}`).join("\n")
    : "- 暂无额外定时节奏";

  return [
    lead,
    "",
    `团队规模：${proposal.roles.length} 个成员`,
    `预计周期：${proposal.estimatedDuration}`,
    `总预算：${proposal.totalBudget.maxRuntimeMinutes} 分钟，最多 ${proposal.totalBudget.maxTasks} 个任务`,
    "",
    "角色分工：",
    ...roles,
    "",
    `风险评估：${risks}`,
    `协作方式：${proposal.collaborationPlan.workflow}；沟通渠道：${proposal.collaborationPlan.communicationChannels.join("、")}；决策机制：${proposal.collaborationPlan.decisionMaking}`,
    "",
    "运行节奏：",
    schedule,
  ].join("\n");
}
