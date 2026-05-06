import { createId } from "./ids.js";
import type { ScheduleRule, ScheduleTrigger, TaskContract } from "./types.js";

export interface CreateScheduleRuleInput {
  name: string;
  missionId: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  taskTemplate: {
    title: string;
    contract: TaskContract;
    assigneeRole: string;
    priority: "low" | "normal" | "high";
  };
  maxConcurrent: number;
  metadata: Record<string, unknown>;
}

export function createScheduleRule(input: CreateScheduleRuleInput): ScheduleRule {
  validateScheduleRuleInput(input);

  return {
    id: createId("schedule"),
    name: input.name,
    missionId: input.missionId,
    enabled: input.enabled,
    trigger: { ...input.trigger },
    taskTemplate: {
      title: input.taskTemplate.title,
      contract: {
        objective: input.taskTemplate.contract.objective,
        input: { ...input.taskTemplate.contract.input },
        outputSchema: { ...input.taskTemplate.contract.outputSchema },
        successCriteria: [...input.taskTemplate.contract.successCriteria],
      },
      assigneeRole: input.taskTemplate.assigneeRole,
      priority: input.taskTemplate.priority,
    },
    maxConcurrent: input.maxConcurrent,
    metadata: { ...input.metadata },
  };
}

export function validateScheduleRule(rule: ScheduleRule): void {
  if (!rule.id.trim()) {
    throw new Error("Schedule rule id is required");
  }
  validateScheduleRuleInput(rule);
}

function validateScheduleRuleInput(input: CreateScheduleRuleInput): void {
  if (!input.name.trim()) {
    throw new Error("Schedule rule name is required");
  }
  if (!input.missionId.trim()) {
    throw new Error("Schedule rule missionId is required");
  }
  if (!input.taskTemplate.title.trim()) {
    throw new Error("Task template title is required");
  }
  if (!input.taskTemplate.assigneeRole.trim()) {
    throw new Error("Task template assigneeRole is required");
  }
  if (!input.taskTemplate.contract.objective.trim()) {
    throw new Error("Task template contract objective is required");
  }
  if (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }

  validateTrigger(input.trigger);
}

function validateTrigger(trigger: ScheduleTrigger): void {
  if (trigger.type === "cron") {
    validateCronTrigger(trigger.expression, trigger.timezone);
    return;
  }

  if (trigger.type === "condition") {
    if (!trigger.description.trim()) {
      throw new Error("Condition trigger description is required");
    }
    if (!trigger.sourceAgentRole.trim()) {
      throw new Error("Condition trigger sourceAgentRole is required");
    }
    if (!trigger.evaluatePrompt.trim()) {
      throw new Error("Condition trigger evaluatePrompt is required");
    }
    return;
  }

  const exhaustive: never = trigger;
  throw new Error(`Unsupported schedule trigger: ${JSON.stringify(exhaustive)}`);
}

function validateCronTrigger(expression: string, timezone: string): void {
  if (!expression.trim()) {
    throw new Error("Cron trigger expression is required");
  }
  if (!timezone.trim()) {
    throw new Error("Cron trigger timezone is required");
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Unsupported cron expression");
  }
  if (parts.some((part) => part.includes("-"))) {
    throw new Error("Unsupported cron expression");
  }
  if (/[a-zA-Z]/.test(parts[4] ?? "")) {
    throw new Error("Unsupported cron expression");
  }
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  if (!parts.every((part, index) => isSupportedCronField(part, ranges[index]![0], ranges[index]![1]))) {
    throw new Error("Unsupported cron expression");
  }
}

function isSupportedCronField(field: string, min: number, max: number): boolean {
  if (field === "*") return true;
  if (/^\d+$/.test(field)) return isInRange(Number(field), min, max);
  const step = field.match(/^\*\/(\d+)$/);
  if (step) return Number(step[1]) > 0;
  if (/^\d+(,\d+)*$/.test(field)) {
    return field.split(",").every((value) => isInRange(Number(value), min, max));
  }
  return false;
}

function isInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
