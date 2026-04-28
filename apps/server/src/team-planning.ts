import type { AgentRelation } from "./mission-service.js";
import type { AgentSystemConfig, ConfigAgentSpec } from "./system-config.js";

export interface MissionTeamPlan {
  initialTaskTitle: string;
  initialTaskObjective: string;
  agents: TeamAgentSpec[];
  relations: TeamRelationSpec[];
}

export interface TeamAgentSpec extends ConfigAgentSpec {
  sortOrder: number;
}

export interface TeamRelationSpec {
  fromRole: string;
  toRole: string;
  label: string;
  status: AgentRelation["status"];
}

export function planMissionTeam(goal: string, config: AgentSystemConfig): MissionTeamPlan {
  const normalized = goal.toLowerCase();
  const matchedRules = config.teamPlanner.rules.filter((rule) =>
    rule.keywords.some((keyword) => normalized.includes(keyword.toLowerCase())),
  );
  const matchedRuleIds = new Set(matchedRules.map((rule) => rule.id));
  const agents: TeamAgentSpec[] = [
    ...config.teamPlanner.baseAgents.map((agent) => ({ ...agent, sortOrder: 0 })),
    ...matchedRules.map((rule) => ({ ...rule.agent, sortOrder: 0 })),
  ];

  if (matchedRules.length === 0) {
    agents.push({ ...config.teamPlanner.fallbackAgent, sortOrder: 0 });
  }

  agents.push({ ...config.teamPlanner.reviewAgent, sortOrder: 0 });

  agents.forEach((agent, index) => {
    agent.sortOrder = index;
  });

  const relations: TeamRelationSpec[] = [];
  for (let i = 0; i < agents.length - 1; i += 1) {
    const from = agents[i];
    const to = agents[i + 1];
    if (!from || !to) continue;
    relations.push({
      fromRole: from.role,
      toRole: to.role,
      label: relationLabel(from.role, to.role, config),
      status: i === 0 ? "active" : "waiting",
    });
  }

  const initialTask = initialTaskFor(matchedRuleIds, config);
  return {
    initialTaskTitle: initialTask.title,
    initialTaskObjective: initialTask.objective,
    agents,
    relations,
  };
}

export function relationLabel(fromRole: string, toRole: string, config: AgentSystemConfig): string {
  const match = config.teamPlanner.relationLabels.find((candidate) => {
    if (candidate.fromRole && candidate.fromRole !== fromRole) return false;
    if (candidate.toRole && candidate.toRole !== toRole) return false;
    if (candidate.fromRoleIncludes && !fromRole.includes(candidate.fromRoleIncludes)) return false;
    return Boolean(candidate.fromRole || candidate.toRole || candidate.fromRoleIncludes);
  });
  return match?.label ?? config.teamPlanner.relationLabels.at(-1)?.label ?? "relation";
}

export function matcherFor(parts: string[]): RegExp {
  return new RegExp(parts.map(escapeRegExp).join("|"), "i");
}

function initialTaskFor(matchedRuleIds: Set<string>, config: AgentSystemConfig): { title: string; objective: string } {
  const match = config.teamPlanner.initialTasks.find((task) =>
    task.requires.every((required) => matchedRuleIds.has(required)),
  );
  if (!match) {
    throw new Error("No matching initial task config");
  }
  return match;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
