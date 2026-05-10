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
  | { type: "user_message"; content: string; agentId: string }
  | { type: "periodic_report"; fromAgentId: string; content: string; taskId?: string };

export interface CreateFollowupTaskPayload {
  title: string;
  objective: string;
  assigneeRole: string;
  reason: string;
  sourceTaskId?: string;
  inputContext?: Record<string, unknown>;
}

export type AgentConversationAction =
  | {
      type: "request_info" | "notify_owner" | "escalate" | "acknowledge" | "report_to_superior";
      targetAgentId?: string;
      payload?: Record<string, unknown>;
    }
  | {
      type: "create_followup_task";
      payload: CreateFollowupTaskPayload;
    };

export interface AgentConversationResponse {
  message: string;
  type: AgentMessageType;
  mentionedAgentIds?: string[];
  shouldPropagate: boolean;
  action?: AgentConversationAction;
}

export interface ContextSnippet {
  source: "artifact" | "message" | "task" | "mission" | "knowledge";
  sourceId: string;
  summary: string;
  relevance: number;
  createdAt: string;
}
