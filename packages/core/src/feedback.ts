import { createId } from "./ids.js";
import type {
  MissionOutcome,
  MissionOutcomeEvaluation,
  MissionOutcomeEvaluationSource,
  RecommendedRecovery,
  StrategyAdjustment,
  StrategyAdjustmentStatus,
  TaskFailureAnalysis,
  TaskFailureType,
} from "./types.js";

export interface CreateMissionOutcomeEvaluationInput {
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  source: MissionOutcomeEvaluationSource;
  outcome: MissionOutcome;
  contributionScore: number;
  summary: string;
  evidence: string[];
  risks: string[];
  recommendedNextActions: string[];
}

export interface CreateTaskFailureAnalysisInput {
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  failureType: TaskFailureType;
  summary: string;
  rootCause: string;
  recommendedRecovery: RecommendedRecovery;
  recommendedNextActions: string[];
}

export interface CreateStrategyAdjustmentInput {
  missionId: string;
  triggeredByEvaluationId?: string;
  triggeredByFailureAnalysisId?: string;
  status: StrategyAdjustmentStatus;
  previousStrategy: string;
  proposedStrategy: string;
  rationale: string;
  affectedAgentRoles: string[];
  proposedTaskGoals: string[];
  requiresHrReview: boolean;
}

function requireTrimmed(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} is required`);
  }
}

function requireTrimmedItems(values: string[], label: string): void {
  if (values.some((value) => !value.trim())) {
    throw new Error(`${label} must not contain empty items`);
  }
}

export function createMissionOutcomeEvaluation(
  input: CreateMissionOutcomeEvaluationInput,
): MissionOutcomeEvaluation {
  requireTrimmed(input.missionId, "Mission outcome evaluation missionId");
  requireTrimmed(input.taskId, "Mission outcome evaluation taskId");
  requireTrimmed(input.summary, "Mission outcome evaluation summary");
  if (input.contributionScore < 0 || input.contributionScore > 1) {
    throw new Error("Mission outcome evaluation contributionScore must be between 0 and 1");
  }
  if (input.source !== "manual" && input.evidence.length === 0) {
    throw new Error("Mission outcome evaluation evidence is required");
  }
  requireTrimmedItems(input.evidence, "Mission outcome evaluation evidence");
  requireTrimmedItems(input.risks, "Mission outcome evaluation risks");
  requireTrimmedItems(input.recommendedNextActions, "Mission outcome evaluation recommendedNextActions");
  if (
    (input.outcome === "blocked" || input.outcome === "regressed") &&
    input.risks.length === 0 &&
    input.recommendedNextActions.length === 0
  ) {
    throw new Error("Blocked or regressed evaluations require a risk or next action");
  }

  return {
    id: createId("feedback_eval"),
    missionId: input.missionId,
    taskId: input.taskId,
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
    source: input.source,
    outcome: input.outcome,
    contributionScore: input.contributionScore,
    summary: input.summary,
    evidence: [...input.evidence],
    risks: [...input.risks],
    recommendedNextActions: [...input.recommendedNextActions],
    createdAt: new Date().toISOString(),
  };
}

export function createTaskFailureAnalysis(input: CreateTaskFailureAnalysisInput): TaskFailureAnalysis {
  requireTrimmed(input.missionId, "Task failure analysis missionId");
  requireTrimmed(input.taskId, "Task failure analysis taskId");
  requireTrimmed(input.summary, "Task failure analysis summary");
  requireTrimmed(input.rootCause, "Task failure analysis rootCause");
  if (input.recommendedNextActions.length === 0) {
    throw new Error("Task failure analysis requires at least one recommended next action");
  }
  requireTrimmedItems(input.recommendedNextActions, "Task failure analysis recommendedNextActions");

  return {
    id: createId("failure_analysis"),
    missionId: input.missionId,
    taskId: input.taskId,
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
    failureType: input.failureType,
    summary: input.summary,
    rootCause: input.rootCause,
    recommendedRecovery: input.recommendedRecovery,
    recommendedNextActions: [...input.recommendedNextActions],
    createdAt: new Date().toISOString(),
  };
}

export function createStrategyAdjustment(input: CreateStrategyAdjustmentInput): StrategyAdjustment {
  requireTrimmed(input.missionId, "Strategy adjustment missionId");
  requireTrimmed(input.previousStrategy, "Strategy adjustment previousStrategy");
  requireTrimmed(input.proposedStrategy, "Strategy adjustment proposedStrategy");
  requireTrimmed(input.rationale, "Strategy adjustment rationale");
  requireTrimmedItems(input.affectedAgentRoles, "Strategy adjustment affectedAgentRoles");
  requireTrimmedItems(input.proposedTaskGoals, "Strategy adjustment proposedTaskGoals");

  return {
    id: createId("strategy_adjustment"),
    missionId: input.missionId,
    ...(input.triggeredByEvaluationId === undefined ? {} : { triggeredByEvaluationId: input.triggeredByEvaluationId }),
    ...(input.triggeredByFailureAnalysisId === undefined
      ? {}
      : { triggeredByFailureAnalysisId: input.triggeredByFailureAnalysisId }),
    status: input.status,
    previousStrategy: input.previousStrategy,
    proposedStrategy: input.proposedStrategy,
    rationale: input.rationale,
    affectedAgentRoles: [...input.affectedAgentRoles],
    proposedTaskGoals: [...input.proposedTaskGoals],
    requiresHrReview: input.requiresHrReview,
    createdAt: new Date().toISOString(),
  };
}
