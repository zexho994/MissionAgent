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
  | { type: "periodic_report"; fromAgentId: string; content: string; taskId?: string }
  | FeedbackEvaluatedEvent;

export interface FeedbackEvaluatedEvent {
  type: "feedback_evaluated";
  missionId: string;
  taskId: string;
  evaluation: import("@digitalagent/core").MissionOutcomeEvaluation;
  failureAnalysis?: import("@digitalagent/core").TaskFailureAnalysis;
  timestamp: string;
}

export interface AgentConversationResponse {
  message: string;
  type: AgentMessageType;
  mentionedAgentIds?: string[];
  shouldPropagate: boolean;
  action?: {
    type: "request_info" | "notify_owner" | "escalate" | "acknowledge" | "report_to_superior" | "propose_strategy_adjustment";
    targetAgentId?: string;
    payload?: Record<string, unknown>;
  };
}

export interface ContextSnippet {
  source: "artifact" | "message" | "task" | "mission" | "knowledge" | "feedback";
  sourceId: string;
  summary: string;
  relevance: number;
  createdAt: string;
}
