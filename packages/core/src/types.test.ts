import { describe, it, expect } from "vitest";
import type { ScheduledTaskTemplate } from "./types.js";

describe("ScheduledTaskTemplate", () => {
  it("has required fields", () => {
    const template: ScheduledTaskTemplate = {
      id: "daily_metric_check",
      name: "Daily metric check",
      description: "Run a daily check on metrics",
      applicableRolePatterns: ["analyst", "data"],
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        titleTemplate: "{{role.name}} 每日数据检查",
        contract: { objective: "检查", input: {}, outputSchema: {}, successCriteria: [] },
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: { source: "builtin", templateId: "daily_metric_check" },
    };
    expect(template.id).toBe("daily_metric_check");
    expect(template.trigger.type).toBe("cron");
  });
});
