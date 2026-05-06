import {
  createArtifact,
  createId,
  createMission,
  createReview,
  createScheduleRule,
  createTask,
  transitionTask,
  validateScheduleRule,
  type Artifact,
  type Mission,
  type MissionBrief,
  type MissionOutcome,
  type MissionOutcomeEvaluation,
  type MissionOutcomeEvaluationSource,
  type MissionPlan,
  type RecommendedRecovery,
  type Review,
  type ScheduleRule,
  type Source,
  type StrategyAdjustment,
  type StrategyAdjustmentStatus,
  type Task,
  type TaskFailureAnalysis,
  type TaskFailureType,
} from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadAgentSystemConfig, type AgentSystemConfig } from "./system-config.js";
import {
  buildMissionPlanMessages,
  buildOwnerSystemPrompt,
  buildConversationMessages,
  buildSummaryRequest,
  parseMissionPlanDraft,
} from "./owner/index.js";
import type { TeamProposal } from "./hr-agent.js";
import { NegotiationManager, type NegotiationSummary } from "./negotiation-manager.js";
import { planMissionTeam, matcherFor, type MissionTeamPlan } from "./team-planning.js";
import { evaluateArtifactQuality } from "./artifact-evaluation.js";

import { ensureTaskRunning, deriveOwnerBrief, deriveOwnerFollowup } from "./mission-helpers.js";
import { runOwnerLlmStreaming } from "./owner-streaming.js";
import { AgentConversationBus } from "./agent-conversation-bus.js";
import { AgentPersonaRegistry } from "./agent-personas.js";
import { ContextRetriever } from "./context-retriever.js";
import type { BusEvent, ConversationThread } from "./agent-conversation-types.js";
import { createKnowledgeEntry, type KnowledgeEntry } from "./knowledge-base.js";
import { AgentAutonomyService } from "./agent-autonomy.js";
import { MissionScheduler, type SchedulerClock, type SchedulerDeps } from "./mission-scheduler.js";
import {
  buildExecutionFailureFeedback,
  buildExecutionResultFeedback,
  type ExecutionFailureFeedback,
  type ExecutionResultFeedback,
} from "./feedback-generation.js";

export interface CreateMissionRequest {
  goal: string;
  successMetrics?: string[];
  constraints?: string[];
}

export interface SubmitExecutionResultRequest {
  executionId: string;
  missionId: string;
  taskId: string;
  content: Record<string, unknown>;
  evidence: string[];
  sources: Source[];
}

export interface StartExecutionRequest {
  missionId: string;
  taskId: string;
}

export interface ContinueMissionRequest {
  missionId: string;
  message: string;
}

export interface ActivateMissionRequest {
  missionId: string;
}

export interface FailExecutionRequest {
  executionId: string;
  error: string;
}

export interface Execution {
  id: string;
  missionId: string;
  taskId: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  artifactId?: string;
  reviewId?: string;
  error?: string;
}

export type WarRoomAgentRole = string;
export type WarRoomAgentStatus = "idle" | "thinking" | "running" | "blocked" | "done";

export interface WarRoomAgent {
  id: string;
  missionId: string;
  role: WarRoomAgentRole;
  name: string;
  responsibility: string;
  status: WarRoomAgentStatus;
  currentTaskId: string | undefined;
  lastAction: string;
  avatarSeed: string;
  sortOrder: number;
  toolPermissions?: string[];
  budget?: {
    maxRuntimeMinutes: number;
    maxTasks: number;
  };
}

export interface AgentRelation {
  id: string;
  missionId: string;
  fromAgentId: string;
  toAgentId: string;
  label: string;
  status: "active" | "waiting" | "done";
  createdAt: string;
}

export type AgentMessageType =
  | "user_message"
  | "mission_brief"
  | "owner_followup"
  | "owner_error"
  | "team_created"
  | "task_plan"
  | "execution_started"
  | "execution_completed"
  | "execution_failed"
  | "review_completed"
  | "agent_chat"
  | "agent_report"
  | "agent_request"
  | "agent_notify"
  | "agent_discussion"
  | "negotiation_escalated";

export interface ParsedChoice {
  label: string;
  value: string;
}

export interface AgentMessage {
  id: string;
  missionId: string;
  fromAgentId: string;
  toAgentId?: string;
  type: AgentMessageType;
  content: string;
  options?: ParsedChoice[];
  threadId?: string;
  replyToId?: string;
  mentionedAgentIds?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface WarRoomTaskEvent {
  id: string;
  missionId: string;
  taskId: string;
  type: string;
  actorAgentId: string;
  summary: string;
  createdAt: string;
}

export interface ScheduleTriggerEvent {
  id: string;
  missionId: string;
  ruleId: string;
  ruleName: string;
  taskId?: string;
  status: "created" | "skipped" | "failed";
  message: string;
  createdAt: string;
}

export interface AutomationSummary {
  missionId: string;
  rulesCount: number;
  automationPaused: boolean;
  nextAction?: {
    ruleId: string;
    ruleName: string;
    nextRunAt: string;
    assigneeRole: string;
    assigneeAgentId?: string;
    taskTitle: string;
  };
  currentScheduledTasks: Array<{
    taskId: string;
    ruleId: string;
    title: string;
    status: string;
    assigneeAgentId?: string;
  }>;
  lastTrigger?: {
    ruleId: string;
    ruleName: string;
    taskId?: string;
    status: "created" | "skipped" | "failed";
    message: string;
    createdAt: string;
  };
}

export interface FeedbackSummary {
  missionId: string;
  latestEvaluation?: MissionOutcomeEvaluation;
  latestFailureAnalysis?: TaskFailureAnalysis;
  latestStrategyAdjustment?: StrategyAdjustment;
  counts: {
    evaluations: number;
    failureAnalyses: number;
    strategyAdjustments: number;
  };
}

export type AutopilotStage =
  | "briefing"
  | "missing_plan"
  | "team_not_ready"
  | "missing_initial_tasks"
  | "missing_execution_runner"
  | "missing_schedule"
  | "ready"
  | "running"
  | "blocked";

export type AutopilotBlockerCode =
  | "brief_not_confirmed"
  | "mission_plan_missing"
  | "team_not_ready"
  | "initial_tasks_missing"
  | "execution_runner_missing"
  | "schedule_rules_missing"
  | "execution_blocked";

export interface AutopilotBlocker {
  code: AutopilotBlockerCode;
  message: string;
  nextAction: string;
}

export interface AutopilotDiagnosisSignals {
  briefConfirmed: boolean;
  hasPlan: boolean;
  teamReady: boolean;
  hasInitialTasks: boolean;
  hasExecutionRunner: boolean;
  hasScheduleRules: boolean;
  hasRunningExecution: boolean;
}

export interface AutopilotDiagnosis {
  missionId: string;
  stage: AutopilotStage;
  ready: boolean;
  blockers: AutopilotBlocker[];
  signals: AutopilotDiagnosisSignals;
}

export interface AutopilotRuntimeSignals {
  hasExecutionRunner: boolean;
}

function assertAutopilotRuntimeSignals(runtime: AutopilotRuntimeSignals): void {
  if (!runtime || typeof runtime !== "object") {
    throw new Error("Autopilot runtime signals must be provided");
  }
  if (typeof runtime.hasExecutionRunner !== "boolean") {
    throw new Error("Autopilot runtime signal hasExecutionRunner must be boolean");
  }
}

export type ScheduleTemplateRequest =
  | {
      templateType: "daily_check" | "weekly_review";
      assigneeRole: string;
      taskGoal: string;
    }
  | {
      templateType: "condition_response";
      sourceAgentRole: string;
      condition: string;
      responseAssigneeRole: string;
      responseTaskGoal: string;
    };

export interface ToolCallRecord {
  id: string;
  missionId: string;
  taskId: string;
  executionId: string;
  agentId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface DecisionRecord {
  id: string;
  missionId: string;
  taskId: string;
  reviewerAgentId: string;
  decision: "approve" | "revise" | "reject";
  rationale: string;
  createdAt: string;
}

export interface MissionSnapshot {
  missions: Mission[];
  plans: MissionPlan[];
  tasks: Task[];
  artifacts: Artifact[];
  reviews: Review[];
  executions: Execution[];
  agents: WarRoomAgent[];
  agentRelations: AgentRelation[];
  agentMessages: AgentMessage[];
  threads: ConversationThread[];
  taskEvents: WarRoomTaskEvent[];
  scheduleTriggerEvents: ScheduleTriggerEvent[];
  toolCalls: ToolCallRecord[];
  decisions: DecisionRecord[];
  knowledgeEntries: KnowledgeEntry[];
  missionOutcomeEvaluations: MissionOutcomeEvaluation[];
  taskFailureAnalyses: TaskFailureAnalysis[];
  strategyAdjustments: StrategyAdjustment[];
}

interface StoredMissionSnapshot extends MissionSnapshot {
  schemaVersion: 1;
}

function clearAutomationTogglePause(metadata: Record<string, unknown>): Record<string, unknown> {
  const { pausedByAutomationToggle: _paused, ...rest } = metadata;
  return rest;
}

function isAutomationPaused(rules: ScheduleRule[]): boolean {
  return (
    rules.length > 0 &&
    rules.every((rule) => !rule.enabled) &&
    rules.some((rule) => rule.metadata.pausedByAutomationToggle === true)
  );
}

function applyAutomationTogglePause(rule: ScheduleRule): ScheduleRule {
  return {
    ...rule,
    enabled: false,
    metadata: {
      ...rule.metadata,
      pausedByAutomationToggle: true,
    },
  };
}

function expectStoredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function expectStoredNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function expectStoredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value];
}

function expectStoredOneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const stored = expectStoredString(value, label);
  if (!(allowed as readonly string[]).includes(stored)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return stored as T;
}

function expectStoredScore(value: unknown, label: string): number {
  const score = expectStoredNumber(value, label);
  if (score < 0 || score > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return score;
}

function expectStoredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function expectStoredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseStoredMissionOutcomeEvaluation(value: unknown): MissionOutcomeEvaluation {
  const record = expectStoredObject(value, "missionOutcomeEvaluation");
  return {
    id: expectStoredString(record.id, "missionOutcomeEvaluation.id"),
    missionId: expectStoredString(record.missionId, "missionOutcomeEvaluation.missionId"),
    taskId: expectStoredString(record.taskId, "missionOutcomeEvaluation.taskId"),
    ...(record.artifactId === undefined ? {} : { artifactId: expectStoredString(record.artifactId, "missionOutcomeEvaluation.artifactId") }),
    ...(record.reviewId === undefined ? {} : { reviewId: expectStoredString(record.reviewId, "missionOutcomeEvaluation.reviewId") }),
    source: expectStoredOneOf<MissionOutcomeEvaluationSource>(record.source, "missionOutcomeEvaluation.source", ["execution_result", "execution_failure", "manual"]),
    outcome: expectStoredOneOf<MissionOutcome>(record.outcome, "missionOutcomeEvaluation.outcome", ["advanced", "neutral", "blocked", "regressed"]),
    contributionScore: expectStoredScore(record.contributionScore, "missionOutcomeEvaluation.contributionScore"),
    summary: expectStoredString(record.summary, "missionOutcomeEvaluation.summary"),
    evidence: expectStoredStringArray(record.evidence, "missionOutcomeEvaluation.evidence"),
    risks: expectStoredStringArray(record.risks, "missionOutcomeEvaluation.risks"),
    recommendedNextActions: expectStoredStringArray(record.recommendedNextActions, "missionOutcomeEvaluation.recommendedNextActions"),
    createdAt: expectStoredString(record.createdAt, "missionOutcomeEvaluation.createdAt"),
  };
}

function parseStoredTaskFailureAnalysis(value: unknown): TaskFailureAnalysis {
  const record = expectStoredObject(value, "taskFailureAnalysis");
  return {
    id: expectStoredString(record.id, "taskFailureAnalysis.id"),
    missionId: expectStoredString(record.missionId, "taskFailureAnalysis.missionId"),
    taskId: expectStoredString(record.taskId, "taskFailureAnalysis.taskId"),
    ...(record.artifactId === undefined ? {} : { artifactId: expectStoredString(record.artifactId, "taskFailureAnalysis.artifactId") }),
    ...(record.reviewId === undefined ? {} : { reviewId: expectStoredString(record.reviewId, "taskFailureAnalysis.reviewId") }),
    failureType: expectStoredOneOf<TaskFailureType>(record.failureType, "taskFailureAnalysis.failureType", [
      "missing_information",
      "agent_mismatch",
      "unclear_task",
      "external_blocker",
      "low_quality_output",
      "execution_error",
    ]),
    summary: expectStoredString(record.summary, "taskFailureAnalysis.summary"),
    rootCause: expectStoredString(record.rootCause, "taskFailureAnalysis.rootCause"),
    recommendedRecovery: expectStoredOneOf<RecommendedRecovery>(record.recommendedRecovery, "taskFailureAnalysis.recommendedRecovery", [
      "ask_user",
      "revise_task",
      "split_task",
      "reassign_agent",
      "adjust_strategy",
    ]),
    recommendedNextActions: expectStoredStringArray(record.recommendedNextActions, "taskFailureAnalysis.recommendedNextActions"),
    createdAt: expectStoredString(record.createdAt, "taskFailureAnalysis.createdAt"),
  };
}

function parseStoredStrategyAdjustment(value: unknown): StrategyAdjustment {
  const record = expectStoredObject(value, "strategyAdjustment");
  return {
    id: expectStoredString(record.id, "strategyAdjustment.id"),
    missionId: expectStoredString(record.missionId, "strategyAdjustment.missionId"),
    ...(record.triggeredByEvaluationId === undefined
      ? {}
      : { triggeredByEvaluationId: expectStoredString(record.triggeredByEvaluationId, "strategyAdjustment.triggeredByEvaluationId") }),
    ...(record.triggeredByFailureAnalysisId === undefined
      ? {}
      : { triggeredByFailureAnalysisId: expectStoredString(record.triggeredByFailureAnalysisId, "strategyAdjustment.triggeredByFailureAnalysisId") }),
    status: expectStoredOneOf<StrategyAdjustmentStatus>(record.status, "strategyAdjustment.status", ["proposed", "accepted", "rejected", "superseded"]),
    previousStrategy: expectStoredString(record.previousStrategy, "strategyAdjustment.previousStrategy"),
    proposedStrategy: expectStoredString(record.proposedStrategy, "strategyAdjustment.proposedStrategy"),
    rationale: expectStoredString(record.rationale, "strategyAdjustment.rationale"),
    affectedAgentRoles: expectStoredStringArray(record.affectedAgentRoles, "strategyAdjustment.affectedAgentRoles"),
    proposedTaskGoals: expectStoredStringArray(record.proposedTaskGoals, "strategyAdjustment.proposedTaskGoals"),
    requiresHrReview: expectStoredBoolean(record.requiresHrReview, "strategyAdjustment.requiresHrReview"),
    createdAt: expectStoredString(record.createdAt, "strategyAdjustment.createdAt"),
  };
}

export interface MissionServiceOptions {
  storageFile?: string | undefined;
  configFile?: string | undefined;
  llm?: LlmService | undefined;
}

export type StreamEventListener = (event: {
  type: "token" | "done";
  content?: string;
  messageId?: string;
}) => void;

export interface StreamSubscription {
  missionId: string;
  unsubscribe: () => void;
}

export class InMemoryMissionService {
  private readonly missions = new Map<string, Mission>();
  private readonly plans = new Map<string, MissionPlan>();
  private readonly tasks = new Map<string, Task>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly reviews = new Map<string, Review>();
  private readonly executions = new Map<string, Execution>();
  private readonly agents = new Map<string, WarRoomAgent>();
  private readonly agentRelations = new Map<string, AgentRelation>();
  private readonly agentMessages = new Map<string, AgentMessage>();
  private readonly threads = new Map<string, ConversationThread>();
  private readonly taskEvents = new Map<string, WarRoomTaskEvent>();
  private readonly scheduleTriggerEvents = new Map<string, ScheduleTriggerEvent>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly knowledgeEntries = new Map<string, KnowledgeEntry>();
  private readonly missionOutcomeEvaluations = new Map<string, MissionOutcomeEvaluation>();
  private readonly taskFailureAnalyses = new Map<string, TaskFailureAnalysis>();
  private readonly strategyAdjustments = new Map<string, StrategyAdjustment>();
  private readonly storageFile: string | undefined;
  private readonly config: AgentSystemConfig;
  private readonly llm: LlmService | undefined;
  private readonly streamListeners = new Map<string, Set<StreamEventListener>>();
  private negotiationManager: NegotiationManager | undefined;
  private conversationBus: AgentConversationBus | undefined;
  private autonomyService: AgentAutonomyService | undefined;
  private readonly schedulers = new Map<string, MissionScheduler>();
  private readonly personas: AgentPersonaRegistry;
  private readonly contextRetriever: ContextRetriever;

  private static readonly realClock: SchedulerClock = {
    now: () => new Date(),
    setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as NodeJS.Timeout),
  };

  constructor(options: MissionServiceOptions = {}) {
    this.storageFile = options.storageFile;
    this.config = loadAgentSystemConfig(options.configFile);
    this.llm = options.llm;
    this.personas = new AgentPersonaRegistry(this.config.agentCollaboration?.personas);
    this.contextRetriever = new ContextRetriever(() => this.snapshot());
    this.loadFromFile();
  }

  private getNegotiationManager(): NegotiationManager {
    if (!this.llm) {
      throw new Error("LLM is required for negotiation");
    }
    if (!this.negotiationManager) {
      this.negotiationManager = new NegotiationManager({
        llm: this.llm,
        config: this.config,
        agents: this.agents,
        agentRelations: this.agentRelations,
        missions: this.missions,
        tasks: this.tasks,
        agentMessages: this.agentMessages,
      });
    }
    return this.negotiationManager;
  }

  async createMission(input: CreateMissionRequest): Promise<Mission> {
    const ownerBrief = deriveOwnerBrief(input.goal, this.config);
    const mission = createMission({
      goal: input.goal,
      successMetrics: input.successMetrics?.length ? input.successMetrics : ownerBrief.successMetrics,
      constraints: input.constraints?.length ? input.constraints : ownerBrief.constraints,
      budget: {
        maxRuntimeMinutes: 180,
        maxTokenSpendUsd: 20,
      },
    });

    this.missions.set(mission.id, mission);
    this.createOwnerAgent(mission.id);

    if (this.llm) {
      const systemPrompt = this.ownerSystemPrompt();
      const owner = this.agentByRole(mission.id, "owner");
      this.updateAgent(owner.id, {
        status: "thinking",
        lastAction: "Processing initial user goal",
      });
      this.persist();

      void this.runOwnerLlmWithStreaming({
        missionId: mission.id,
        owner,
        systemPrompt,
        userMessage: input.goal,
        isCreation: true,
      });
    } else {
      this.persist();
    }

    return mission;
  }

  activateMission(input: ActivateMissionRequest): Mission {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const existingTask = [...this.tasks.values()].find((task) => task.missionId === mission.id);
    if (existingTask) {
      return mission;
    }

    const teamPlan = planMissionTeam(mission.goal, this.config);
    const initialTask = createTask({
      missionId: mission.id,
      title: teamPlan.initialTaskTitle,
      dependencies: [],
      contract: {
        objective: teamPlan.initialTaskObjective,
        input: {
          goal: mission.goal,
          successMetrics: mission.successMetrics,
          constraints: mission.constraints,
          teamPlan,
        },
        outputSchema: {
          teamPlan: "array",
          firstTasks: "array",
          risks: "array",
        },
        successCriteria: [
          "Every proposed role has a clear responsibility",
          "First tasks are executable and reviewable",
        ],
      },
      approvalRequired: false,
    });

    this.tasks.set(initialTask.id, initialTask);
    this.createMissionTeam(mission.id, initialTask.id, teamPlan);
    if (this.llm) {
      this.getAutonomyService().startLoop(mission.id);
    }
    if (mission.scheduleRules.length > 0) {
      this.getOrCreateScheduler(mission.id).start(mission.scheduleRules);
    }
    this.persist();
    return mission;
  }

  beginMissionActivation(input: ActivateMissionRequest): Mission {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    this.assertMissionPlanReadyForActivation(mission.id);
    const existingTask = [...this.tasks.values()].find((task) => task.missionId === mission.id);
    if (existingTask) {
      return mission;
    }

    const hr = this.createBaseAgent(mission.id, "hr", {
      status: "running",
      lastAction: "正在分析 MissionBrief 并招募团队",
    });
    const alreadyAnnounced = [...this.agentMessages.values()].some(
      (message) => message.missionId === mission.id
        && message.fromAgentId === hr.id
        && message.type === "team_created"
        && message.content.includes("正在分析 MissionBrief"),
    );
    if (!alreadyAnnounced) {
      this.appendMessage({
        missionId: mission.id,
        fromAgentId: hr.id,
        type: "team_created",
        content: "HR Agent 正在分析 MissionBrief、拆解需要的角色，并招募 Mission 团队。",
      });
    }
    this.persist();
    return mission;
  }

  async activateMissionWithHR(input: ActivateMissionRequest): Promise<Mission> {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    this.assertMissionPlanReadyForActivation(mission.id);
    const existingTask = [...this.tasks.values()].find((task) => task.missionId === mission.id);
    if (existingTask) {
      return mission;
    }

    if (!this.llm || !mission.brief) {
      return this.activateMission(input);
    }

    try {
      await this.getNegotiationManager().startNegotiation(input, mission);

      const owner = this.agentByRole(mission.id, "owner");
      this.updateAgent(owner.id, {
        status: "idle",
        lastAction: "Reviewing HR team proposal",
      });

      this.persist();
      return this.missions.get(mission.id)!;
    } catch (error) {
      console.error("[MissionService] HR-based activation failed, falling back to keyword:", error instanceof Error ? error.message : String(error));
      return this.activateMission(input);
    }
  }

  async continueMission(input: ContinueMissionRequest): Promise<Mission> {
    const message = input.message.trim();
    if (!message) {
      throw new Error("Mission continuation message is required");
    }
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }

    const owner = this.agentByRole(mission.id, "owner");
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: "user",
      toAgentId: owner.id,
      type: "user_message",
      content: message,
    });
    this.updateAgent(owner.id, {
      status: "thinking",
      lastAction: "Processing user follow-up",
    });
    this.persist();

    if (this.llm) {
      const history = this.agentMessagesForMission(mission.id);
      const systemPrompt = this.ownerSystemPrompt();
      const userTurns = history.filter((msg) => msg.type === "user_message").length;
      const maxTurns = this.config.owner.prompts?.maxGatheringTurns ?? 5;

      let llmMessages;
      if (userTurns >= maxTurns) {
        llmMessages = buildSummaryRequest(systemPrompt, history);
      } else {
        llmMessages = buildConversationMessages(systemPrompt, history, message);
      }

      void this.runOwnerLlmWithStreaming({
        missionId: mission.id,
        owner,
        systemPrompt,
        llmMessages,
        isCreation: false,
      });
    } else {
      this.appendMessage({
        missionId: mission.id,
        fromAgentId: owner.id,
        type: "owner_followup",
        content: deriveOwnerFollowup(message, this.config),
      });
      this.persist();
    }

    const currentMission = this.missions.get(mission.id);
    if (!currentMission) throw new Error("Mission disappeared");
    return currentMission;
  }

  confirmBrief(input: { missionId: string }): Mission {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    if (!mission.brief) {
      throw new Error("Mission has no brief to confirm");
    }
    if (mission.briefConfirmed) {
      return mission;
    }

    const updated: Mission = {
      ...mission,
      successMetrics: [...mission.brief.successMetrics],
      constraints: [...mission.brief.constraints],
      briefConfirmed: true,
    };
    this.missions.set(updated.id, updated);
    const owner = this.agentByRole(mission.id, "owner");
    this.updateAgent(owner.id, {
      status: "idle",
      lastAction: "MissionBrief confirmed by user",
    });
    this.persist();
    return updated;
  }

  async generateMissionPlan(input: { missionId: string; feedback?: string }): Promise<MissionPlan> {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    if (!mission.brief || mission.briefConfirmed !== true) {
      throw new Error("MissionBrief must be confirmed before generating a MissionPlan");
    }
    if (!this.llm) {
      throw new Error("LLM is required to generate a MissionPlan");
    }

    const response = await this.llm.call(
      buildMissionPlanMessages({
        brief: mission.brief,
        ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
      }),
      {
        maxTokens: 3000,
        timeoutMs: 90000,
      },
    );
    const draft = parseMissionPlanDraft(response.content);
    const existingPlans = [...this.plans.values()].filter((plan) => plan.missionId === mission.id);
    const revision = existingPlans.length + 1;

    for (const plan of existingPlans) {
      if (plan.status === "draft") {
        this.plans.set(plan.id, { ...plan, status: "superseded" });
      }
    }

    const plan: MissionPlan = {
      id: createId("plan"),
      missionId: mission.id,
      status: "draft",
      createdAt: new Date(),
      revision,
      ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
      ...draft,
    };
    this.plans.set(plan.id, plan);
    const owner = this.agentByRole(mission.id, "owner");
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: owner.id,
      type: "task_plan",
      content: `Owner generated MissionPlan revision ${plan.revision}.`,
    });
    this.persist();
    return plan;
  }

  confirmMissionPlan(input: { missionId: string; planId: string }): Mission {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const plan = this.plans.get(input.planId);
    if (!plan || plan.missionId !== mission.id) {
      throw new Error(`MissionPlan not found in mission: ${input.planId}`);
    }
    if (plan.status !== "draft") {
      throw new Error(`Only draft MissionPlan can be confirmed: ${input.planId}`);
    }

    for (const candidate of this.plans.values()) {
      if (candidate.missionId === mission.id && candidate.id !== plan.id && candidate.status === "confirmed") {
        this.plans.set(candidate.id, { ...candidate, status: "superseded" });
      }
    }

    const confirmed: MissionPlan = {
      ...plan,
      status: "confirmed",
      confirmedAt: plan.confirmedAt ?? new Date(),
    };
    this.plans.set(confirmed.id, confirmed);
    const updatedMission: Mission = {
      ...mission,
      confirmedPlanId: confirmed.id,
    };
    this.missions.set(updatedMission.id, updatedMission);
    this.persist();
    return updatedMission;
  }

  getMissionPlan(input: { missionId: string; planId?: string }): MissionPlan | undefined {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    if (input.planId !== undefined) {
      const plan = this.plans.get(input.planId);
      return plan?.missionId === mission.id ? plan : undefined;
    }
    const latestDraft = this.getLatestDraftMissionPlan(mission.id);
    if (latestDraft) {
      return latestDraft;
    }
    if (!mission.confirmedPlanId) return undefined;
    return this.getConfirmedMissionPlan(mission);
  }

  startExecution(input: StartExecutionRequest): Execution {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }

    const task = this.tasks.get(input.taskId);
    if (!task || task.missionId !== mission.id) {
      throw new Error(`Task not found in mission: ${input.taskId}`);
    }

    const existing = [...this.executions.values()].find(
      (execution) => execution.taskId === task.id && execution.status === "running",
    );
    if (existing) {
      throw new Error(`Task already has a running execution: ${task.id}`);
    }

    const runningTask = ensureTaskRunning(task);
    this.tasks.set(runningTask.id, runningTask);
    const worker = this.executionAgent(mission.id);
    const planner = this.planningAgent(mission.id);
    this.updateAgent(worker.id, {
      status: "running",
      currentTaskId: runningTask.id,
      lastAction: `Executing ${runningTask.title}`,
    });
    this.updateAgent(planner.id, {
      status: "done",
      lastAction: "Task handed to Worker Agent",
    });

    const execution: Execution = {
      id: createId("execution"),
      missionId: mission.id,
      taskId: runningTask.id,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.executions.set(execution.id, execution);
    const toolCallId = createId("toolcall");
    this.toolCalls.set(toolCallId, {
      id: toolCallId,
      missionId: mission.id,
      taskId: runningTask.id,
      executionId: execution.id,
      agentId: worker.id,
      toolName: "openclaw.agent",
      status: "running",
      input: { taskId: runningTask.id },
      startedAt: execution.startedAt,
    });
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: worker.id,
      type: "execution_started",
      content: "Started local OpenClaw execution for the current task.",
    });
    this.appendTaskEvent({
      missionId: mission.id,
      taskId: runningTask.id,
      actorAgentId: worker.id,
      type: "execution.started",
      summary: `${worker.name} invoked OpenClaw local agent.`,
    });
    this.persist();
    return execution;
  }

  submitExecutionResult(input: SubmitExecutionResultRequest): { artifact: Artifact; review: Review } {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }

    const task = this.tasks.get(input.taskId);
    if (!task || task.missionId !== mission.id) {
      throw new Error(`Task not found in mission: ${input.taskId}`);
    }

    const execution = this.executions.get(input.executionId);
    if (!execution || execution.taskId !== task.id || execution.status !== "running") {
      throw new Error(`Running execution not found: ${input.executionId}`);
    }

    const runningTask = task.status === "running" ? task : ensureTaskRunning(task);
    const qualityResult = evaluateArtifactQuality(input.content, mission);
    const artifact = createArtifact({
      taskId: runningTask.id,
      type: "execution_log",
      content: input.content,
      evidence: input.evidence,
      sources: input.sources,
      qualityScore: qualityResult.score,
    });
    const submittedTask = transitionTask(runningTask, {
      type: "artifact.submitted",
      artifactId: artifact.id,
    });
    const reviewingTask = transitionTask(submittedTask, { type: "review.started" });
    const worker = this.executionAgent(mission.id);
    const reviewer = this.reviewAgent(mission.id);
    const review = createReview({
      artifactId: artifact.id,
      reviewerAgentId: reviewer.id,
      decision: qualityResult.decision,
      comments: qualityResult.comments,
    });
    const transitionEvent = review.decision === "approve"
      ? { type: "review.approved" as const, reviewId: review.id }
      : review.decision === "revise"
        ? { type: "review.revision_requested" as const, reviewId: review.id }
        : { type: "review.rejected" as const, reviewId: review.id, reason: qualityResult.comments.join("; ") };
    const resultTask = transitionTask(reviewingTask, transitionEvent);

    this.artifacts.set(artifact.id, artifact);
    this.reviews.set(review.id, review);
    const feedback = buildExecutionResultFeedback({
      mission,
      task: resultTask,
      artifact,
      review,
    });
    this.recordExecutionResultFeedback(feedback);
    this.tasks.set(resultTask.id, resultTask);
    const toolCall = this.toolCallByExecution(execution.id);
    this.toolCalls.set(toolCall.id, {
      ...toolCall,
      status: "completed",
      output: { artifactId: artifact.id },
      completedAt: new Date().toISOString(),
    });
    this.updateAgent(worker.id, {
      status: "done",
      currentTaskId: undefined,
      lastAction: "Submitted execution artifact",
    });
    this.updateAgent(reviewer.id, {
      status: "done",
      lastAction: `Review decision: ${review.decision}`,
    });
    const decisionId = createId("decision");
    this.decisions.set(decisionId, {
      id: decisionId,
      missionId: mission.id,
      taskId: task.id,
      reviewerAgentId: reviewer.id,
      decision: review.decision,
      rationale: qualityResult.comments.join("; "),
      createdAt: new Date().toISOString(),
    });
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: worker.id,
      toAgentId: reviewer.id,
      type: "execution_completed",
      content: "Execution completed and artifact submitted for review.",
    });
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: reviewer.id,
      toAgentId: worker.id,
      type: "review_completed",
      content: `Review completed: ${review.decision}. ${qualityResult.comments.join("; ")}`,
    });
    this.appendTaskEvent({
      missionId: mission.id,
      taskId: task.id,
      actorAgentId: reviewer.id,
      type: "review.completed",
      summary: `Reviewer returned ${review.decision}.`,
    });
    this.appendTaskEvent({
      missionId: mission.id,
      taskId: task.id,
      actorAgentId: reviewer.id,
      type: "feedback.evaluated",
      summary: feedback.evaluation.summary,
    });
    this.executions.set(execution.id, {
      ...execution,
      status: "completed",
      completedAt: new Date().toISOString(),
      artifactId: artifact.id,
      reviewId: review.id,
    });

    this.persist();
    void this.dispatchToBus({
      type: "execution_completed",
      agentId: worker.id,
      taskId: task.id,
      artifactId: artifact.id,
    }, mission.id);
    void this.evaluateScheduleConditions(mission, resultTask, input.content);
    return { artifact, review };
  }

  failExecution(input: FailExecutionRequest): Execution {
    if (!input.error.trim()) {
      throw new Error("Execution error is required");
    }

    const execution = this.executions.get(input.executionId);
    if (!execution || execution.status !== "running") {
      throw new Error(`Running execution not found: ${input.executionId}`);
    }

    const completedAt = new Date().toISOString();
    const failed: Execution = {
      ...execution,
      status: "failed",
      completedAt,
      error: input.error,
    };
    this.executions.set(failed.id, failed);
    const toolCall = this.toolCallByExecution(execution.id);
    this.toolCalls.set(toolCall.id, {
      ...toolCall,
      status: "failed",
      error: input.error,
      completedAt,
    });
    const worker = this.executionAgent(execution.missionId);
    this.updateAgent(worker.id, {
      status: "blocked",
      lastAction: `Execution failed: ${input.error}`,
    });
    this.appendMessage({
      missionId: execution.missionId,
      fromAgentId: worker.id,
      type: "execution_failed",
      content: input.error,
    });
    this.appendTaskEvent({
      missionId: execution.missionId,
      taskId: execution.taskId,
      actorAgentId: worker.id,
      type: "execution.failed",
      summary: input.error,
    });
    const mission = this.requireMission(execution.missionId);
    const task = this.tasks.get(execution.taskId);
    if (!task || task.missionId !== mission.id) {
      throw new Error(`Task not found in mission: ${execution.taskId}`);
    }
    const feedback = buildExecutionFailureFeedback({
      mission,
      task,
      error: input.error,
    });
    this.recordExecutionFailureFeedback(feedback);
    this.appendTaskEvent({
      missionId: execution.missionId,
      taskId: execution.taskId,
      actorAgentId: worker.id,
      type: "feedback.evaluated",
      summary: feedback.evaluation.summary,
    });
    this.persist();
    void this.dispatchToBus({
      type: "execution_failed",
      agentId: worker.id,
      taskId: execution.taskId,
      error: input.error,
    }, execution.missionId);
    return failed;
  }

  getAutopilotDiagnosis(missionId: string, runtime: AutopilotRuntimeSignals): AutopilotDiagnosis {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    assertAutopilotRuntimeSignals(runtime);

    const missionExecutions = [...this.executions.values()].filter((execution) => execution.missionId === missionId);
    const missionAgents = [...this.agents.values()].filter((agent) => agent.missionId === missionId);
    const executableTasks = [...this.tasks.values()].filter(
      (task) =>
        task.missionId === missionId &&
        task.status !== "completed" &&
        task.status !== "failed" &&
        task.status !== "cancelled",
    );

    const latestExecutionByTask = new Map<string, Execution>();
    for (const execution of missionExecutions) {
      const existing = latestExecutionByTask.get(execution.taskId);
      if (!existing) {
        latestExecutionByTask.set(execution.taskId, execution);
        continue;
      }
      const executionTime = execution.completedAt ?? execution.startedAt;
      const existingTime = existing.completedAt ?? existing.startedAt;
      if (executionTime >= existingTime) {
        latestExecutionByTask.set(execution.taskId, execution);
      }
    }

    const latestExecutions = [...latestExecutionByTask.values()];
    const hasRunningExecution = missionExecutions.some((execution) => execution.status === "running");
    const hasFailedExecution = latestExecutions.some((execution) => execution.status === "failed");
    const hasBlockedExecutionAgent = missionAgents.some(
      (agent) => agent.role !== "owner" && agent.role !== "hr" && agent.status === "blocked",
    );
    const signals: AutopilotDiagnosisSignals = {
      briefConfirmed: mission.briefConfirmed === true,
      hasPlan: this.hasConfirmedMissionPlan(mission),
      teamReady: missionAgents.some(
        (agent) => agent.role !== "owner" && agent.role !== "hr" && agent.status !== "blocked" && agent.status !== "done",
      ),
      hasInitialTasks: executableTasks.length > 0,
      hasExecutionRunner: runtime.hasExecutionRunner,
      hasScheduleRules: mission.scheduleRules.length > 0,
      hasRunningExecution,
    };
    const prerequisitesReady =
      signals.briefConfirmed &&
      signals.hasPlan &&
      signals.teamReady &&
      signals.hasInitialTasks &&
      signals.hasExecutionRunner &&
      signals.hasScheduleRules;

    const blockers: AutopilotBlocker[] = [];
    if (prerequisitesReady && (hasFailedExecution || hasBlockedExecutionAgent)) {
      blockers.push({
        code: "execution_blocked",
        message: "The latest execution for a task failed, or an execution team agent is blocked.",
        nextAction: "Inspect the unresolved failed execution or blocked execution agent, fix the root cause, then retry the task.",
      });
    }
    if (!signals.briefConfirmed) {
      blockers.push({
        code: "brief_not_confirmed",
        message: "MissionBrief has not been confirmed.",
        nextAction: "Confirm the MissionBrief before starting autopilot bootstrap.",
      });
    }
    if (signals.briefConfirmed && !signals.hasPlan) {
      blockers.push({
        code: "mission_plan_missing",
        message: "MissionBrief is confirmed, but no confirmed MissionPlan exists.",
        nextAction: "Generate and confirm a MissionPlan before treating the mission as autopilot-ready.",
      });
    }
    if (signals.briefConfirmed && signals.hasPlan && !signals.teamReady) {
      blockers.push({
        code: "team_not_ready",
        message: "No execution team agent exists for this mission.",
        nextAction: "Assemble the mission team so non-owner execution agents are available.",
      });
    }
    if (signals.briefConfirmed && signals.hasPlan && signals.teamReady && !signals.hasInitialTasks) {
      blockers.push({
        code: "initial_tasks_missing",
        message: "No executable initial mission task exists.",
        nextAction: "Create an initial task before runner or schedule readiness can be evaluated.",
      });
    }
    if (signals.briefConfirmed && signals.hasPlan && signals.teamReady && signals.hasInitialTasks && !signals.hasExecutionRunner) {
      blockers.push({
        code: "execution_runner_missing",
        message: "Executable tasks exist, but no execution runner is available.",
        nextAction: "Provide an execution runner availability signal before launching autopilot execution.",
      });
    }
    if (
      signals.briefConfirmed &&
      signals.hasPlan &&
      signals.teamReady &&
      signals.hasInitialTasks &&
      signals.hasExecutionRunner &&
      !signals.hasScheduleRules
    ) {
      blockers.push({
        code: "schedule_rules_missing",
        message: "No schedule rules are registered for this mission.",
        nextAction: "Register at least one schedule rule after the mission is otherwise ready.",
      });
    }

    let stage: AutopilotStage = "ready";
    if (!signals.briefConfirmed) {
      stage = "briefing";
    } else if (!signals.hasPlan) {
      stage = "missing_plan";
    } else if (!signals.teamReady) {
      stage = "team_not_ready";
    } else if (!signals.hasInitialTasks) {
      stage = "missing_initial_tasks";
    } else if (!signals.hasExecutionRunner) {
      stage = "missing_execution_runner";
    } else if (!signals.hasScheduleRules) {
      stage = "missing_schedule";
    } else if (hasFailedExecution || hasBlockedExecutionAgent) {
      stage = "blocked";
    } else if (signals.hasRunningExecution) {
      stage = "running";
    }

    return {
      missionId,
      stage,
      ready: stage === "ready" || stage === "running",
      blockers,
      signals,
    };
  }

  snapshot(): MissionSnapshot {
    return {
      missions: [...this.missions.values()],
      plans: [...this.plans.values()],
      tasks: [...this.tasks.values()],
      artifacts: [...this.artifacts.values()],
      reviews: [...this.reviews.values()],
      executions: [...this.executions.values()],
      agents: [...this.agents.values()].sort((a, b) => a.sortOrder - b.sortOrder),
      agentRelations: [...this.agentRelations.values()],
      agentMessages: [...this.agentMessages.values()],
      threads: [...this.threads.values()],
      taskEvents: [...this.taskEvents.values()],
      scheduleTriggerEvents: [...this.scheduleTriggerEvents.values()],
      toolCalls: [...this.toolCalls.values()],
      decisions: [...this.decisions.values()],
      knowledgeEntries: [...this.knowledgeEntries.values()],
      missionOutcomeEvaluations: [...this.missionOutcomeEvaluations.values()],
      taskFailureAnalyses: [...this.taskFailureAnalyses.values()],
      strategyAdjustments: [...this.strategyAdjustments.values()],
    };
  }

  publicConfig(): Pick<AgentSystemConfig, "ui"> {
    return { ui: this.config.ui };
  }

  async startNegotiation(input: { missionId: string }): Promise<TeamProposal> {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const result = await this.getNegotiationManager().startNegotiation(input, mission);
    this.persist();
    return result;
  }

  async respondToNegotiation(input: { missionId: string; feedback: string }): Promise<{ proposal: TeamProposal; summary?: NegotiationSummary }> {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const result = await this.getNegotiationManager().respondToNegotiation(input, mission);
    this.persist();
    return result;
  }

  confirmNegotiation(input: { missionId: string }): Mission {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    this.getNegotiationManager().confirmNegotiation(input, mission);
    if (this.llm) {
      this.getAutonomyService().startLoop(mission.id);
    }
    const updated = this.missions.get(mission.id);
    if (updated && updated.scheduleRules.length > 0) {
      this.getOrCreateScheduler(updated.id).start(updated.scheduleRules);
    }
    this.persist();
    return this.missions.get(mission.id)!;
  }

  addScheduleRule(missionId: string, rule: ScheduleRule): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const ruleToAdd = isAutomationPaused(mission.scheduleRules) ? applyAutomationTogglePause(rule) : rule;
    const updated: Mission = {
      ...mission,
      scheduleRules: [...mission.scheduleRules, ruleToAdd],
    };
    this.missions.set(updated.id, updated);
    if (updated.status === "active") {
      const scheduler = this.getOrCreateScheduler(missionId);
      if (scheduler.isRunning()) {
        scheduler.addRule(ruleToAdd);
      } else {
        scheduler.start(updated.scheduleRules);
      }
    } else {
      this.getOrCreateScheduler(missionId).addRule(ruleToAdd);
    }
    this.persist();
  }

  createScheduleRuleFromTemplate(missionId: string, input: ScheduleTemplateRequest): ScheduleRule {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const automationPaused = isAutomationPaused(mission.scheduleRules);

    let ruleInput: Parameters<typeof createScheduleRule>[0];
    if (input.templateType === "daily_check" || input.templateType === "weekly_review") {
      const isDaily = input.templateType === "daily_check";
      ruleInput = {
        name: isDaily ? "Daily check" : "Weekly review",
        missionId,
        enabled: !automationPaused,
        trigger: {
          type: "cron",
          expression: isDaily ? "0 9 * * *" : "0 9 * * 1",
          timezone: "UTC",
        },
        taskTemplate: {
          title: input.taskGoal,
          contract: {
            objective: input.taskGoal,
            input: {
              missionGoal: mission.goal,
              templateType: input.templateType,
            },
            outputSchema: { summary: "string", nextActions: "array" },
            successCriteria: ["The result directly addresses the task goal", "The result includes concrete next actions"],
          },
          assigneeRole: input.assigneeRole,
          priority: "normal",
        },
        maxConcurrent: 1,
        metadata: {
          createdBy: "user_template",
          templateType: input.templateType,
          ...(automationPaused ? { pausedByAutomationToggle: true } : {}),
        },
      };
    } else if (input.templateType === "condition_response") {
      ruleInput = {
        name: "Condition response",
        missionId,
        enabled: !automationPaused,
        trigger: {
          type: "condition",
          description: input.condition,
          sourceAgentRole: input.sourceAgentRole,
          evaluatePrompt: `Return true when this condition is met: ${input.condition}`,
        },
        taskTemplate: {
          title: input.responseTaskGoal,
          contract: {
            objective: input.responseTaskGoal,
            input: {
              missionGoal: mission.goal,
              condition: input.condition,
              templateType: input.templateType,
            },
            outputSchema: { diagnosis: "string", recommendation: "string", nextActions: "array" },
            successCriteria: ["The response addresses the condition", "The recommendation is actionable"],
          },
          assigneeRole: input.responseAssigneeRole,
          priority: "high",
        },
        maxConcurrent: 1,
        metadata: {
          createdBy: "user_template",
          templateType: input.templateType,
          ...(automationPaused ? { pausedByAutomationToggle: true } : {}),
        },
      };
    } else {
      const unsupported = (input as { templateType?: string }).templateType;
      throw new Error(`Unsupported schedule template: ${String(unsupported)}`);
    }

    const rule = createScheduleRule(ruleInput);
    this.addScheduleRule(missionId, rule);
    return isAutomationPaused(mission.scheduleRules) ? applyAutomationTogglePause(rule) : rule;
  }

  removeScheduleRule(missionId: string, ruleId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const updated: Mission = {
      ...mission,
      scheduleRules: mission.scheduleRules.filter((rule) => rule.id !== ruleId),
    };
    this.missions.set(updated.id, updated);
    this.schedulers.get(missionId)?.removeRule(ruleId);
    this.persist();
  }

  updateScheduleRule(missionId: string, ruleId: string, patch: Partial<ScheduleRule>): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const nextRules = mission.scheduleRules.map((rule) => {
      if (rule.id !== ruleId) return rule;
      const metadata = patch.enabled === undefined ? patch.metadata : clearAutomationTogglePause({
        ...rule.metadata,
        ...patch.metadata,
      });
      const candidate: ScheduleRule = {
        ...rule,
        ...patch,
        ...(metadata === undefined ? {} : { metadata }),
        id: rule.id,
        missionId: rule.missionId,
      };
      validateScheduleRule(candidate);
      return candidate;
    });
    if (!nextRules.some((rule) => rule.id === ruleId)) {
      throw new Error(`Schedule rule not found: ${ruleId}`);
    }
    const updated: Mission = {
      ...mission,
      scheduleRules: nextRules,
    };
    this.missions.set(updated.id, updated);
    const scheduler = this.schedulers.get(missionId);
    if (scheduler) {
      const updatedRule = nextRules.find((rule) => rule.id === ruleId);
      const schedulerPatch =
        patch.enabled === undefined || !updatedRule
          ? patch
          : {
              ...patch,
              metadata: updatedRule.metadata,
            };
      if (patch.trigger !== undefined && updated.status === "active") {
        scheduler.restart(updated.scheduleRules);
      } else {
        scheduler.updateRule(ruleId, schedulerPatch);
      }
    }
    this.persist();
  }

  pauseMissionAutomation(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const updatedRules = mission.scheduleRules.map((rule) => {
      if (!rule.enabled) return rule;
      return {
        ...rule,
        enabled: false,
        metadata: {
          ...rule.metadata,
          pausedByAutomationToggle: true,
        },
      };
    });
    this.missions.set(mission.id, { ...mission, scheduleRules: updatedRules });
    if (mission.status === "active") {
      this.schedulers.get(missionId)?.restart(updatedRules);
    }
    this.persist();
  }

  resumeMissionAutomation(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const updatedRules = mission.scheduleRules.map((rule) => {
      if (rule.metadata.pausedByAutomationToggle !== true) return rule;
      const { pausedByAutomationToggle: _paused, ...metadata } = rule.metadata;
      return {
        ...rule,
        enabled: true,
        metadata,
      };
    });
    this.missions.set(mission.id, { ...mission, scheduleRules: updatedRules });
    if (mission.status === "active") {
      this.schedulers.get(missionId)?.restart(updatedRules);
    }
    this.persist();
  }

  getScheduleRules(missionId: string): ScheduleRule[] {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    return [...mission.scheduleRules];
  }

  getScheduleRuleNextRunAt(missionId: string, ruleId: string): string | undefined {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    return this.schedulers.get(missionId)?.getNextRunAt(ruleId);
  }

  getAutomationSummary(missionId: string): AutomationSummary {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }

    const rules = mission.scheduleRules;
    const agents = [...this.agents.values()].filter((agent) => agent.missionId === missionId);
    const agentByRole = new Map(agents.map((agent) => [agent.role, agent]));
    const currentScheduledTasks = [...this.tasks.values()]
      .filter((task) => task.missionId === missionId && task.scheduleRuleId)
      .filter((task) => task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")
      .map((task) => ({
        taskId: task.id,
        ruleId: task.scheduleRuleId!,
        title: task.title,
        status: task.status,
        ...(task.assigneeAgentId ? { assigneeAgentId: task.assigneeAgentId } : {}),
      }));

    const nextAction = rules
      .filter((rule) => rule.enabled && rule.trigger.type === "cron")
      .map((rule) => {
        const nextRunAt = this.getScheduleRuleNextRunAt(missionId, rule.id);
        if (!nextRunAt) return undefined;
        const assignee = agentByRole.get(rule.taskTemplate.assigneeRole);
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          nextRunAt,
          assigneeRole: rule.taskTemplate.assigneeRole,
          ...(assignee ? { assigneeAgentId: assignee.id } : {}),
          taskTitle: rule.taskTemplate.title,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];

    const lastTriggerEvent = [...this.scheduleTriggerEvents.values()]
      .filter((event) => event.missionId === missionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    return {
      missionId,
      rulesCount: rules.length,
      automationPaused: isAutomationPaused(rules),
      currentScheduledTasks,
      ...(nextAction ? { nextAction } : {}),
      ...(lastTriggerEvent
        ? {
            lastTrigger: {
              ruleId: lastTriggerEvent.ruleId,
              ruleName: lastTriggerEvent.ruleName,
              ...(lastTriggerEvent.taskId ? { taskId: lastTriggerEvent.taskId } : {}),
              status: lastTriggerEvent.status,
              message: lastTriggerEvent.message,
              createdAt: lastTriggerEvent.createdAt,
            },
          }
      : {}),
    };
  }

  getMissionOutcomeEvaluations(missionId: string): MissionOutcomeEvaluation[] {
    this.requireMission(missionId);
    return [...this.missionOutcomeEvaluations.values()].filter((record) => record.missionId === missionId);
  }

  getTaskFailureAnalyses(missionId: string): TaskFailureAnalysis[] {
    this.requireMission(missionId);
    return [...this.taskFailureAnalyses.values()].filter((record) => record.missionId === missionId);
  }

  getStrategyAdjustments(missionId: string): StrategyAdjustment[] {
    this.requireMission(missionId);
    return [...this.strategyAdjustments.values()].filter((record) => record.missionId === missionId);
  }

  updateStrategyAdjustmentStatus(
    missionId: string,
    adjustmentId: string,
    newStatus: StrategyAdjustmentStatus,
  ): StrategyAdjustment {
    this.requireMission(missionId);
    const adjustment = this.strategyAdjustments.get(adjustmentId);
    if (!adjustment) {
      throw new Error(`Strategy adjustment not found: ${adjustmentId}`);
    }
    if (adjustment.missionId !== missionId) {
      throw new Error(`Strategy adjustment does not belong to mission: ${missionId}`);
    }
    const validTransitions: Record<StrategyAdjustmentStatus, StrategyAdjustmentStatus[]> = {
      proposed: ["accepted", "rejected"],
      accepted: ["superseded"],
      rejected: [],
      superseded: [],
    };
    if (!validTransitions[adjustment.status].includes(newStatus)) {
      throw new Error(`Cannot transition from ${adjustment.status} to ${newStatus}`);
    }
    const updated: StrategyAdjustment = { ...adjustment, status: newStatus };
    this.strategyAdjustments.set(adjustmentId, updated);
    this.persist();
    return updated;
  }

  getFeedbackSummary(missionId: string): FeedbackSummary {
    const evaluations = this.getMissionOutcomeEvaluations(missionId);
    const failureAnalyses = this.getTaskFailureAnalyses(missionId);
    const strategyAdjustments = this.getStrategyAdjustments(missionId);
    const byCreatedAt = <T extends { createdAt: string }>(records: T[]) =>
      [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latestEvaluation = byCreatedAt(evaluations)[0];
    const latestFailureAnalysis = byCreatedAt(failureAnalyses)[0];
    const latestStrategyAdjustment = byCreatedAt(strategyAdjustments)[0];
    return {
      missionId,
      ...(latestEvaluation === undefined ? {} : { latestEvaluation }),
      ...(latestFailureAnalysis === undefined ? {} : { latestFailureAnalysis }),
      ...(latestStrategyAdjustment === undefined ? {} : { latestStrategyAdjustment }),
      counts: {
        evaluations: evaluations.length,
        failureAnalyses: failureAnalyses.length,
        strategyAdjustments: strategyAdjustments.length,
      },
    };
  }

  triggerScheduleRule(missionId: string, ruleId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const rule = mission.scheduleRules.find((candidate) => candidate.id === ruleId);
    if (!rule) {
      throw new Error(`Schedule rule not found: ${ruleId}`);
    }
    this.createTaskFromScheduleRule(mission, rule);
    this.persist();
  }

  triggerNextScheduleRule(missionId: string): Task {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }

    const candidates = mission.scheduleRules
      .filter((rule) => rule.enabled && rule.trigger.type === "cron")
      .map((rule) => ({
        rule,
        nextRunAt: this.getScheduleRuleNextRunAt(missionId, rule.id) ?? "",
      }))
      .filter((candidate) => candidate.nextRunAt);

    if (candidates.length === 0) {
      throw new Error("No enabled cron schedule rule available");
    }

    const nowIso = new Date().toISOString();
    const sortedCandidates = [...candidates].sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
    const overdue = sortedCandidates.filter((candidate) => candidate.nextRunAt <= nowIso);
    const selected = (overdue[0] ?? sortedCandidates[0])?.rule;
    if (!selected) {
      throw new Error("No enabled cron schedule rule available");
    }

    let task: Task;
    try {
      task = this.createTaskFromScheduleRuleStrict(mission, selected);
    } catch (error) {
      try {
        this.persist();
      } catch {
        // Preserve the original fast-fail domain error.
      }
      throw error;
    }
    this.persist();
    return task;
  }

  restoreSchedulers(): void {
    for (const mission of this.missions.values()) {
      if (mission.status === "active" && mission.scheduleRules.length > 0) {
        this.getOrCreateScheduler(mission.id).start(mission.scheduleRules);
      }
    }
  }

  getNegotiation(input: { missionId: string }): { proposal: TeamProposal; previousFeedback: string[] } | undefined {
    return this.negotiationManager?.getNegotiation(input);
  }

  setKnowledge(input: { missionId: string; key: string; value: string; agentId: string }): KnowledgeEntry {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const existing = [...this.knowledgeEntries.values()].find(
      (entry) => entry.missionId === input.missionId && entry.key === input.key,
    );
    if (existing) {
      const updated: KnowledgeEntry = {
        ...existing,
        value: input.value,
        sourceAgentId: input.agentId,
        createdAt: new Date().toISOString(),
      };
      this.knowledgeEntries.set(updated.id, updated);
      this.persist();
      return updated;
    }
    const entry = createKnowledgeEntry({
      missionId: input.missionId,
      key: input.key,
      value: input.value,
      sourceAgentId: input.agentId,
    });
    this.knowledgeEntries.set(entry.id, entry);
    this.persist();
    return entry;
  }

  getKnowledge(input: { missionId: string; key: string }): KnowledgeEntry | undefined {
    return [...this.knowledgeEntries.values()].find(
      (entry) => entry.missionId === input.missionId && entry.key === input.key,
    );
  }

  listKnowledge(input: { missionId: string }): KnowledgeEntry[] {
    return [...this.knowledgeEntries.values()]
      .filter((entry) => entry.missionId === input.missionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async triggerAgentConversation(input: {
    missionId: string;
    agentId: string;
    message: string;
  }): Promise<AgentMessage> {
    const content = input.message.trim();
    if (!content) {
      throw new Error("Agent conversation message is required");
    }
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const agent = this.agents.get(input.agentId);
    if (!agent || agent.missionId !== mission.id) {
      throw new Error(`Agent not found in mission: ${input.agentId}`);
    }
    if (!this.llm) {
      throw new Error("LLM is required for agent conversation");
    }

    const thread = this.createThread({
      missionId: mission.id,
      topic: "User-triggered agent conversation",
      participantAgentIds: ["user", agent.id],
      status: "active",
    });
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: "user",
      toAgentId: agent.id,
      type: "user_message",
      content,
      threadId: thread.id,
    });
    const reply = await this.getConversationBus().dispatchEvent({
      missionId: mission.id,
      event: { type: "user_message", content, agentId: agent.id },
      threadId: thread.id,
    });
    if (!reply) {
      throw new Error(`Agent conversation produced no reply: ${agent.id}`);
    }
    this.persist();
    return reply;
  }

  listThreads(input: { missionId: string }): ConversationThread[] {
    return [...this.threads.values()]
      .filter((thread) => thread.missionId === input.missionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getThread(input: { threadId: string }): { thread: ConversationThread; messages: AgentMessage[] } | undefined {
    const thread = this.threads.get(input.threadId);
    if (!thread) return undefined;
    return {
      thread,
      messages: this.agentMessagesForMission(thread.missionId).filter((message) => message.threadId === thread.id),
    };
  }

  subscribeToMissionStream(missionId: string, listener: StreamEventListener): StreamSubscription {
    if (!this.streamListeners.has(missionId)) {
      this.streamListeners.set(missionId, new Set());
    }
    this.streamListeners.get(missionId)!.add(listener);

    return {
      missionId,
      unsubscribe: () => {
        const listeners = this.streamListeners.get(missionId);
        if (listeners) {
          listeners.delete(listener);
          if (listeners.size === 0) {
            this.streamListeners.delete(missionId);
          }
        }
      },
    };
  }

  private hasConfirmedMissionPlan(mission: Mission): boolean {
    if (this.getLatestDraftMissionPlan(mission.id)) {
      return false;
    }
    if (!mission.confirmedPlanId) {
      return false;
    }
    const plan = this.getConfirmedMissionPlan(mission);
    return plan.status === "confirmed";
  }

  assertMissionPlanReadyForActivation(missionId: string): MissionPlan {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    if (this.getLatestDraftMissionPlan(mission.id)) {
      throw new Error(`Mission requires a confirmed MissionPlan before activation: ${mission.id}`);
    }
    if (!mission.confirmedPlanId) {
      throw new Error(`Mission requires a confirmed MissionPlan before activation: ${mission.id}`);
    }
    return this.getConfirmedMissionPlan(mission);
  }

  private getLatestDraftMissionPlan(missionId: string): MissionPlan | undefined {
    return [...this.plans.values()]
      .filter((plan) => plan.missionId === missionId && plan.status === "draft")
      .sort((a, b) => b.revision - a.revision)[0];
  }

  private getConfirmedMissionPlan(mission: Mission): MissionPlan {
    if (!mission.confirmedPlanId) {
      throw new Error(`Mission has no confirmed MissionPlan: ${mission.id}`);
    }
    const plan = this.plans.get(mission.confirmedPlanId);
    if (!plan) {
      throw new Error(`Confirmed MissionPlan not found: ${mission.confirmedPlanId}`);
    }
    if (plan.missionId !== mission.id) {
      throw new Error(`Confirmed MissionPlan belongs to a different mission: ${mission.confirmedPlanId}`);
    }
    if (plan.status !== "confirmed") {
      throw new Error(`Confirmed MissionPlan is not confirmed: ${mission.confirmedPlanId}`);
    }
    return plan;
  }

  private notifyStreamListeners(missionId: string, event: Parameters<StreamEventListener>[0]): void {
    const listeners = this.streamListeners.get(missionId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("[MissionService] Stream listener error:", error);
        }
      }
    }
  }

  private createOwnerAgent(missionId: string): WarRoomAgent {
    return this.createBaseAgent(missionId, "owner");
  }

  private createBaseAgent(missionId: string, role: string, patch: Partial<WarRoomAgent> = {}): WarRoomAgent {
    const existing = [...this.agents.values()].find((agent) => agent.missionId === missionId && agent.role === role);
    if (existing) {
      const updated = { ...existing, ...patch };
      this.agents.set(updated.id, updated);
      return updated;
    }
    const spec = this.config.teamPlanner.baseAgents.find((agent) => agent.role === role);
    if (!spec) {
      throw new Error(`${role} agent config is required`);
    }
    const agent: WarRoomAgent = {
      id: createId("agent"),
      missionId,
      role: spec.role,
      name: spec.name,
      responsibility: spec.responsibility,
      status: spec.status,
      currentTaskId: undefined,
      lastAction: spec.lastAction,
      avatarSeed: spec.avatarSeed,
      sortOrder: this.config.teamPlanner.baseAgents.findIndex((candidate) => candidate.role === role),
      ...patch,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  private createMissionTeam(missionId: string, firstTaskId: string, plan: MissionTeamPlan): WarRoomAgent[] {
    const createdAgents: WarRoomAgent[] = [];
    const byRole = new Map<string, WarRoomAgent>(
      [...this.agents.values()]
        .filter((agent) => agent.missionId === missionId)
        .map((agent) => [agent.role, agent]),
    );

    for (const spec of plan.agents) {
      const existing = byRole.get(spec.role);
      if (existing) {
        const updated = {
          ...existing,
          name: spec.name,
          responsibility: spec.responsibility,
          status: spec.status,
          currentTaskId: spec.currentTask ? firstTaskId : existing.currentTaskId,
          lastAction: spec.lastAction,
          avatarSeed: spec.avatarSeed,
          sortOrder: spec.sortOrder,
        };
        this.agents.set(updated.id, updated);
        byRole.set(updated.role, updated);
        createdAgents.push(updated);
        continue;
      }
      const agent: WarRoomAgent = {
        id: createId("agent"),
        missionId,
        role: spec.role,
        name: spec.name,
        responsibility: spec.responsibility,
        status: spec.status,
        currentTaskId: spec.currentTask ? firstTaskId : undefined,
        lastAction: spec.lastAction,
        avatarSeed: spec.avatarSeed,
        sortOrder: spec.sortOrder,
      };
      this.agents.set(agent.id, agent);
      createdAgents.push(agent);
      byRole.set(agent.role, agent);
    }

    for (const relationSpec of plan.relations) {
      const fromAgent = byRole.get(relationSpec.fromRole);
      const toAgent = byRole.get(relationSpec.toRole);
      if (!fromAgent || !toAgent) {
        throw new Error(`Invalid team relation: ${relationSpec.fromRole} -> ${relationSpec.toRole}`);
      }
      const relation: AgentRelation = {
        id: createId("relation"),
        missionId,
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
        label: relationSpec.label,
        status: relationSpec.status,
        createdAt: new Date().toISOString(),
      };
      this.agentRelations.set(relation.id, relation);
    }

    return createdAgents;
  }

  private getConversationBus(): AgentConversationBus {
    if (!this.llm) {
      throw new Error("LLM is required for agent conversation");
    }
    if (!this.conversationBus) {
      this.conversationBus = new AgentConversationBus({
        llm: this.llm,
        personas: this.personas,
        contextRetriever: this.contextRetriever,
        getSnapshot: () => this.snapshot(),
        appendMessage: (message) => {
          const appended = this.appendMessage(message);
          this.persist();
          return appended;
        },
        createThread: (thread) => {
          const created = this.createThread(thread);
          this.persist();
          return created;
        },
        resolveThread: (threadId) => {
          this.resolveThread(threadId);
          this.persist();
        },
        updateAgent: (id, patch) => this.updateAgent(id, patch),
        maxConversationDepth: this.config.agentCollaboration?.maxConversationDepth ?? 5,
        maxDiscussionRounds: this.config.agentCollaboration?.maxDiscussionRounds ?? 5,
        cooldownMs: this.config.agentCollaboration?.cooldownMs ?? 30_000,
      });
    }
    return this.conversationBus;
  }

  private getAutonomyService(): AgentAutonomyService {
    if (!this.llm) {
      throw new Error("LLM is required for agent autonomy");
    }
    if (!this.autonomyService) {
      const bus = this.getConversationBus();
      this.autonomyService = new AgentAutonomyService({
        config: {
          tickIntervalMs: this.config.agentAutonomy?.tickIntervalMs ?? 60_000,
          maxConcurrentEvals: this.config.agentAutonomy?.maxConcurrentEvals ?? 3,
          reportFrequencyTicks: this.config.agentAutonomy?.reportFrequencyTicks ?? 5,
        },
        llm: this.llm,
        personas: this.personas,
        contextRetriever: this.contextRetriever,
        getSnapshot: () => this.snapshot(),
        dispatchEvent: async (input) => { await bus.dispatchEvent(input); },
        appendMessage: (msg) => {
          const appended = this.appendMessage(msg);
          this.persist();
          return appended;
        },
        updateAgent: (id, patch) => this.updateAgent(id, patch),
        maxConversationDepth: this.config.agentCollaboration?.maxConversationDepth ?? 5,
      });
    }
    return this.autonomyService;
  }

  private async dispatchToBus(event: BusEvent, missionId: string): Promise<void> {
    if (!this.llm) {
      return;
    }
    try {
      await this.getConversationBus().dispatchEvent({ missionId, event });
    } catch (error) {
      console.error("[MissionService] Agent conversation dispatch failed:", error instanceof Error ? error.message : String(error));
    }
  }

  private getOrCreateScheduler(missionId: string): MissionScheduler {
    let scheduler = this.schedulers.get(missionId);
    if (scheduler) {
      return scheduler;
    }

    const deps: SchedulerDeps = {
      clock: InMemoryMissionService.realClock,
      missionId,
      findAgentByRole: (role) => {
        const agent = [...this.agents.values()].find(
          (candidate) => candidate.missionId === missionId && candidate.role === role,
        );
        return agent ? { id: agent.id, role: agent.role } : undefined;
      },
      countIncompleteTasksForRule: (ruleId) => {
        return [...this.tasks.values()].filter(
          (task) =>
            task.missionId === missionId &&
            task.scheduleRuleId === ruleId &&
            task.status !== "completed" &&
            task.status !== "failed" &&
            task.status !== "cancelled",
        ).length;
      },
      createTaskFromTemplate: (_ruleId, template, agentId) => {
        const mission = this.missions.get(missionId);
        if (!mission) throw new Error(`Mission not found: ${missionId}`);
        const ruleName = mission.scheduleRules.find((rule) => rule.id === _ruleId)?.name ?? _ruleId;
        const task = createTask({
          missionId,
          title: template.title,
          dependencies: [],
          contract: template.contract,
          approvalRequired: false,
          scheduleRuleId: _ruleId,
        });
        const assigned = { ...task, assigneeAgentId: agentId };
        this.tasks.set(assigned.id, assigned);
        this.appendMessage({
          missionId,
          fromAgentId: "system",
          type: "task_plan",
          content: `Scheduled task "${template.title}" assigned.`,
        });
        this.recordScheduleTriggerEvent({
          missionId,
          ruleId: _ruleId,
          ruleName,
          taskId: assigned.id,
          status: "created",
          message: `Scheduled task "${template.title}" created.`,
        });
        this.persist();
        return assigned;
      },
      assignTask: (taskId, agentId) => {
        const task = this.tasks.get(taskId);
        if (!task) {
          throw new Error(`Task not found: ${taskId}`);
        }
        this.tasks.set(taskId, { ...task, assigneeAgentId: agentId });
      },
      notifyOwner: (message) => {
        const owner = [...this.agents.values()].find(
          (candidate) => candidate.missionId === missionId && candidate.role === "owner",
        );
        if (!owner) return;
        this.appendMessage({
          missionId,
          fromAgentId: "system",
          toAgentId: owner.id,
          type: "agent_notify",
          content: message,
        });
        this.persist();
      },
      recordSkippedTrigger: (rule) => {
        this.recordScheduleTriggerEvent({
          missionId,
          ruleId: rule.id,
          ruleName: rule.name,
          status: "skipped",
          message: `No agent found for role "${rule.taskTemplate.assigneeRole}".`,
        });
        this.persist();
      },
      evaluateCondition: async (prompt, context) => this.evaluateConditionWithLlm(prompt, context),
    };

    scheduler = new MissionScheduler(deps);
    this.schedulers.set(missionId, scheduler);
    return scheduler;
  }

  private createTaskFromScheduleRule(mission: Mission, rule: ScheduleRule): Task | undefined {
    const agent = [...this.agents.values()].find(
      (candidate) => candidate.missionId === mission.id && candidate.role === rule.taskTemplate.assigneeRole,
    );
    if (!agent) {
      const owner = [...this.agents.values()].find(
        (candidate) => candidate.missionId === mission.id && candidate.role === "owner",
      );
      if (owner) {
        this.appendMessage({
          missionId: mission.id,
          fromAgentId: "system",
          toAgentId: owner.id,
          type: "agent_notify",
          content: `Schedule rule "${rule.name}" skipped: no agent for role "${rule.taskTemplate.assigneeRole}"`,
        });
      }
      this.recordScheduleTriggerEvent({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: rule.name,
        status: "skipped",
        message: `No agent found for role "${rule.taskTemplate.assigneeRole}".`,
      });
      return undefined;
    }

    const task = createTask({
      missionId: mission.id,
      title: rule.taskTemplate.title,
      dependencies: [],
      contract: rule.taskTemplate.contract,
      approvalRequired: false,
      scheduleRuleId: rule.id,
    });
    const assigned = { ...task, assigneeAgentId: agent.id };
    this.tasks.set(assigned.id, assigned);
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: "system",
      type: "task_plan",
      content: `Scheduled task "${rule.taskTemplate.title}" assigned to ${agent.name}.`,
    });
    this.recordScheduleTriggerEvent({
      missionId: mission.id,
      ruleId: rule.id,
      ruleName: rule.name,
      taskId: assigned.id,
      status: "created",
      message: `Scheduled task "${rule.taskTemplate.title}" created.`,
    });
    return assigned;
  }

  private createTaskFromScheduleRuleStrict(mission: Mission, rule: ScheduleRule): Task {
    if (!rule.enabled) {
      this.recordScheduleTriggerEvent({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: rule.name,
        status: "failed",
        message: "Schedule rule is disabled.",
      });
      throw new Error("Schedule rule is disabled");
    }

    const incomplete = [...this.tasks.values()].filter(
      (task) =>
        task.missionId === mission.id &&
        task.scheduleRuleId === rule.id &&
        task.status !== "completed" &&
        task.status !== "failed" &&
        task.status !== "cancelled",
    ).length;
    if (incomplete >= rule.maxConcurrent) {
      this.recordScheduleTriggerEvent({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: rule.name,
        status: "failed",
        message: "Schedule rule is already at max concurrency.",
      });
      throw new Error("Schedule rule is already at max concurrency");
    }

    const agent = [...this.agents.values()].find(
      (candidate) => candidate.missionId === mission.id && candidate.role === rule.taskTemplate.assigneeRole,
    );
    if (!agent) {
      this.recordScheduleTriggerEvent({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: rule.name,
        status: "failed",
        message: `No agent found for role "${rule.taskTemplate.assigneeRole}".`,
      });
      throw new Error(`No agent found for role "${rule.taskTemplate.assigneeRole}"`);
    }

    const task = createTask({
      missionId: mission.id,
      title: rule.taskTemplate.title,
      dependencies: [],
      contract: rule.taskTemplate.contract,
      approvalRequired: false,
      scheduleRuleId: rule.id,
    });
    const assigned = { ...task, assigneeAgentId: agent.id };
    this.tasks.set(assigned.id, assigned);
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: "system",
      type: "task_plan",
      content: `Scheduled task "${rule.taskTemplate.title}" assigned to ${agent.name}.`,
    });
    this.recordScheduleTriggerEvent({
      missionId: mission.id,
      ruleId: rule.id,
      ruleName: rule.name,
      taskId: assigned.id,
      status: "created",
      message: `Scheduled task "${rule.taskTemplate.title}" created.`,
    });
    return assigned;
  }

  private recordScheduleTriggerEvent(input: Omit<ScheduleTriggerEvent, "id" | "createdAt">): ScheduleTriggerEvent {
    const event: ScheduleTriggerEvent = {
      ...input,
      id: createId("schedule_trigger"),
      createdAt: new Date().toISOString(),
    };
    this.scheduleTriggerEvents.set(event.id, event);
    return event;
  }

  private async evaluateScheduleConditions(
    mission: Mission,
    completedTask: Task,
    artifactContent: Record<string, unknown>,
  ): Promise<void> {
    const scheduler = this.schedulers.get(mission.id);
    if (!scheduler) return;
    if (!mission.scheduleRules.some((rule) => rule.enabled && rule.trigger.type === "condition")) return;

    const assignee = completedTask.assigneeAgentId
      ? this.agents.get(completedTask.assigneeAgentId)
      : undefined;

    await scheduler.evaluateConditions({
      completedTaskAssigneeRole: assignee?.role ?? "",
      artifactContent: JSON.stringify(artifactContent),
      missionGoal: mission.goal,
    });
  }

  private async evaluateConditionWithLlm(
    prompt: string,
    context: { artifactContent: string; missionGoal: string },
  ): Promise<boolean> {
    if (!this.llm) {
      return false;
    }
    const response = await this.llm.call([
      {
        role: "system",
        content: "Evaluate whether a scheduled condition is satisfied. Respond with only true or false.",
      },
      {
        role: "user",
        content: [
          `Mission goal: ${context.missionGoal}`,
          `Condition: ${prompt}`,
          `Artifact content: ${context.artifactContent}`,
          "Is the condition satisfied?",
        ].join("\n"),
      },
    ]);
    const normalized = response.content.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new Error(`Condition evaluation returned non-boolean response: ${response.content}`);
  }

  private createThread(input: Omit<ConversationThread, "id" | "createdAt">): ConversationThread {
    const thread: ConversationThread = {
      ...input,
      id: createId("thread"),
      createdAt: new Date().toISOString(),
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  private resolveThread(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread || thread.status !== "active") {
      return;
    }
    this.threads.set(thread.id, {
      ...thread,
      status: "resolved",
      resolvedAt: new Date().toISOString(),
    });
  }

  private appendMessage(input: Omit<AgentMessage, "id" | "createdAt"> & { options?: ParsedChoice[] }): AgentMessage {
    const message: AgentMessage = {
      ...input,
      id: createId("message"),
      createdAt: new Date().toISOString(),
    };
    this.agentMessages.set(message.id, message);
    return message;
  }

  private appendTaskEvent(input: Omit<WarRoomTaskEvent, "id" | "createdAt">): void {
    const event: WarRoomTaskEvent = {
      ...input,
      id: createId("taskevent"),
      createdAt: new Date().toISOString(),
    };
    this.taskEvents.set(event.id, event);
  }

  private requireMission(missionId: string): Mission {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    return mission;
  }

  private recordExecutionResultFeedback(feedback: ExecutionResultFeedback): void {
    this.missionOutcomeEvaluations.set(feedback.evaluation.id, feedback.evaluation);
    if (feedback.failureAnalysis) {
      this.taskFailureAnalyses.set(feedback.failureAnalysis.id, feedback.failureAnalysis);
    }
    if (feedback.strategyAdjustment) {
      this.strategyAdjustments.set(feedback.strategyAdjustment.id, feedback.strategyAdjustment);
    }
    this.recordFeedbackKnowledge(feedback.evaluation);
  }

  private recordExecutionFailureFeedback(feedback: ExecutionFailureFeedback): void {
    this.missionOutcomeEvaluations.set(feedback.evaluation.id, feedback.evaluation);
    this.taskFailureAnalyses.set(feedback.failureAnalysis.id, feedback.failureAnalysis);
    this.recordFeedbackKnowledge(feedback.evaluation);
  }

  private recordFeedbackKnowledge(evaluation: MissionOutcomeEvaluation): void {
    const key = `feedback:${evaluation.taskId}:${evaluation.id}`;
    const existing = [...this.knowledgeEntries.values()].find(
      (entry) => entry.missionId === evaluation.missionId && entry.key === key,
    );
    if (existing) {
      throw new Error(`Feedback knowledge already exists: ${key}`);
    }
    const owner = [...this.agents.values()].find(
      (agent) => agent.missionId === evaluation.missionId && agent.role === "owner",
    );
    if (!owner) {
      throw new Error(`Owner agent not found for feedback knowledge: ${evaluation.missionId}`);
    }
    const entry = createKnowledgeEntry({
      missionId: evaluation.missionId,
      key,
      value: `${evaluation.outcome}: ${evaluation.summary}`,
      sourceAgentId: owner.id,
    });
    this.knowledgeEntries.set(entry.id, entry);
  }

  private agentByRole(missionId: string, role: WarRoomAgentRole): WarRoomAgent {
    const agent = [...this.agents.values()].find((candidate) => candidate.missionId === missionId && candidate.role === role);
    if (!agent) {
      throw new Error(`Agent not found for role: ${role}`);
    }
    return agent;
  }

  private ownerSystemPrompt(): string {
    const prompts = this.config.owner.prompts;
    if (!prompts) {
      return "You are a project manager. Help clarify the user's goal through conversation.";
    }
    return buildOwnerSystemPrompt(prompts.systemPrompt, prompts.gatheringInstruction, prompts.briefSchema);
  }

  private agentMessagesForMission(missionId: string): AgentMessage[] {
    return [...this.agentMessages.values()]
      .filter((message) => message.missionId === missionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private firstAgentWithCapability(missionId: string, capability: "plan" | "execute" | "review"): WarRoomAgent | undefined {
    const candidates = [...this.agents.values()]
      .filter((agent) => agent.missionId === missionId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const roleMatchers: Record<typeof capability, RegExp> = {
      plan: matcherFor(this.config.teamPlanner.capabilityMatchers.plan),
      execute: matcherFor(this.config.teamPlanner.capabilityMatchers.execute),
      review: matcherFor(this.config.teamPlanner.capabilityMatchers.review),
    };
    return candidates.find((agent) => roleMatchers[capability].test(agent.role) || roleMatchers[capability].test(agent.name));
  }

  private firstNonOrchestratorAgent(missionId: string): WarRoomAgent | undefined {
    return [...this.agents.values()]
      .filter((agent) => agent.missionId === missionId && agent.role !== "owner" && agent.role !== "hr")
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  }

  private planningAgent(missionId: string): WarRoomAgent {
    return this.firstAgentWithCapability(missionId, "plan") ?? this.agentByRole(missionId, "owner");
  }

  private executionAgent(missionId: string): WarRoomAgent {
    return this.firstAgentWithCapability(missionId, "execute") ?? this.firstNonOrchestratorAgent(missionId) ?? this.agentByRole(missionId, "owner");
  }

  private reviewAgent(missionId: string): WarRoomAgent {
    return this.firstAgentWithCapability(missionId, "review") ?? this.agentByRole(missionId, "owner");
  }

  private updateAgent(id: string, patch: Partial<WarRoomAgent>): void {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }
    this.agents.set(id, { ...agent, ...patch });
  }

  private toolCallByExecution(executionId: string): ToolCallRecord {
    const toolCall = [...this.toolCalls.values()].find((candidate) => candidate.executionId === executionId);
    if (!toolCall) {
      throw new Error(`Tool call not found for execution: ${executionId}`);
    }
    return toolCall;
  }

  private async runOwnerLlmWithStreaming(input: {
    missionId: string;
    owner: WarRoomAgent;
    systemPrompt: string;
    userMessage?: string;
    llmMessages?: { role: "system" | "user" | "assistant"; content: string }[];
    isCreation: boolean;
  }): Promise<void> {
    await runOwnerLlmStreaming(this.llm!, {
      missionId: input.missionId,
      ownerId: input.owner.id,
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      llmMessages: input.llmMessages,
      isCreation: input.isCreation,
    }, {
      getMission: (id) => this.missions.get(id),
      setMission: (m) => this.missions.set(m.id, m),
      appendMessage: (msg) => this.appendMessage(msg as any),
      updateAgent: (id, patch) => this.updateAgent(id, patch as any),
      notifyStream: (id, event) => this.notifyStreamListeners(id, event as any),
      persist: () => this.persist(),
    });

    // If isCreation=true and Owner didn't produce a MissionBrief (e.g., output task content directly),
    // re-prompt using buildSummaryRequest to ensure the mission gets a brief
    if (input.isCreation) {
      const mission = this.missions.get(input.missionId);
      if (mission && !mission.brief) {
        const history = this.agentMessagesForMission(input.missionId);
        const summaryMessages = buildSummaryRequest(input.systemPrompt, history);
        await runOwnerLlmStreaming(this.llm!, {
          missionId: input.missionId,
          ownerId: input.owner.id,
          systemPrompt: input.systemPrompt,
          userMessage: undefined,
          llmMessages: summaryMessages,
          isCreation: false,
        }, {
          getMission: (id) => this.missions.get(id),
          setMission: (m) => this.missions.set(m.id, m),
          appendMessage: (msg) => this.appendMessage(msg as any),
          updateAgent: (id, patch) => this.updateAgent(id, patch as any),
          notifyStream: (id, event) => this.notifyStreamListeners(id, event as any),
          persist: () => this.persist(),
        });
      }
    }
  }

  private loadFromFile(): void {
    if (!this.storageFile || !existsSync(this.storageFile)) {
      return;
    }

    const raw = readFileSync(this.storageFile, "utf8");
    if (!raw.trim()) {
      return;
    }
    const stored = JSON.parse(raw) as StoredMissionSnapshot;
    if (stored.schemaVersion !== 1) {
      throw new Error(`Unsupported mission store schema version: ${String(stored.schemaVersion)}`);
    }
    for (const mission of stored.missions) {
      this.missions.set(mission.id, {
        ...mission,
        createdAt: new Date(mission.createdAt),
        scheduleRules: (mission as Mission & { scheduleRules?: ScheduleRule[] }).scheduleRules ?? [],
      });
    }
    for (const plan of stored.plans ?? []) {
      const restoredPlan: MissionPlan = {
        ...plan,
        createdAt: new Date(plan.createdAt),
        ...(plan.confirmedAt !== undefined ? { confirmedAt: new Date(plan.confirmedAt) } : {}),
        ...(plan.feedback !== undefined ? { feedback: plan.feedback } : {}),
      };
      this.plans.set(restoredPlan.id, restoredPlan);
    }
    for (const task of stored.tasks) this.tasks.set(task.id, task);
    for (const artifact of stored.artifacts) this.artifacts.set(artifact.id, { ...artifact, createdAt: new Date(artifact.createdAt) });
    for (const review of stored.reviews) this.reviews.set(review.id, { ...review, createdAt: new Date(review.createdAt) });
    for (const execution of stored.executions) this.executions.set(execution.id, execution);
    for (const agent of stored.agents) this.agents.set(agent.id, agent);
    for (const relation of stored.agentRelations ?? []) this.agentRelations.set(relation.id, relation);
    for (const message of stored.agentMessages) {
      const agentMessage: AgentMessage = {
        ...message,
        options: (message as any).options,
      };
      this.agentMessages.set(message.id, agentMessage);
    }
    for (const thread of stored.threads ?? []) this.threads.set(thread.id, thread);
    for (const event of stored.taskEvents) this.taskEvents.set(event.id, event);
    for (const triggerEvent of stored.scheduleTriggerEvents ?? []) {
      this.scheduleTriggerEvents.set(triggerEvent.id, triggerEvent);
    }
    for (const call of stored.toolCalls) this.toolCalls.set(call.id, call);
    for (const decision of stored.decisions) this.decisions.set(decision.id, decision);
    for (const entry of stored.knowledgeEntries ?? []) this.knowledgeEntries.set(entry.id, entry);
    for (const evaluation of (stored.missionOutcomeEvaluations ?? []).map(parseStoredMissionOutcomeEvaluation)) {
      this.missionOutcomeEvaluations.set(evaluation.id, evaluation);
    }
    for (const analysis of (stored.taskFailureAnalyses ?? []).map(parseStoredTaskFailureAnalysis)) {
      this.taskFailureAnalyses.set(analysis.id, analysis);
    }
    for (const adjustment of (stored.strategyAdjustments ?? []).map(parseStoredStrategyAdjustment)) {
      this.strategyAdjustments.set(adjustment.id, adjustment);
    }
    if (this.deduplicateHrAgents()) {
      this.persist();
    }
  }

  private deduplicateHrAgents(): boolean {
    const canonicalHrByMission = new Map<string, WarRoomAgent>();
    const duplicateToCanonical = new Map<string, string>();

    for (const agent of [...this.agents.values()].sort((a, b) => a.sortOrder - b.sortOrder)) {
      if (agent.role !== "hr") continue;
      const canonical = canonicalHrByMission.get(agent.missionId);
      if (!canonical) {
        canonicalHrByMission.set(agent.missionId, agent);
        continue;
      }
      duplicateToCanonical.set(agent.id, canonical.id);
      this.agents.delete(agent.id);
    }

    if (duplicateToCanonical.size === 0) return false;

    for (const message of [...this.agentMessages.values()]) {
      const canonicalFromId = duplicateToCanonical.get(message.fromAgentId);
      const canonicalToId = message.toAgentId ? duplicateToCanonical.get(message.toAgentId) : undefined;
      if (!canonicalFromId && !canonicalToId) continue;
      this.agentMessages.set(message.id, {
        ...message,
        fromAgentId: canonicalFromId ?? message.fromAgentId,
        ...(message.toAgentId !== undefined ? { toAgentId: canonicalToId ?? message.toAgentId } : {}),
      });
    }

    for (const relation of [...this.agentRelations.values()]) {
      const canonicalFromId = duplicateToCanonical.get(relation.fromAgentId);
      const canonicalToId = duplicateToCanonical.get(relation.toAgentId);
      if (!canonicalFromId && !canonicalToId) continue;
      const updated = {
        ...relation,
        fromAgentId: canonicalFromId ?? relation.fromAgentId,
        toAgentId: canonicalToId ?? relation.toAgentId,
      };
      if (updated.fromAgentId === updated.toAgentId) {
        this.agentRelations.delete(relation.id);
      } else {
        this.agentRelations.set(relation.id, updated);
      }
    }

    return true;
  }

  private persist(): void {
    if (!this.storageFile) {
      return;
    }
    mkdirSync(dirname(this.storageFile), { recursive: true });
    const payload: StoredMissionSnapshot = {
      schemaVersion: 1,
      ...this.snapshot(),
    };
    writeFileSync(this.storageFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
