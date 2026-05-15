import {
  createMissionOutcomeEvaluation,
  createStrategyAdjustment,
  createTaskFailureAnalysis,
  type Artifact,
  type Mission,
  type MissionOutcomeEvaluation,
  type Review,
  type StrategyAdjustment,
  type Task,
  type TaskFailureAnalysis,
} from "@digitalagent/core";

export interface ExecutionResultFeedback {
  evaluation: MissionOutcomeEvaluation;
  failureAnalysis?: TaskFailureAnalysis;
  strategyAdjustment?: StrategyAdjustment;
}

export interface ExecutionFailureFeedback {
  evaluation: MissionOutcomeEvaluation;
  failureAnalysis: TaskFailureAnalysis;
}

function artifactScore(artifact: Artifact): number {
  return artifact.qualityScore ?? 0.5;
}

function reviewEvidence(review: Review, artifact: Artifact): string[] {
  return [
    `Review decision: ${review.decision}`,
    `Artifact type: ${artifact.type}`,
    ...review.comments.map((comment) => `Review comment: ${comment}`),
  ];
}

function currentStrategy(mission: Mission): string {
  return mission.brief?.scope || mission.goal;
}

function readableFailureReason(rootCause: string): string {
  if (rootCause === "Agent output is empty or too short") {
    return "Agent 输出为空或过短，无法作为有效结果验收。";
  }
  if (rootCause === "Artifact has no pi-agent output" || rootCause === "Artifact has no OpenClaw output") {
    return "执行产物缺少 pi-agent 输出，无法判断任务是否产生了真实进展。";
  }
  return rootCause;
}

export function buildExecutionResultFeedback(input: {
  mission: Mission;
  task: Task;
  artifact: Artifact;
  review: Review;
}): ExecutionResultFeedback {
  const score = artifactScore(input.artifact);
  const outcome = input.review.decision === "approve"
    ? "advanced"
    : input.review.decision === "revise"
      ? "blocked"
      : score <= 0.2
        ? "regressed"
        : "blocked";

  const evaluation = createMissionOutcomeEvaluation({
    missionId: input.mission.id,
    taskId: input.task.id,
    artifactId: input.artifact.id,
    reviewId: input.review.id,
    source: "execution_result",
    outcome,
    contributionScore: score,
    summary: input.review.decision === "approve"
      ? `Task "${input.task.title}" produced an approved artifact for the Mission.`
      : `Task "${input.task.title}" did not produce acceptable forward motion.`,
    evidence: reviewEvidence(input.review, input.artifact),
    risks: input.review.decision === "approve" ? [] : input.review.comments,
    recommendedNextActions: input.review.decision === "approve"
      ? [`Use the artifact from "${input.task.title}" in the next Mission step.`]
      : [`Recover task "${input.task.title}" before relying on this output.`],
  });

  if (input.review.decision === "approve") {
    return { evaluation };
  }

  const recommendedRecovery = input.review.decision === "reject" && score <= 0.2
    ? "adjust_strategy"
    : "revise_task";
  const failureAnalysis = createTaskFailureAnalysis({
    missionId: input.mission.id,
    taskId: input.task.id,
    artifactId: input.artifact.id,
    reviewId: input.review.id,
    failureType: "low_quality_output",
    summary: `Task "${input.task.title}" requires recovery after ${input.review.decision}.`,
    rootCause: input.review.comments.join("; "),
    recommendedRecovery,
    recommendedNextActions: recommendedRecovery === "adjust_strategy"
      ? ["Review whether the current Mission strategy can still produce the target outcome."]
      : [`Revise task "${input.task.title}" with stronger evidence and clearer output.`],
  });

  if (recommendedRecovery !== "adjust_strategy") {
    return { evaluation, failureAnalysis };
  }

  const strategyAdjustment = createStrategyAdjustment({
    missionId: input.mission.id,
    triggeredByEvaluationId: evaluation.id,
    triggeredByFailureAnalysisId: failureAnalysis.id,
    status: "proposed",
    previousStrategy: currentStrategy(input.mission),
    proposedStrategy: `重新评估任务策略：当前任务“${input.task.title}”没有产出可验收的 Mission 进展。`,
    rationale: readableFailureReason(failureAnalysis.rootCause),
    affectedAgentRoles: [],
    proposedTaskGoals: failureAnalysis.recommendedNextActions,
    requiresHrReview: true,
  });

  return { evaluation, failureAnalysis, strategyAdjustment };
}

export function buildExecutionFailureFeedback(input: {
  mission: Mission;
  task: Task;
  error: string;
}): ExecutionFailureFeedback {
  const evaluation = createMissionOutcomeEvaluation({
    missionId: input.mission.id,
    taskId: input.task.id,
    source: "execution_failure",
    outcome: "blocked",
    contributionScore: 0,
    summary: `Execution failed for task "${input.task.title}".`,
    evidence: [`Execution error: ${input.error}`],
    risks: [input.error],
    recommendedNextActions: [`Inspect and recover task "${input.task.title}".`],
  });

  const failureAnalysis = createTaskFailureAnalysis({
    missionId: input.mission.id,
    taskId: input.task.id,
    failureType: "execution_error",
    summary: `Execution failed for task "${input.task.title}".`,
    rootCause: input.error,
    recommendedRecovery: "revise_task",
    recommendedNextActions: [`Fix the execution blocker and rerun task "${input.task.title}".`],
  });

  return { evaluation, failureAnalysis };
}
