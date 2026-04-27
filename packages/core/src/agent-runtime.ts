import { createId } from "./ids.js";
import type { AgentInstance, MemoryScope, RoleBudget, RoleSpec } from "./types.js";

export interface CreateRoleSpecInput {
  name: string;
  purpose: string;
  responsibilities: string[];
  allowedTools: string[];
  inputContract: Record<string, unknown>;
  outputContract: Record<string, unknown>;
  successCriteria: string[];
  budget: RoleBudget;
}

export interface CreateAgentInstanceInput {
  missionId: string;
  roleSpec: RoleSpec;
  memoryScope: MemoryScope;
}

export function createRoleSpec(input: CreateRoleSpecInput): RoleSpec {
  if (!input.name.trim()) {
    throw new Error("RoleSpec name is required");
  }
  if (!input.purpose.trim()) {
    throw new Error("RoleSpec purpose is required");
  }
  if (input.responsibilities.length === 0) {
    throw new Error("RoleSpec requires at least one responsibility");
  }
  if (input.allowedTools.length === 0) {
    throw new Error("RoleSpec requires at least one allowed tool");
  }
  if (input.successCriteria.length === 0) {
    throw new Error("RoleSpec requires at least one success criterion");
  }
  if (input.budget.maxRuntimeMinutes <= 0) {
    throw new Error("RoleSpec budget.maxRuntimeMinutes must be positive");
  }
  if (input.budget.maxTasks <= 0) {
    throw new Error("RoleSpec budget.maxTasks must be positive");
  }

  return {
    id: createId("role"),
    name: input.name,
    purpose: input.purpose,
    responsibilities: [...input.responsibilities],
    allowedTools: [...input.allowedTools],
    inputContract: { ...input.inputContract },
    outputContract: { ...input.outputContract },
    successCriteria: [...input.successCriteria],
    budget: { ...input.budget },
  };
}

export function createAgentInstance(input: CreateAgentInstanceInput): AgentInstance {
  if (!input.missionId.trim()) {
    throw new Error("AgentInstance missionId is required");
  }

  return {
    id: createId("agent"),
    missionId: input.missionId,
    roleSpec: input.roleSpec,
    status: "idle",
    memoryScope: input.memoryScope,
    toolPermissions: [...input.roleSpec.allowedTools],
    budget: { ...input.roleSpec.budget },
  };
}
