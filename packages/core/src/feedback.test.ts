import { describe, expect, it } from "vitest";
import {
  createMissionOutcomeEvaluation,
  createStrategyAdjustment,
  createTaskFailureAnalysis,
} from "./feedback.js";

describe("feedback domain", () => {
  it("creates a mission outcome evaluation", () => {
    const evaluation = createMissionOutcomeEvaluation({
      missionId: "mission_1",
      taskId: "task_1",
      artifactId: "artifact_1",
      reviewId: "review_1",
      source: "execution_result",
      outcome: "advanced",
      contributionScore: 0.82,
      summary: "The execution produced a usable growth plan.",
      evidence: ["Review approved the artifact"],
      risks: [],
      recommendedNextActions: ["Schedule the first execution check"],
    });

    expect(evaluation.id).toMatch(/^feedback_eval_/);
    expect(evaluation.missionId).toBe("mission_1");
    expect(evaluation.contributionScore).toBe(0.82);
    expect(evaluation.createdAt).toEqual(expect.any(String));
  });

  it("fails fast when non-manual evaluation has no evidence", () => {
    expect(() =>
      createMissionOutcomeEvaluation({
        missionId: "mission_1",
        taskId: "task_1",
        source: "execution_result",
        outcome: "neutral",
        contributionScore: 0.5,
        summary: "No clear contribution yet.",
        evidence: [],
        risks: [],
        recommendedNextActions: ["Review the task result"],
      }),
    ).toThrow("Mission outcome evaluation evidence is required");
  });

  it("fails fast when blocked evaluation has no risk or next action", () => {
    expect(() =>
      createMissionOutcomeEvaluation({
        missionId: "mission_1",
        taskId: "task_1",
        source: "execution_failure",
        outcome: "blocked",
        contributionScore: 0,
        summary: "Execution failed.",
        evidence: ["Execution error: timeout"],
        risks: [],
        recommendedNextActions: [],
      }),
    ).toThrow("Blocked or regressed evaluations require a risk or next action");
  });

  it("creates task failure analysis", () => {
    const analysis = createTaskFailureAnalysis({
      missionId: "mission_1",
      taskId: "task_1",
      artifactId: "artifact_1",
      reviewId: "review_1",
      failureType: "low_quality_output",
      summary: "The artifact needs revision.",
      rootCause: "Reviewer requested clearer evidence.",
      recommendedRecovery: "revise_task",
      recommendedNextActions: ["Ask the assignee to revise the evidence section"],
    });

    expect(analysis.id).toMatch(/^failure_analysis_/);
    expect(analysis.failureType).toBe("low_quality_output");
  });

  it("fails fast when failure analysis has no next action", () => {
    expect(() =>
      createTaskFailureAnalysis({
        missionId: "mission_1",
        taskId: "task_1",
        failureType: "execution_error",
        summary: "Execution failed.",
        rootCause: "The local executor crashed.",
        recommendedRecovery: "revise_task",
        recommendedNextActions: [],
      }),
    ).toThrow("Task failure analysis requires at least one recommended next action");
  });

  it("creates a proposed strategy adjustment", () => {
    const adjustment = createStrategyAdjustment({
      missionId: "mission_1",
      triggeredByFailureAnalysisId: "failure_analysis_1",
      status: "proposed",
      previousStrategy: "Post broad content experiments.",
      proposedStrategy: "Focus on evidence-backed repository growth loops.",
      rationale: "Recent task output lacked a clear path to the Mission metric.",
      affectedAgentRoles: ["owner", "data_analyst"],
      proposedTaskGoals: ["Review repository growth metric assumptions"],
      requiresHrReview: true,
    });

    expect(adjustment.id).toMatch(/^strategy_adjustment_/);
    expect(adjustment.status).toBe("proposed");
  });

  it("fails fast when strategy adjustment has no rationale", () => {
    expect(() =>
      createStrategyAdjustment({
        missionId: "mission_1",
        status: "proposed",
        previousStrategy: "Old strategy",
        proposedStrategy: "New strategy",
        rationale: "",
        affectedAgentRoles: [],
        proposedTaskGoals: [],
        requiresHrReview: false,
      }),
    ).toThrow("Strategy adjustment rationale is required");
  });
});
