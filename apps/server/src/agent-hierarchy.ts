import type { AgentRelation, WarRoomAgent } from "./mission-service.js";

const HIERARCHY_LABELS = [
  "Oversee and guide",
  "Assign tasks and monitor",
  "Delegate team planning",
  "Assign responsibilities",
  "Request research and analysis",
  "Assign development tasks",
  "Request quality assurance",
];

export function findSuperiors(
  agentId: string,
  relations: AgentRelation[],
  agents: WarRoomAgent[],
): WarRoomAgent[] {
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const superiorIds = relations
    .filter((r) => r.toAgentId === agentId && isHierarchicalLabel(r.label))
    .map((r) => r.fromAgentId);

  const superiors: WarRoomAgent[] = [];
  for (const id of superiorIds) {
    const agent = agentById.get(id);
    if (agent) superiors.push(agent);
  }
  return superiors;
}

export function findSubordinates(
  agentId: string,
  relations: AgentRelation[],
  agents: WarRoomAgent[],
): WarRoomAgent[] {
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const subordinateIds = relations
    .filter((r) => r.fromAgentId === agentId && isHierarchicalLabel(r.label))
    .map((r) => r.toAgentId);

  const subordinates: WarRoomAgent[] = [];
  for (const id of subordinateIds) {
    const agent = agentById.get(id);
    if (agent) subordinates.push(agent);
  }
  return subordinates;
}

function isHierarchicalLabel(label: string): boolean {
  return HIERARCHY_LABELS.some((h) => label.includes(h) || h.includes(label));
}
