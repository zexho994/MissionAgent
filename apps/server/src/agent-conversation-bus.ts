import type { LlmMessage, LlmService } from "@digitalagent/runtime";
import type { AgentPersonaRegistry } from "./agent-personas.js";
import type { ContextRetriever } from "./context-retriever.js";
import type {
  AgentConversationResponse,
  BusEvent,
  ConversationThread,
  CreateFollowupTaskPayload,
} from "./agent-conversation-types.js";
import type { AgentMessage, AgentMessageType, MissionSnapshot, WarRoomAgent } from "./mission-service.js";
import { findSuperiors } from "./agent-hierarchy.js";

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
    maxDiscussionRounds: number;
    cooldownMs: number;
    createFollowupTask?: (input: {
      missionId: string;
      triggeringEventId: string;
      payload: CreateFollowupTaskPayload;
    }) => Promise<
      | { created: true; taskId: string }
      | { created: false; reason: string; escalateMessageSent?: boolean }
    >;
    recordLlmCall?: (input: {
      missionId: string;
      promptTokens: number;
      completionTokens: number;
    }) => void;
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
    const initialTargets = this.targetAgents(input.missionId, input.event, snapshot);
    if (!initialTargets.length) {
      return undefined;
    }

    let thread = input.threadId ? snapshot.threads.find((candidate) => candidate.id === input.threadId) : undefined;
    if (!thread) {
      thread = this.deps.createThread({
        missionId: input.missionId,
        topic: this.topicForEvent(input.event),
        participantAgentIds: this.participantIds(input.event, initialTargets),
        status: "active",
      });
    }

    const responded = new Set<string>();
    const agentById = new Map(snapshot.agents.filter((a) => a.missionId === input.missionId).map((a) => [a.id, a]));
    let lastMessage: AgentMessage | undefined;
    let lastRoundPropagated = false;
    let roundTargets = [...initialTargets];

    for (let round = 0; round < this.deps.maxDiscussionRounds && roundTargets.length > 0; round++) {
      const nextRoundTargets: WarRoomAgent[] = [];

      for (const target of roundTargets) {
        if (responded.has(target.id)) continue;
        if (!this.canEngage(input.event, target.id)) continue;
        responded.add(target.id);

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

          if (
            response.action?.type === "create_followup_task" &&
            this.deps.createFollowupTask
          ) {
            const triggeringEventId = `${thread.id}:${target.id}:${lastMessage.id}`;
            try {
              await this.deps.createFollowupTask({
                missionId: input.missionId,
                triggeringEventId,
                payload: response.action.payload,
              });
            } catch (error) {
              console.error(
                "[AgentConversationBus] createFollowupTask failed:",
                error instanceof Error ? error.message : String(error),
              );
            }
          }

          const propagated = this.propagationTargets(response, responded, agentById);
          nextRoundTargets.push(...propagated);
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

      lastRoundPropagated = nextRoundTargets.length > 0;
      if (!lastRoundPropagated) break;
      roundTargets = nextRoundTargets;
    }

    if (!lastRoundPropagated) {
      this.deps.resolveThread(thread.id);
    }
    return lastMessage;
  }

  private propagationTargets(
    response: AgentConversationResponse,
    responded: Set<string>,
    agentById: Map<string, WarRoomAgent>,
  ): WarRoomAgent[] {
    if (!response.shouldPropagate) return [];
    const candidateIds: string[] = [];
    if (response.action && response.action.type !== "create_followup_task" && response.action.targetAgentId) {
      candidateIds.push(response.action.targetAgentId);
    }
    if (response.mentionedAgentIds?.length) {
      candidateIds.push(...response.mentionedAgentIds);
    }
    const targets: WarRoomAgent[] = [];
    for (const id of candidateIds) {
      if (responded.has(id)) continue;
      const agent = agentById.get(id);
      if (agent) targets.push(agent);
    }
    return targets;
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
          knowledgeSummary(context),
          "Choose `action.type` based on your persona's `Available actions`. If `create_followup_task` is among your available actions AND the event indicates substantive work has just completed (or a review approved a result) AND the mission needs the next concrete work step, you MAY return: {\"action\":{\"type\":\"create_followup_task\",\"payload\":{\"title\":\"<short task name>\",\"objective\":\"<one-sentence what to deliver>\",\"assigneeRole\":\"<role name from team>\",\"reason\":\"<why this is the right next step>\",\"sourceTaskId\":\"<optional id of the task this builds on>\"}}}. Otherwise return one of: acknowledge / report_to_superior / request_info / notify_owner / escalate.",
          "Respond with one JSON object only: {\"message\":\"...\",\"type\":\"agent_chat|agent_report|agent_request|agent_notify|agent_discussion\",\"mentionedAgentIds\":[],\"shouldPropagate\":false,\"action\":{...}}",
        ].join("\n\n"),
      },
    ];
    const result = await this.deps.llm.call(messages, { temperature: 0.2 });
    if (this.deps.recordLlmCall) {
      this.deps.recordLlmCall({
        missionId: input.missionId,
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
      });
    }
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
      case "periodic_report": {
        const superiors = findSuperiors(event.fromAgentId, snapshot.agentRelations, agents);
        if (superiors.length > 0) return superiors;
        return uniqueAgents([owner]);
      }
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
      case "periodic_report":
        return "Periodic status report";
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

export function parseAgentConversationResponse(content: string): AgentConversationResponse {
  try {
    const json = extractJsonObject(content);
    if (!json) {
      throw new Error("No JSON object found");
    }
    const parsed = JSON.parse(json) as Partial<AgentConversationResponse>;
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

function extractJsonObject(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const startIndex = candidate.indexOf("{");
  if (startIndex === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\" && inString) {
      escape = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(startIndex, i + 1);
    }
  }

  return undefined;
}

function parseAction(action: unknown): AgentConversationResponse["action"] {
  if (!action || typeof action !== "object") {
    return { type: "acknowledge" };
  }
  const value = action as Record<string, unknown>;
  const type = value.type;
  if (type === "create_followup_task") {
    const payload = value.payload as Record<string, unknown> | undefined;
    if (
      !payload ||
      typeof payload.title !== "string" || !payload.title.trim() ||
      typeof payload.objective !== "string" || !payload.objective.trim() ||
      typeof payload.assigneeRole !== "string" || !payload.assigneeRole.trim() ||
      typeof payload.reason !== "string" || !payload.reason.trim()
    ) {
      return { type: "acknowledge" };
    }
    const followupPayload: CreateFollowupTaskPayload = {
      title: payload.title.trim(),
      objective: payload.objective.trim(),
      assigneeRole: payload.assigneeRole.trim(),
      reason: payload.reason.trim(),
    };
    if (typeof payload.sourceTaskId === "string" && payload.sourceTaskId.trim()) {
      followupPayload.sourceTaskId = payload.sourceTaskId.trim();
    }
    if (
      payload.inputContext &&
      typeof payload.inputContext === "object" &&
      !Array.isArray(payload.inputContext)
    ) {
      followupPayload.inputContext = payload.inputContext as Record<string, unknown>;
    }
    return { type: "create_followup_task", payload: followupPayload };
  }
  if (type !== "request_info" && type !== "notify_owner" && type !== "escalate" && type !== "acknowledge" && type !== "report_to_superior") {
    return { type: "acknowledge" };
  }
  const parsed: { type: typeof type; targetAgentId?: string; payload?: Record<string, unknown> } = { type };
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

function knowledgeSummary(context: import("./agent-conversation-types.js").ContextSnippet[]): string {
  const knowledge = context.filter((snippet) => snippet.source === "knowledge");
  if (knowledge.length === 0) return "";
  return `Mission knowledge base:\n${knowledge.map((snippet) => `- ${snippet.summary}`).join("\n")}`;
}
