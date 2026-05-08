import type { ScheduledTaskTemplate } from "./types.js";

export const BUILTIN_SCHEDULE_TEMPLATES: ScheduledTaskTemplate[] = [
  {
    id: "daily_metric_check",
    name: "Daily metric check",
    description: "Run a daily check on key metrics and alert on anomalies",
    applicableRolePatterns: ["analyst", "data", "monitor", "research"],
    trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    taskTemplate: {
      titleTemplate: "{{role.name}} 每日数据检查",
      contract: {
        objective: "检查并报告关键指标",
        input: {},
        outputSchema: { metrics: "array", anomalies: "array" },
        successCriteria: ["报告包含关键指标数据", "异常被明确标记"],
      },
      priority: "normal",
    },
    maxConcurrent: 1,
    metadata: { source: "builtin", templateId: "daily_metric_check" },
  },
  {
    id: "weekly_team_report",
    name: "Weekly team report",
    description: "Generate a weekly summary of team progress and blockers",
    applicableRolePatterns: ["manager", "lead", "owner", "coordinator"],
    trigger: { type: "cron", expression: "0 10 * * 1", timezone: "UTC" },
    taskTemplate: {
      titleTemplate: "{{role.name}} 周报",
      contract: {
        objective: "生成团队周报",
        input: {},
        outputSchema: { summary: "string", blockers: "array", nextWeek: "array" },
        successCriteria: ["周报包含进展和阻碍", "下周计划明确"],
      },
      priority: "normal",
    },
    maxConcurrent: 1,
    metadata: { source: "builtin", templateId: "weekly_team_report" },
  },
  {
    id: "biweekly_strategy_retrospective",
    name: "Biweekly strategy retrospective",
    description: "Review strategy execution and adapt approach every two weeks",
    applicableRolePatterns: ["content", "strategist", "planner", "manager"],
    trigger: { type: "cron", expression: "0 10 */14 * *", timezone: "UTC" },
    taskTemplate: {
      titleTemplate: "{{role.name}} 双周战略复盘",
      contract: {
        objective: "进行双周战略复盘",
        input: {},
        outputSchema: { achievements: "array", challenges: "array", adaptations: "array" },
        successCriteria: ["明确达成事项", "识别挑战", "提出改进建议"],
      },
      priority: "high",
    },
    maxConcurrent: 1,
    metadata: { source: "builtin", templateId: "biweekly_strategy_retrospective" },
  },
  {
    id: "engagement_drop_alert",
    name: "Engagement drop alert",
    description: "Trigger when engagement metrics drop significantly",
    applicableRolePatterns: ["analyst", "data", "monitor"],
    trigger: { type: "condition", description: "用户参与度显著下降", sourceAgentRole: "analyst", evaluatePrompt: "检查参与度指标是否低于阈值" },
    taskTemplate: {
      titleTemplate: "{{role.name}} 参与度下降告警",
      contract: {
        objective: "分析参与度下降原因并提出对策",
        input: {},
        outputSchema: { diagnosis: "string", recommendations: "array" },
        successCriteria: ["诊断清晰", "有具体对策"],
      },
      priority: "high",
    },
    maxConcurrent: 2,
    metadata: { source: "builtin", templateId: "engagement_drop_alert" },
  },
];

export function findTemplateById(id: string): ScheduledTaskTemplate | undefined {
  return BUILTIN_SCHEDULE_TEMPLATES.find((t) => t.id === id);
}

export function describeTemplatesForPrompt(): string {
  return BUILTIN_SCHEDULE_TEMPLATES.map((t) =>
    `- \`${t.id}\`: ${t.name} — ${t.description} (适用于: ${t.applicableRolePatterns.join(", ")})`
  ).join("\n");
}
