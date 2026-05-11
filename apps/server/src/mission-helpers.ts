import { transitionTask, type Task } from "@digitalagent/core";
import type { AgentSystemConfig } from "./system-config.js";
import { renderTemplate } from "./system-config.js";

export function ensureTaskRunning(task: Task): Task {
  if (task.status === "running") {
    return task;
  }
  if (task.status === "revision_needed") {
    const updated = transitionTask(task, { type: "task.updated" });
    const queued = transitionTask(updated, { type: "dependencies.met" });
    return transitionTask(queued, { type: "worker.assigned", agentInstanceId: "pi_runner" });
  }
  if (task.status !== "draft") {
    throw new Error(`Task cannot be executed from status: ${task.status}`);
  }

  const ready = transitionTask(task, { type: "contract.completed" });
  const queued = transitionTask(ready, { type: "dependencies.met" });
  return transitionTask(queued, { type: "worker.assigned", agentInstanceId: "pi_runner" });
}

export function deriveOwnerBrief(goal: string, config: AgentSystemConfig): {
  successMetrics: string[];
  constraints: string[];
  summary: string;
} {
  if (!goal.trim()) {
    throw new Error("Mission goal is required");
  }

  return {
    successMetrics: [...config.owner.brief.successMetrics],
    constraints: [...config.owner.brief.constraints],
    summary: renderTemplate(config.owner.brief.summaryTemplate, { goal }),
  };
}

export function deriveOwnerFollowup(message: string, config: AgentSystemConfig): string {
  return renderTemplate(config.owner.followup.template, { message });
}
