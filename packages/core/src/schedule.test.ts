import { describe, expect, it } from "vitest";
import { createScheduleRule } from "./schedule.js";

describe("createScheduleRule", () => {
  const validCronTrigger = {
    type: "cron" as const,
    expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
  };

  const validTaskTemplate = {
    title: "Daily data check",
    contract: {
      objective: "Check yesterday's engagement data",
      input: {},
      outputSchema: { report: "object" },
      successCriteria: ["Report generated"],
    },
    assigneeRole: "data-analyst",
    priority: "normal" as const,
  };

  it("creates a cron schedule rule with all fields", () => {
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: "mission_test",
      enabled: true,
      trigger: validCronTrigger,
      taskTemplate: validTaskTemplate,
      maxConcurrent: 1,
      metadata: {},
    });

    expect(rule.id).toMatch(/^schedule_/);
    expect(rule.name).toBe("Daily check");
    expect(rule.trigger.type).toBe("cron");
  });

  it("rejects empty name", () => {
    expect(() =>
      createScheduleRule({
        name: "",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Schedule rule name is required");
  });

  it("rejects empty missionId", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Schedule rule missionId is required");
  });

  it("rejects empty task template title", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: { ...validTaskTemplate, title: "" },
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Task template title is required");
  });

  it("rejects empty assigneeRole", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: { ...validTaskTemplate, assigneeRole: "" },
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Task template assigneeRole is required");
  });

  it("rejects empty contract objective", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: {
          ...validTaskTemplate,
          contract: { ...validTaskTemplate.contract, objective: "" },
        },
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Task template contract objective is required");
  });

  it("rejects maxConcurrent less than 1", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: validTaskTemplate,
        maxConcurrent: 0,
        metadata: {},
      }),
    ).toThrow("maxConcurrent must be a positive integer");
  });

  it("rejects non-integer maxConcurrent", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1.5,
        metadata: {},
      }),
    ).toThrow("maxConcurrent must be a positive integer");
  });

  it("creates a condition trigger rule", () => {
    const rule = createScheduleRule({
      name: "Engagement drop alert",
      missionId: "mission_test",
      enabled: true,
      trigger: {
        type: "condition",
        description: "Engagement rate drops more than 20%",
        sourceAgentRole: "data-analyst",
        evaluatePrompt: "Check if the engagement rate has dropped more than 20% compared to the previous period.",
      },
      taskTemplate: validTaskTemplate,
      maxConcurrent: 1,
      metadata: {},
    });

    expect(rule.trigger.type).toBe("condition");
  });

  it("rejects invalid cron expressions", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: { ...validCronTrigger, expression: "0 9 * * 1-5" },
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Unsupported cron expression");
  });

  it("rejects out-of-range cron expressions", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: { ...validCronTrigger, expression: "99 9 * * *" },
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Unsupported cron expression");
  });

  it("rejects empty cron timezone", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: { ...validCronTrigger, timezone: "" },
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Cron trigger timezone is required");
  });

  it("rejects condition trigger with empty sourceAgentRole", () => {
    expect(() =>
      createScheduleRule({
        name: "Engagement drop alert",
        missionId: "mission_test",
        enabled: true,
        trigger: {
          type: "condition",
          description: "Engagement rate drops more than 20%",
          sourceAgentRole: "",
          evaluatePrompt: "Check engagement",
        },
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Condition trigger sourceAgentRole is required");
  });

  it("rejects condition trigger with empty description", () => {
    expect(() =>
      createScheduleRule({
        name: "Engagement drop alert",
        missionId: "mission_test",
        enabled: true,
        trigger: {
          type: "condition",
          description: "",
          sourceAgentRole: "data-analyst",
          evaluatePrompt: "Check engagement",
        },
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Condition trigger description is required");
  });

  it("rejects condition trigger with empty evaluatePrompt", () => {
    expect(() =>
      createScheduleRule({
        name: "Engagement drop alert",
        missionId: "mission_test",
        enabled: true,
        trigger: {
          type: "condition",
          description: "Engagement rate drops",
          sourceAgentRole: "data-analyst",
          evaluatePrompt: "",
        },
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Condition trigger evaluatePrompt is required");
  });
});
