import { describe, expect, it } from "vitest";
import { transitionTask } from "./task-state-machine.js";
import type { Task } from "./types.js";

function draftTask(): Task {
  return {
    id: "task_1",
    missionId: "mission_1",
    title: "Collect competitor notes",
    status: "draft",
    dependencies: [],
    contract: {
      objective: "Collect 10 competitor notes",
      input: { keywords: ["AI tools"] },
      outputSchema: {
        accounts: "array",
        notes: "array",
        patterns: "array",
      },
      successCriteria: ["At least 10 notes", "Each note has source URL"],
    },
    approvalRequired: false,
  };
}

describe("task state machine", () => {
  it("moves a task through the normal execution and review path", () => {
    let task = draftTask();

    task = transitionTask(task, { type: "contract.completed" });
    expect(task.status).toBe("ready");

    task = transitionTask(task, { type: "dependencies.met" });
    expect(task.status).toBe("queued");

    task = transitionTask(task, { type: "worker.assigned", agentInstanceId: "agent_1" });
    expect(task.status).toBe("running");
    expect(task.assigneeAgentId).toBe("agent_1");

    task = transitionTask(task, { type: "tool.requested", toolCallId: "tool_1" });
    expect(task.status).toBe("waiting_tool");

    task = transitionTask(task, { type: "tool.completed" });
    expect(task.status).toBe("running");

    task = transitionTask(task, { type: "artifact.submitted", artifactId: "artifact_1" });
    expect(task.status).toBe("submitted");
    expect(task.artifactId).toBe("artifact_1");

    task = transitionTask(task, { type: "review.started" });
    expect(task.status).toBe("reviewing");

    task = transitionTask(task, { type: "review.approved", reviewId: "review_1" });
    expect(task.status).toBe("completed");
    expect(task.reviewId).toBe("review_1");
  });

  it("fails fast when an event is invalid for the current task status", () => {
    const task = draftTask();

    expect(() =>
      transitionTask(task, { type: "worker.assigned", agentInstanceId: "agent_1" }),
    ).toThrow("Invalid task transition: draft -> worker.assigned");
  });
});
