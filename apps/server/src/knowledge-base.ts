import { createId } from "@digitalagent/core";

export interface KnowledgeEntry {
  id: string;
  missionId: string;
  key: string;
  value: string;
  sourceAgentId: string;
  createdAt: string;
}

export function createKnowledgeEntry(
  input: Omit<KnowledgeEntry, "id" | "createdAt">,
): KnowledgeEntry {
  return {
    id: createId("knowledge"),
    missionId: input.missionId,
    key: input.key,
    value: input.value,
    sourceAgentId: input.sourceAgentId,
    createdAt: new Date().toISOString(),
  };
}
