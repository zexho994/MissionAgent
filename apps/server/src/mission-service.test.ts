import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";

describe("InMemoryMissionService", () => {
  it("creates a mission with an initial owner task", () => {
    const service = new InMemoryMissionService();

    const mission = service.createMission({
      goal: "Grow Xiaohongshu account to 1000 followers",
      successMetrics: ["followers >= 1000"],
      constraints: ["human approval before publishing"],
    });

    const snapshot = service.snapshot();

    expect(snapshot.missions).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.missionId).toBe(mission.id);
    expect(snapshot.tasks[0]?.title).toBe("Define mission team and first execution plan");
  });

  it("submits an execution artifact and creates a review", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({
      goal: "Grow Xiaohongshu account",
      successMetrics: ["daily review generated"],
      constraints: ["human approval before publishing"],
    });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({
      missionId: mission.id,
      taskId: task.id,
    });

    const result = service.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: { text: "OpenClaw execution completed" },
      evidence: ["openclaw:local"],
    });

    expect(result.artifact.taskId).toBe(task.id);
    expect(result.review.decision).toBe("approve");
    expect(service.snapshot().tasks[0]?.status).toBe("completed");
    expect(service.snapshot().executions[0]?.status).toBe("completed");
  });

  it("tracks failed executions without hiding the error", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission({
      goal: "Grow Xiaohongshu account",
      successMetrics: ["daily review generated"],
      constraints: ["human approval before publishing"],
    });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({
      missionId: mission.id,
      taskId: task.id,
    });

    const failed = service.failExecution({
      executionId: execution.id,
      error: "OpenClaw command failed",
    });

    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("OpenClaw command failed");
  });
});
