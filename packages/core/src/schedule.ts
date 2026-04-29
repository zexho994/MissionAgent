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

function validateTrigger(trigger: ScheduleTrigger): void {
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
  }
}
