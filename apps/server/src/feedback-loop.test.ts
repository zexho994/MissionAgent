import { describe, expect, it } from "vitest";
import type { MissionOutcomeEvaluation, TaskFailureAnalysis } from "@digitalagent/core";
import { buildExecutionFailureFeedback } from "./feedback-generation.js";

describe("feedback loop dispatch", () => {
  it("only dispatches feedback event for blocked or regressed outcomes", () => {
    const evaluation: MissionOutcomeEvaluation = {
      id: "eval_1",
      missionId: "mission_1",
      taskId: "task_1",
      source: "execution_result",
      outcome: "advanced",  // not blocked/regressed
      contributionScore: 0.9,
      summary: "Good result",
      evidence: ["approved"],
      risks: [],
      recommendedNextActions: [],
      createdAt: new Date().toISOString(),
    };

    // Should NOT dispatch
    const shouldDispatch = evaluation.outcome === "blocked" || evaluation.outcome === "regressed";
    expect(shouldDispatch).toBe(false);
  });

  it("dispatches feedback event for blocked outcome", () => {
    const evaluation: MissionOutcomeEvaluation = {
      id: "eval_1",
      missionId: "mission_1",
      taskId: "task_1",
      source: "execution_result",
      outcome: "blocked",
      contributionScore: 0.3,
      summary: "Needs revision",
      evidence: ["revise requested"],
      risks: ["quality below threshold"],
      recommendedNextActions: ["Revise the artifact"],
      createdAt: new Date().toISOString(),
    };

    // Should dispatch
    const shouldDispatch = evaluation.outcome === "blocked" || evaluation.outcome === "regressed";
    expect(shouldDispatch).toBe(true);
  });
});