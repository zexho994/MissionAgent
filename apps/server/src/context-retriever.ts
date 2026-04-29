import type { Artifact, Mission, Task } from "@digitalagent/core";
import type { AgentMessage, WarRoomAgent } from "./mission-service.js";
import type { ContextSnippet } from "./agent-conversation-types.js";
import type { KnowledgeEntry } from "./knowledge-base.js";

export interface ContextRetrieverSnapshot {
  missions: Mission[];
  tasks: Task[];
  artifacts: Artifact[];
  agents: WarRoomAgent[];
  agentMessages: AgentMessage[];
  knowledgeEntries: KnowledgeEntry[];
}

export class ContextRetriever {
  constructor(private readonly getSnapshot: () => ContextRetrieverSnapshot) {}

  getRelevantContext(input: {
    missionId: string;
    agentId: string;
    currentTopic: string;
    threadId?: string;
  }): ContextSnippet[] {
    const snapshot = this.getSnapshot();
    const mission = snapshot.missions.find((candidate) => candidate.id === input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const snippets: ContextSnippet[] = [{
      source: "mission",
      sourceId: mission.id,
      summary: JSON.stringify({
        goal: mission.goal,
        successMetrics: mission.successMetrics,
        constraints: mission.constraints,
        brief: mission.brief,
      }),
      relevance: 1,
      createdAt: mission.createdAt.toISOString(),
    }];

    const taskSnippets = snapshot.tasks
      .filter((task) => task.missionId === input.missionId)
      .slice(-5)
      .map((task): ContextSnippet => ({
        source: "task",
        sourceId: task.id,
        summary: `${task.title}: ${task.status}. Objective: ${task.contract.objective}`,
        relevance: task.assigneeAgentId === input.agentId ? 0.9 : 0.65,
        createdAt: new Date(0).toISOString(),
      }));
    snippets.push(...taskSnippets);

    const artifactSnippets = snapshot.artifacts
      .filter((artifact) => snapshot.tasks.some((task) => task.id === artifact.taskId && task.missionId === input.missionId))
      .slice(-5)
      .map((artifact): ContextSnippet => ({
        source: "artifact",
        sourceId: artifact.id,
        summary: JSON.stringify({
          taskId: artifact.taskId,
          type: artifact.type,
          qualityScore: artifact.qualityScore,
          content: artifact.content,
        }),
        relevance: 0.85,
        createdAt: artifact.createdAt.toISOString(),
      }));
    snippets.push(...artifactSnippets);

    const messageSnippets = snapshot.agentMessages
      .filter((message) => message.missionId === input.missionId)
      .filter((message) => !input.threadId || message.threadId === input.threadId || message.toAgentId === input.agentId)
      .slice(-10)
      .map((message): ContextSnippet => ({
        source: "message",
        sourceId: message.id,
        summary: `${message.type}: ${message.content}`,
        relevance: message.threadId === input.threadId ? 0.95 : 0.7,
        createdAt: message.createdAt,
      }));
    snippets.push(...messageSnippets);

    const knowledgeSnippets = snapshot.knowledgeEntries
      .filter((entry) => entry.missionId === input.missionId)
      .slice(-8)
      .map((entry): ContextSnippet => ({
        source: "knowledge",
        sourceId: entry.id,
        summary: `${entry.key}: ${entry.value}`,
        relevance: 0.75,
        createdAt: entry.createdAt,
      }));
    snippets.push(...knowledgeSnippets);

    return snippets
      .sort((a, b) => b.relevance - a.relevance || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 16);
  }
}
