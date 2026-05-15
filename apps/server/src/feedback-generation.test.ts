import { describe, expect, it } from "vitest";
import type { Artifact, Mission, Review, Task } from "@digitalagent/core";
import {
  buildExecutionFailureFeedback,
  buildExecutionResultFeedback,
} from "./feedback-generation.js";

const mission: Mission = {
  id: "mission_1",
  goal: "Grow a GitHub account to two repositories over 1k stars",
  successMetrics: ["Two repositories exceed 1k stars"],
  constraints: ["One month timeline"],
  status: "active",
  budget: { maxRuntimeMinutes: 120 },
  createdAt: new Date("2026-05-05T00:00:00.000Z"),
  scheduleRules: [],
};

const task: Task = {
  id: "task_1",
  missionId: "mission_1",
  title: "Draft repository growth plan",
  status: "completed",
  dependencies: [],
  contract: {
    objective: "Create a growth plan",
    input: {},
    outputSchema: { summary: "string" },
    successCriteria: ["Includes next actions"],
  },
  approvalRequired: false,
  assigneeAgentId: "agent_owner",
};

const artifact: Artifact = {
  id: "artifact_1",
  taskId: "task_1",
  type: "execution_log",
  content: { summary: "Plan with next actions" },
  evidence: ["pi:local"],
  sources: [],
  qualityScore: 0.86,
  createdAt: new Date("2026-05-05T00:01:00.000Z"),
};

describe("feedback generation", () => {
  it("builds advanced evaluation for approved execution result", () => {
    const review: Review = {
      id: "review_1",
      artifactId: "artifact_1",
      reviewerAgentId: "agent_reviewer",
      decision: "approve",
      comments: ["Artifact quality check passed"],
      createdAt: new Date("2026-05-05T00:02:00.000Z"),
    };

    const feedback = buildExecutionResultFeedback({ mission, task, artifact, review });

    expect(feedback.evaluation.outcome).toBe("advanced");
    expect(feedback.evaluation.contributionScore).toBe(0.86);
    expect(feedback.evaluation.evidence).toContain("Review decision: approve");
    expect(feedback.failureAnalysis).toBeUndefined();
    expect(feedback.strategyAdjustment).toBeUndefined();
  });

  it("builds failure analysis for revision request", () => {
    const review: Review = {
      id: "review_2",
      artifactId: "artifact_1",
      reviewerAgentId: "agent_reviewer",
      decision: "revise",
      comments: ["Artifact needs stronger evidence"],
      createdAt: new Date("2026-05-05T00:02:00.000Z"),
    };

    const feedback = buildExecutionResultFeedback({ mission, task, artifact, review });

    expect(feedback.evaluation.outcome).toBe("blocked");
    expect(feedback.failureAnalysis?.failureType).toBe("low_quality_output");
    expect(feedback.failureAnalysis?.recommendedRecovery).toBe("revise_task");
    expect(feedback.strategyAdjustment).toBeUndefined();
  });

  it("builds strategy adjustment proposal for rejected low-score result", () => {
    const lowScoreArtifact: Artifact = { ...artifact, qualityScore: 0.1 };
    const review: Review = {
      id: "review_3",
      artifactId: "artifact_1",
      reviewerAgentId: "agent_reviewer",
      decision: "reject",
      comments: ["Agent output is empty or too short"],
      createdAt: new Date("2026-05-05T00:02:00.000Z"),
    };

    const feedback = buildExecutionResultFeedback({ mission, task, artifact: lowScoreArtifact, review });

    expect(feedback.evaluation.outcome).toBe("regressed");
    expect(feedback.failureAnalysis?.recommendedRecovery).toBe("adjust_strategy");
    expect(feedback.strategyAdjustment?.status).toBe("proposed");
    expect(feedback.strategyAdjustment?.requiresHrReview).toBe(true);
    expect(feedback.strategyAdjustment?.proposedStrategy).toBe(
      "重新评估任务策略：当前任务“Draft repository growth plan”没有产出可验收的 Mission 进展。",
    );
    expect(feedback.strategyAdjustment?.rationale).toBe(
      "Agent 输出为空或过短，无法作为有效结果验收。",
    );
    expect(feedback.strategyAdjustment?.proposedStrategy).not.toContain("Reassess strategy");
  });

  it("builds blocked feedback for execution failure", () => {
    const feedback = buildExecutionFailureFeedback({
      mission,
      task,
      error: "OpenClaw timed out",
    });

    expect(feedback.evaluation.source).toBe("execution_failure");
    expect(feedback.evaluation.outcome).toBe("blocked");
    expect(feedback.failureAnalysis.failureType).toBe("execution_error");
    expect(feedback.failureAnalysis.rootCause).toContain("OpenClaw timed out");
  });
});
