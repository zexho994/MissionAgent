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
    scheduleRules: [],
  };
}

export function completeMission(mission: Mission): Mission {
  if (mission.status === "completed") return mission;
  if (mission.status === "cancelled") {
    throw new Error("Cannot complete a cancelled mission");
  }
  return { ...mission, status: "completed" };
}

export function cancelMission(mission: Mission): Mission {
  if (mission.status === "cancelled") return mission;
  if (mission.status === "completed") {
    throw new Error("Cannot cancel a completed mission");
  }
  return { ...mission, status: "cancelled" };
}

export function pauseMission(mission: Mission): Mission {
  if (mission.status === "paused") return mission;
  if (mission.status === "completed") {
    throw new Error("Cannot pause a completed mission");
  }
  if (mission.status === "cancelled") {
    throw new Error("Cannot pause a cancelled mission");
  }
  return { ...mission, status: "paused" };
}

export function resumeMission(mission: Mission): Mission {
  if (mission.status === "active") return mission;
  if (mission.status === "completed") {
    throw new Error("Cannot resume a completed mission");
  }
  if (mission.status === "cancelled") {
    throw new Error("Cannot resume a cancelled mission");
  }
  return { ...mission, status: "active" };
}
