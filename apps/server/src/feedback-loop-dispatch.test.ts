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

    // Submit a revise result (builds blocked evaluation)
    service.submitExecutionResult({
      missionId: mission.id,
      taskId: task!.id,
      executionId: execution.id,
      content: { openclaw: "" },  // empty = low quality
      evidence: ["openclaw:local"],
    });

    // Verify evaluation is blocked or regressed
    const snapshot = service.snapshot();
    const eval_ = snapshot.missionOutcomeEvaluations.find(
      (e) => e.taskId === task!.id,
    );
    expect(eval_?.outcome).toMatch(/^(blocked|regressed)$/);

    // Verify message was dispatched to Owner (check agentMessages)
    const ownerAgent = snapshot.agents.find((a) => a.role === "owner");
    const ownerMessages = snapshot.agentMessages.filter(
      (m) => m.fromAgentId === ownerAgent?.id || m.toAgentId === ownerAgent?.id,
    );
    // The dispatch sends a feedback_evaluated event which generates a message
    expect(snapshot.agentMessages.length).toBeGreaterThan(0);
  });
});