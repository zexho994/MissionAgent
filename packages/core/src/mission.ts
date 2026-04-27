import { createId } from "./ids.js";
import type { Mission, MissionBudget } from "./types.js";

export interface CreateMissionInput {
  goal: string;
  successMetrics: string[];
  constraints: string[];
  budget?: Partial<MissionBudget>;
}

export function createMission(input: CreateMissionInput): Mission {
  if (!input.goal.trim()) {
    throw new Error("Mission goal is required");
  }
  if (input.successMetrics.length === 0) {
    throw new Error("Mission requires at least one success metric");
  }
  if (input.constraints.length === 0) {
    throw new Error("Mission requires at least one constraint");
  }

  return {
    id: createId("mission"),
    goal: input.goal,
    successMetrics: [...input.successMetrics],
    constraints: [...input.constraints],
    status: "active",
    budget: {
      maxRuntimeMinutes: input.budget?.maxRuntimeMinutes ?? 60,
      ...(input.budget?.maxTokenSpendUsd === undefined
        ? {}
        : { maxTokenSpendUsd: input.budget.maxTokenSpendUsd }),
    },
    createdAt: new Date(),
  };
}
