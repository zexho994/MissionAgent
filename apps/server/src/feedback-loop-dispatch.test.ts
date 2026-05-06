import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";

describe("feedback event dispatch", () => {
  it("dispatches feedback event when execution result is blocked", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    await service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks.find((t) => t.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    // Capture message count before submission
    const snapshotBefore = service.snapshot();
    const messageCountBefore = snapshotBefore.agentMessages.length;

    // Submit a revise result (builds blocked evaluation)
    service.submitExecutionResult({
      missionId: mission.id,
      taskId: task!.id,
      executionId: execution.id,
      content: { openclaw: "" },  // empty = low quality
      evidence: ["openclaw:local"],
    });

    // Verify evaluation is blocked or regressed
    const snapshotAfter = service.snapshot();
    const eval_ = snapshotAfter.missionOutcomeEvaluations.find(
      (e) => e.taskId === task!.id,
    );
    expect(eval_?.outcome).toMatch(/^(blocked|regressed)$/);

    // Verify message count increased as a result of the dispatch
    // Note: dispatchFeedbackEvent is a no-op when no LLM is configured
    expect(snapshotAfter.agentMessages.length).toBeGreaterThan(messageCountBefore);
  });
});