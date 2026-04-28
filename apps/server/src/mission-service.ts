import {
  createArtifact,
  createId,
  createMission,
  createReview,
  createTask,
  transitionTask,
  type Artifact,
  type Mission,
  type MissionBrief,
  type Review,
  type Task,
} from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadAgentSystemConfig, type AgentSystemConfig } from "./system-config.js";
import { buildOwnerSystemPrompt, buildConversationMessages, buildSummaryRequest } from "./owner/index.js";
import type { TeamProposal } from "./hr-agent.js";
import { NegotiationManager, type NegotiationSummary } from "./negotiation-manager.js";
import { planMissionTeam, matcherFor, type MissionTeamPlan } from "./team-planning.js";
import { evaluateArtifactQuality } from "./artifact-evaluation.js";
import { activateWithHRAgent } from "./hr-activation.js";
import { ensureTaskRunning, deriveOwnerBrief, deriveOwnerFollowup } from "./mission-helpers.js";
import { runOwnerLlmStreaming } from "./owner-streaming.js";

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
  | "team_created"
  | "task_plan"
  | "execution_started"
  | "execution_completed"
  | "execution_failed"
  | "review_completed";

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
  tasks: Task[];
  artifacts: Artifact[];
  reviews: Review[];
  executions: Execution[];
  agents: WarRoomAgent[];
  agentRelations: AgentRelation[];
  agentMessages: AgentMessage[];
  taskEvents: WarRoomTaskEvent[];
  toolCalls: ToolCallRecord[];
  decisions: DecisionRecord[];
}

interface StoredMissionSnapshot extends MissionSnapshot {
  schemaVersion: 1;
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
  private readonly tasks = new Map<string, Task>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly reviews = new Map<string, Review>();
  private readonly executions = new Map<string, Execution>();
  private readonly agents = new Map<string, WarRoomAgent>();
  private readonly agentRelations = new Map<string, AgentRelation>();
  private readonly agentMessages = new Map<string, AgentMessage>();
  private readonly taskEvents = new Map<string, WarRoomTaskEvent>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly storageFile: string | undefined;
  private readonly config: AgentSystemConfig;
  private readonly llm: LlmService | undefined;
  private readonly streamListeners = new Map<string, Set<StreamEventListener>>();
  private negotiationManager: NegotiationManager | undefined;

  constructor(options: MissionServiceOptions = {}) {
    this.storageFile = options.storageFile;
    this.config = loadAgentSystemConfig(options.configFile);
    this.llm = options.llm;
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
    this.persist();

    if (this.llm) {
      const systemPrompt = this.ownerSystemPrompt();
      const owner = this.agentByRole(mission.id, "owner");

      void this.runOwnerLlmWithStreaming({
        missionId: mission.id,
        owner,
        systemPrompt,
        userMessage: input.goal,
        isCreation: true,
        fallbackContent: ownerBrief.summary,
      });
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
    this.persist();
    return mission;
  }

  async activateMissionWithHR(input: ActivateMissionRequest): Promise<Mission> {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const existingTask = [...this.tasks.values()].find((task) => task.missionId === mission.id);
    if (existingTask) {
      return mission;
    }

    if (!this.llm || !mission.brief) {
      return this.activateMission(input);
    }

    try {
      const result = await activateWithHRAgent(mission, this.llm);

      this.tasks.set(result.task.id, result.task);

      for (const agent of result.agents) {
        this.agents.set(agent.id, agent);
      }
      for (const relation of result.relations) {
        this.agentRelations.set(relation.id, relation);
      }
      for (const msg of result.messages) {
        this.appendMessage(msg);
      }

      const owner = this.agentByRole(mission.id, "owner");
      this.updateAgent(owner.id, {
        status: "idle",
        lastAction: "Team assembled by HR Agent via LLM",
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
        fallbackContent: deriveOwnerFollowup(message, this.config),
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
    this.executions.set(execution.id, {
      ...execution,
      status: "completed",
      completedAt: new Date().toISOString(),
      artifactId: artifact.id,
      reviewId: review.id,
    });

    this.persist();
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
    this.persist();
    return failed;
  }

  snapshot(): MissionSnapshot {
    return {
      missions: [...this.missions.values()],
      tasks: [...this.tasks.values()],
      artifacts: [...this.artifacts.values()],
      reviews: [...this.reviews.values()],
      executions: [...this.executions.values()],
      agents: [...this.agents.values()].sort((a, b) => a.sortOrder - b.sortOrder),
      agentRelations: [...this.agentRelations.values()],
      agentMessages: [...this.agentMessages.values()],
      taskEvents: [...this.taskEvents.values()],
      toolCalls: [...this.toolCalls.values()],
      decisions: [...this.decisions.values()],
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
    this.persist();
    return this.missions.get(mission.id)!;
  }

  getNegotiation(input: { missionId: string }): { proposal: TeamProposal; previousFeedback: string[] } | undefined {
    return this.negotiationManager?.getNegotiation(input);
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
    const existing = [...this.agents.values()].find((agent) => agent.missionId === missionId && agent.role === "owner");
    if (existing) {
      return existing;
    }
    const ownerSpec = this.config.teamPlanner.baseAgents.find((agent) => agent.role === "owner");
    if (!ownerSpec) {
      throw new Error("Owner agent config is required");
    }
    const owner: WarRoomAgent = {
      id: createId("agent"),
      missionId,
      role: ownerSpec.role,
      name: ownerSpec.name,
      responsibility: ownerSpec.responsibility,
      status: ownerSpec.status,
      currentTaskId: undefined,
      lastAction: ownerSpec.lastAction,
      avatarSeed: ownerSpec.avatarSeed,
      sortOrder: 0,
    };
    this.agents.set(owner.id, owner);
    return owner;
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
          currentTaskId: spec.currentTask ? firstTaskId : existing.currentTaskId,
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

  private appendMessage(input: Omit<AgentMessage, "id" | "createdAt"> & { options?: ParsedChoice[] }): void {
    const message: AgentMessage = {
      ...input,
      id: createId("message"),
      createdAt: new Date().toISOString(),
    };
    this.agentMessages.set(message.id, message);
  }

  private appendTaskEvent(input: Omit<WarRoomTaskEvent, "id" | "createdAt">): void {
    const event: WarRoomTaskEvent = {
      ...input,
      id: createId("taskevent"),
      createdAt: new Date().toISOString(),
    };
    this.taskEvents.set(event.id, event);
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
    fallbackContent: string;
  }): Promise<void> {
    await runOwnerLlmStreaming(this.llm!, {
      missionId: input.missionId,
      ownerId: input.owner.id,
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      llmMessages: input.llmMessages,
      isCreation: input.isCreation,
      fallbackContent: input.fallbackContent,
    }, {
      getMission: (id) => this.missions.get(id),
      setMission: (m) => this.missions.set(m.id, m),
      appendMessage: (msg) => this.appendMessage(msg as any),
      updateAgent: (id, patch) => this.updateAgent(id, patch as any),
      notifyStream: (id, event) => this.notifyStreamListeners(id, event as any),
      persist: () => this.persist(),
    });
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
    for (const mission of stored.missions) this.missions.set(mission.id, { ...mission, createdAt: new Date(mission.createdAt) });
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
    for (const event of stored.taskEvents) this.taskEvents.set(event.id, event);
    for (const call of stored.toolCalls) this.toolCalls.set(call.id, call);
    for (const decision of stored.decisions) this.decisions.set(decision.id, decision);
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
