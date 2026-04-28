import type { LlmMessage, LlmService } from "@digitalagent/runtime";
import type { AgentPersonaRegistry } from "./agent-personas.js";
import type { ContextRetriever } from "./context-retriever.js";
import type {
  AgentConversationResponse,
  BusEvent,
  ConversationThread,
} from "./agent-conversation-types.js";
import type { AgentMessage, AgentMessageType, MissionSnapshot, WarRoomAgent } from "./mission-service.js";

const CONVERSATION_TYPES = new Set<AgentMessageType>([
  "agent_chat",
  "agent_report",
  "agent_request",
  "agent_notify",
  "agent_discussion",
]);

export class AgentConversationBus {
  private readonly cooldowns = new Map<string, number>();

  constructor(private readonly deps: {
    llm: LlmService;
    personas: AgentPersonaRegistry;
    contextRetriever: ContextRetriever;
    getSnapshot: () => MissionSnapshot;
    appendMessage: (message: Omit<AgentMessage, "id" | "createdAt">) => AgentMessage;
    createThread: (thread: Omit<ConversationThread, "id" | "createdAt">) => ConversationThread;
    resolveThread: (threadId: string) => void;
    updateAgent: (id: string, patch: Partial<WarRoomAgent>) => void;
    maxConversationDepth: number;
    cooldownMs: number;
  }) {}

  async dispatchEvent(input: {
    missionId: string;
    event: BusEvent;
    threadId?: string;
    triggerDepth?: number;
  }): Promise<AgentMessage | undefined> {
    const depth = input.triggerDepth ?? 0;
    if (depth >= this.deps.maxConversationDepth) {
      if (input.threadId) this.deps.resolveThread(input.threadId);
      return undefined;
    }

    const snapshot = this.deps.getSnapshot();
    const mission = snapshot.missions.find((candidate) => candidate.id === input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const targets = this.targetAgents(input.missionId, input.event, snapshot);
    if (!targets.length) {
      return undefined;
    }

    let thread = input.threadId ? snapshot.threads.find((candidate) => candidate.id === input.threadId) : undefined;
    if (!thread) {
      thread = this.deps.createThread({
        missionId: input.missionId,
        topic: this.topicForEvent(input.event),
        participantAgentIds: this.participantIds(input.event, targets),
        status: "active",
      });
    }

    let lastMessage: AgentMessage | undefined;
    for (const target of targets) {
      if (!this.canEngage(input.event, target.id)) {
        continue;
      }
      this.deps.updateAgent(target.id, {
        status: "thinking",
        lastAction: "Responding in agent conversation",
      });
      try {
        const response = await this.callAgent({
          missionId: input.missionId,
          event: input.event,
          target,
          thread,
        });
        const messageInput: Omit<AgentMessage, "id" | "createdAt"> = {
          missionId: input.missionId,
          fromAgentId: target.id,
          type: response.type,
          content: response.message,
          threadId: thread.id,
        };
        if (response.mentionedAgentIds?.length) {
          messageInput.mentionedAgentIds = response.mentionedAgentIds;
        }
        if (response.action) {
          messageInput.metadata = { action: response.action };
        }
        lastMessage = this.deps.appendMessage(messageInput);
        this.deps.updateAgent(target.id, {
          status: "idle",
          lastAction: "Responded in agent conversation",
        });
        this.recordCooldown(input.event, target.id);

        if (response.shouldPropagate && response.action?.type === "request_info" && response.action.targetAgentId) {
          await this.dispatchEvent({
            missionId: input.missionId,
            event: {
              type: "agent_request",
              fromAgentId: target.id,
              toAgentId: response.action.targetAgentId,
              content: response.message,
            },
            threadId: thread.id,
            triggerDepth: depth + 1,
          });
        }
      } catch (error) {
        lastMessage = this.deps.appendMessage({
          missionId: input.missionId,
          fromAgentId: target.id,
          type: "agent_chat",
          content: `Collaboration response failed: ${error instanceof Error ? error.message : String(error)}`,
          threadId: thread.id,
          metadata: { shouldPropagate: false },
        });
        this.deps.updateAgent(target.id, {
          status: "blocked",
          lastAction: "Agent conversation failed",
        });
      }
    }

    this.deps.resolveThread(thread.id);
    return lastMessage;
  }

  private async callAgent(input: {
    missionId: string;
    event: BusEvent;
    target: WarRoomAgent;
    thread: ConversationThread;
  }): Promise<AgentConversationResponse> {
    const snapshot = this.deps.getSnapshot();
    const mission = snapshot.missions.find((candidate) => candidate.id === input.missionId);
    if (!mission) throw new Error(`Mission not found: ${input.missionId}`);
    const persona = this.deps.personas.personaFor(input.target);
    const context = this.deps.contextRetriever.getRelevantContext({
      missionId: input.missionId,
      agentId: input.target.id,
      currentTopic: input.thread.topic,
      threadId: input.thread.id,
    });
    const threadMessages = snapshot.agentMessages
      .filter((message) => message.threadId === input.thread.id)
      .map((message) => `${message.fromAgentId}: ${message.content}`)
      .join("\n");
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: [
          persona.systemPrompt,
          `Communication style: ${persona.communicationStyle}`,
          `Response guidelines: ${persona.responseGuidelines}`,
          `Available actions: ${persona.availableActions.join(", ")}`,
          `Mission goal: ${mission.goal}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Thread topic: ${input.thread.topic}`,
          `Event: ${JSON.stringify(input.event)}`,
          `Shared context: ${JSON.stringify(context)}`,
          `Thread history:\n${threadMessages || "(none)"}`,
          "Respond with one JSON object only: {\"message\":\"...\",\"type\":\"agent_chat|agent_report|agent_request|agent_notify|agent_discussion\",\"mentionedAgentIds\":[],\"shouldPropagate\":false,\"action\":{\"type\":\"acknowledge\"}}",
        ].join("\n\n"),
      },
    ];
    const result = await this.deps.llm.call(messages, { temperature: 0.2 });
    return parseAgentConversationResponse(result.content);
  }

  private targetAgents(missionId: string, event: BusEvent, snapshot: MissionSnapshot): WarRoomAgent[] {
    const agents = snapshot.agents.filter((agent) => agent.missionId === missionId);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const owner = agents.find((agent) => agent.role === "owner");
    const planner = agents.find((agent) => /planner|strategist|research|analyst|architect/.test(`${agent.role} ${agent.name}`));
    const worker = "agentId" in event ? byId.get(event.agentId) : undefined;

    switch (event.type) {
      case "execution_completed":
        return uniqueAgents([worker, owner, planner]);
      case "execution_failed":
        return uniqueAgents([owner, planner, worker]);
      case "review_completed":
        return uniqueAgents([owner, worker]);
      case "review_revision_needed":
        return uniqueAgents([planner, worker]);
      case "agent_request":
        return uniqueAgents([byId.get(event.toAgentId)]);
      case "agent_notify":
        return uniqueAgents(event.mentionedAgentIds.map((id) => byId.get(id)));
      case "user_message":
        return uniqueAgents([byId.get(event.agentId)]);
    }
  }

  private topicForEvent(event: BusEvent): string {
    switch (event.type) {
      case "execution_completed":
        return "Execution completed collaboration report";
      case "execution_failed":
        return "Execution failure coordination";
      case "review_completed":
        return "Review completed follow-up";
      case "review_revision_needed":
        return "Revision discussion";
      case "agent_request":
        return "Agent information request";
      case "agent_notify":
        return "Agent notification";
      case "user_message":
        return "User-triggered agent conversation";
    }
  }

  private participantIds(event: BusEvent, targets: WarRoomAgent[]): string[] {
    const ids = targets.map((agent) => agent.id);
    if ("fromAgentId" in event) ids.push(event.fromAgentId);
    if ("agentId" in event) ids.push(event.agentId);
    return [...new Set(ids)];
  }

  private canEngage(event: BusEvent, targetAgentId: string): boolean {
    if (!("fromAgentId" in event)) return true;
    const key = `${event.fromAgentId}->${targetAgentId}`;
    const last = this.cooldowns.get(key);
    return last === undefined || Date.now() - last >= this.deps.cooldownMs;
  }

  private recordCooldown(event: BusEvent, targetAgentId: string): void {
    if (!("fromAgentId" in event)) return;
    this.cooldowns.set(`${event.fromAgentId}->${targetAgentId}`, Date.now());
  }
}

function parseAgentConversationResponse(content: string): AgentConversationResponse {
  try {
    const parsed = JSON.parse(content) as Partial<AgentConversationResponse>;
    if (typeof parsed.message !== "string" || !parsed.message.trim()) {
      throw new Error("message is required");
    }
    const type = typeof parsed.type === "string" && CONVERSATION_TYPES.has(parsed.type as AgentMessageType)
      ? parsed.type as AgentMessageType
      : "agent_chat";
    const response: AgentConversationResponse = {
      message: parsed.message.trim(),
      type,
      mentionedAgentIds: Array.isArray(parsed.mentionedAgentIds)
        ? parsed.mentionedAgentIds.filter((id): id is string => typeof id === "string")
        : [],
      shouldPropagate: parsed.shouldPropagate === true,
    };
    const action = parseAction(parsed.action);
    if (action) response.action = action;
    return response;
  } catch {
    return {
      message: content.trim(),
      type: "agent_chat",
      mentionedAgentIds: [],
      shouldPropagate: false,
      action: { type: "acknowledge" },
    };
  }
}

function parseAction(action: unknown): AgentConversationResponse["action"] {
  if (!action || typeof action !== "object") {
    return { type: "acknowledge" };
  }
  const value = action as Record<string, unknown>;
  const type = value.type;
  if (type !== "request_info" && type !== "notify_owner" && type !== "escalate" && type !== "acknowledge") {
    return { type: "acknowledge" };
  }
  const parsed: NonNullable<AgentConversationResponse["action"]> = { type };
  if (typeof value.targetAgentId === "string") parsed.targetAgentId = value.targetAgentId;
  if (value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)) {
    parsed.payload = value.payload as Record<string, unknown>;
  }
  return parsed;
}

function uniqueAgents(agents: Array<WarRoomAgent | undefined>): WarRoomAgent[] {
  const byId = new Map<string, WarRoomAgent>();
  for (const agent of agents) {
    if (agent) byId.set(agent.id, agent);
  }
  return [...byId.values()];
}
