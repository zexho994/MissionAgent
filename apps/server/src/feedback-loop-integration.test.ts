import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";

describe("feedback loop full integration", () => {
  it("blocked execution triggers feedback event and creates strategy adjustment", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks.find((t) => t.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    // Submit empty result -> blocked evaluation
    service.submitExecutionResult({
      missionId: mission.id,
      taskId: task!.id,
      executionId: execution.id,
      content: { openclaw: "" },
      evidence: ["openclaw:local"],
    });

    // Verify evaluation created
    const snapshot = service.snapshot();
    const eval_ = snapshot.missionOutcomeEvaluations.find((e) => e.taskId === task!.id);
    expect(eval_).toBeDefined();
    expect(eval_?.outcome).toBe("regressed");

    // Verify failure analysis created
    const failure = snapshot.taskFailureAnalyses.find((f) => f.taskId === task!.id);
    expect(failure).toBeDefined();
    expect(failure?.failureType).toBe("low_quality_output");

    // Verify knowledge entry created
    const knowledge = snapshot.knowledgeEntries.find((k) => k.key.includes("feedback:"));
    expect(knowledge).toBeDefined();
  });

  it("failed execution triggers feedback event", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks.find((t) => t.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({ executionId: execution.id, error: "OpenClaw timed out" });

    const snapshot = service.snapshot();
    const eval_ = snapshot.missionOutcomeEvaluations.find((e) => e.taskId === task!.id);
    expect(eval_?.outcome).toBe("blocked");
    expect(eval_?.source).toBe("execution_failure");
    const failure = snapshot.taskFailureAnalyses.find((f) => f.taskId === task!.id);
    expect(failure?.failureType).toBe("execution_error");
  });

  it("feedback summary reflects latest records", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks.find((t) => t.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({ executionId: execution.id, error: "OpenClaw timed out" });

    const summary = service.getFeedbackSummary(mission.id);
    expect(summary.counts.evaluations).toBe(1);
    expect(summary.counts.failureAnalyses).toBe(1);
    expect(summary.latestEvaluation?.outcome).toBe("blocked");
  });
});
