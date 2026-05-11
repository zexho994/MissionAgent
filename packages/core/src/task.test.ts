import { describe, expect, it } from "vitest";
import { createTask } from "./task.js";

describe("createTask", () => {
  it("creates a draft task with a clear contract", () => {
    const task = createTask({
      missionId: "mission_1",
      title: "Research competitor notes",
      dependencies: ["task_positioning"],
      contract: {
        objective: "Find competitor note patterns",
        input: { keywords: ["AI productivity"] },
        outputSchema: { patterns: "array", evidence: "array" },
        successCriteria: ["at least 10 notes", "source URL for every note"],
      },
      approvalRequired: false,
    });

    expect(task.status).toBe("draft");
    expect(task.dependencies).toEqual(["task_positioning"]);
    expect(task.contract.objective).toBe("Find competitor note patterns");
  });

  it("fails fast when task contract has no success criteria", () => {
    expect(() =>
      createTask({
        missionId: "mission_1",
        title: "Research competitor notes",
        dependencies: [],
        contract: {
          objective: "Find competitor note patterns",
          input: {},
          outputSchema: { patterns: "array" },
          successCriteria: [],
        },
        approvalRequired: false,
      }),
    ).toThrow("Task contract requires at least one success criterion");
  });

  it("preserves scheduleRuleId for scheduled tasks", () => {
    const task = createTask({
      missionId: "mission_1",
      title: "Run daily check",
      dependencies: [],
      contract: {
        objective: "Run the scheduled check",
        input: {},
        outputSchema: {},
        successCriteria: ["check completed"],
      },
      approvalRequired: false,
      scheduleRuleId: "schedule_1",
    });

    expect(task.scheduleRuleId).toBe("schedule_1");
  });
});

describe("createTask with origin", () => {
  it("does not set origin when not specified (backward compat)", () => {
    const task = createTask({
      missionId: "mission_1",
      title: "do thing",
      dependencies: [],
      contract: {
        objective: "x",
        input: {},
        outputSchema: {},
        successCriteria: ["criterion"],
      },
      approvalRequired: false,
    });
    expect(task.origin).toBeUndefined();
  });

  it("records followup origin with reason and sourceTaskId", () => {
    const task = createTask({
      missionId: "mission_1",
      title: "do followup",
      dependencies: [],
      contract: {
        objective: "y",
        input: {},
        outputSchema: {},
        successCriteria: ["criterion"],
      },
      approvalRequired: false,
      origin: {
        type: "followup",
        reason: "based on review of task-A",
        sourceTaskId: "task-A",
      },
    });
    expect(task.origin).toEqual({
      type: "followup",
      reason: "based on review of task-A",
      sourceTaskId: "task-A",
    });
  });

  it("records initial origin when explicitly set", () => {
    const task = createTask({
      missionId: "mission_1",
      title: "initial task",
      dependencies: [],
      contract: {
        objective: "z",
        input: {},
        outputSchema: {},
        successCriteria: ["criterion"],
      },
      approvalRequired: false,
      origin: { type: "initial" },
    });
    expect(task.origin).toEqual({ type: "initial" });
  });
});
