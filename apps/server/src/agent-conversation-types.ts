import type { AgentMessageType } from "./mission-service.js";

export interface ConversationThread {
  id: string;
  missionId: string;
  topic: string;
  participantAgentIds: string[];
  status: "active" | "resolved" | "abandoned";
  triggerEventId?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type BusEvent =
  | { type: "execution_completed"; agentId: string; taskId: string; artifactId: string }
  | { type: "execution_failed"; agentId: string; taskId: string; error: string }
  | { type: "review_completed"; agentId: string; taskId: string; decision: string }
  | { type: "review_revision_needed"; agentId: string; taskId: string; comments: string[] }
  | { type: "agent_request"; fromAgentId: string; toAgentId: string; content: string }
  | { type: "agent_notify"; fromAgentId: string; content: string; mentionedAgentIds: string[] }
  | { type: "user_message"; content: string; agentId: string };

export interface AgentConversationResponse {
  message: string;
  type: AgentMessageType;
  mentionedAgentIds?: string[];
  shouldPropagate: boolean;
  action?: {
    type: "request_info" | "notify_owner" | "escalate" | "acknowledge";
    targetAgentId?: string;
    payload?: Record<string, unknown>;
  };
}

export interface ContextSnippet {
  source: "artifact" | "message" | "task" | "mission";
  sourceId: string;
  summary: string;
  relevance: number;
  createdAt: string;
}
