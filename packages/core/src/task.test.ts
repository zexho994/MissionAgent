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
