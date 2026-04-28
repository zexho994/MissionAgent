import { createId } from "./ids.js";
import type { RoleSpec } from "./types.js";

export type RoleType =
  | "content_creator"
  | "data_analyst"
  | "project_manager"
  | "specialist"
  | "reviewer"
  | "analyst";

export type Urgency = "low" | "medium" | "high" | "critical";

export type NegotiationStyle = "collaborative" | "assertive" | "accommodating";

export interface RoleRequirement {
  id: string;
  missionId: string;
  roleType: RoleType;
  neededCapabilities: string[];
  urgency: Urgency;
  budgetMax: number;
  constraints: string[] | undefined;
  createdAt: Date;
}

export interface CreateRoleRequirementInput {
  missionId: string;
  roleType: RoleType;
  neededCapabilities: string[];
  urgency: Urgency;
  budgetMax: number;
  constraints?: string[];
}

export function createRoleRequirement(
  input: CreateRoleRequirementInput
): RoleRequirement {
  if (!input.missionId.trim()) {
    throw new Error("Mission ID is required");
  }
  if (input.neededCapabilities.length === 0) {
    throw new Error("At least one capability is required");
  }
  if (input.budgetMax < 0) {
    throw new Error("Budget max must be non-negative");
  }

  return {
    id: createId("role_req"),
    missionId: input.missionId,
    roleType: input.roleType,
    neededCapabilities: [...input.neededCapabilities],
    urgency: input.urgency,
    budgetMax: input.budgetMax,
    constraints: input.constraints ? [...input.constraints] : undefined,
    createdAt: new Date(),
  };
}

export interface HRAgentConfig {
  id: string;
  negotiationStyle: NegotiationStyle;
  maxRounds: number;
  escalationThreshold: number;
  preferredTeamSize: [number, number];
  createdAt: Date;
}

export interface CreateHRAgentConfigInput {
  negotiationStyle: NegotiationStyle;
  maxRounds?: number;
  escalationThreshold?: number;
  preferredTeamSize?: [number, number];
}

export function createHRAgentConfig(
  input: CreateHRAgentConfigInput
): HRAgentConfig {
  if (input.maxRounds !== undefined && input.maxRounds < 1) {
    throw new Error("Max rounds must be at least 1");
  }
  if (
    input.escalationThreshold !== undefined &&
    (input.escalationThreshold < 0 || input.escalationThreshold > 1)
  ) {
    throw new Error("Escalation threshold must be between 0 and 1");
  }

  return {
    id: createId("hr_config"),
    negotiationStyle: input.negotiationStyle,
    maxRounds: input.maxRounds ?? 3,
    escalationThreshold: input.escalationThreshold ?? 0.5,
    preferredTeamSize: input.preferredTeamSize ?? [2, 5],
    createdAt: new Date(),
  };
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export function validateRoleSpec(roleSpec: RoleSpec): ValidationResult {
  const errors: string[] = [];

  if (!roleSpec.id.trim()) {
    errors.push("Role ID is required");
  }
  if (!roleSpec.name.trim()) {
    errors.push("Role name is required");
  }
  if (!roleSpec.purpose.trim()) {
    errors.push("Role purpose is required");
  }
  if (roleSpec.responsibilities.length === 0) {
    errors.push("At least one responsibility is required");
  }
  if (roleSpec.allowedTools.length === 0) {
    errors.push("At least one tool permission is required");
  }
  if (roleSpec.successCriteria.length === 0) {
    errors.push("At least one success criterion is required");
  }
  if (roleSpec.budget.maxRuntimeMinutes < 0) {
    errors.push("Max runtime minutes must be non-negative");
  }
  if (roleSpec.budget.maxTasks < 1) {
    errors.push("Max tasks must be at least 1");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}