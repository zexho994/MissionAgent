import { createId } from "./ids.js";
import type { Task, TaskContract } from "./types.js";

export interface CreateTaskInput {
  missionId: string;
  title: string;
  dependencies: string[];
  contract: TaskContract;
  approvalRequired: boolean;
}

export function createTask(input: CreateTaskInput): Task {
  if (!input.missionId.trim()) {
    throw new Error("Task missionId is required");
  }
  if (!input.title.trim()) {
    throw new Error("Task title is required");
  }
  if (!input.contract.objective.trim()) {
    throw new Error("Task contract objective is required");
  }
  if (input.contract.successCriteria.length === 0) {
    throw new Error("Task contract requires at least one success criterion");
  }

  return {
    id: createId("task"),
    missionId: input.missionId,
    title: input.title,
    status: "draft",
    dependencies: [...input.dependencies],
    contract: {
      objective: input.contract.objective,
      input: { ...input.contract.input },
      outputSchema: { ...input.contract.outputSchema },
      successCriteria: [...input.contract.successCriteria],
    },
    approvalRequired: input.approvalRequired,
  };
}
