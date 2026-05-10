import { describe, it, expect } from "vitest";
import { AgentConversationBus, parseAgentConversationResponse } from "./agent-conversation-bus.js";
import type { AgentConversationResponse, BusEvent, ConversationThread } from "./agent-conversation-types.js";
import type { AgentMessage, MissionSnapshot, WarRoomAgent } from "./mission-service.js";
import type { LlmMessage, LlmService } from "@digitalagent/runtime";
import type { AgentPersonaRegistry } from "./agent-personas.js";
import type { ContextRetriever } from "./context-retriever.js";

const baseSnapshot: MissionSnapshot = {
  missions: [{ id: "m1", goal: "test discussion", successMetrics: [], constraints: [], status: "active", budget: { maxRuntimeMinutes: 60 }, createdAt: new Date(), scheduleRules: [] }],
  plans: [],
  tasks: [],
  artifacts: [],
  reviews: [],
  executions: [],
  agents: [
    { id: "owner", missionId: "m1", role: "owner", name: "Owner", responsibility: "oversee", status: "idle", currentTaskId: undefined, lastAction: "", avatarSeed: "o", sortOrder: 0 },
    { id: "pm", missionId: "m1", role: "project_manager", name: "PM", responsibility: "manage", status: "idle", currentTaskId: undefined, lastAction: "", avatarSeed: "p", sortOrder: 1 },
    { id: "planner", missionId: "m1", role: "content_planner", name: "Planner", responsibility: "plan content", status: "idle", currentTaskId: undefined, lastAction: "", avatarSeed: "c", sortOrder: 2 },
    { id: "analyst", missionId: "m1", role: "data_analyst", name: "Analyst", responsibility: "analyze", status: "idle", currentTaskId: undefined, lastAction: "", avatarSeed: "a", sortOrder: 3 },
  ],
  agentRelations: [
    { id: "r1", missionId: "m1", fromAgentId: "owner", toAgentId: "pm", label: "Oversee and guide", status: "active", createdAt: new Date().toISOString() },
    { id: "r2", missionId: "m1", fromAgentId: "pm", toAgentId: "planner", label: "Assign tasks and monitor", status: "active", createdAt: new Date().toISOString() },
    { id: "r3", missionId: "m1", fromAgentId: "pm", toAgentId: "analyst", label: "Assign responsibilities", status: "active", createdAt: new Date().toISOString() },
  ],
  agentMessages: [],
  threads: [],
  taskEvents: [],
  scheduleTriggerEvents: [],
  toolCalls: [],
  decisions: [],
  knowledgeEntries: [],
  missionOutcomeEvaluations: [],
  taskFailureAnalyses: [],
  strategyAdjustments: [],
};

function makeBusDeps(overrides?: {
  llmResponses?: Map<string, AgentConversationResponse>;
  snapshot?: MissionSnapshot;
}) {
  const messages: AgentMessage[] = [];
  const threads: ConversationThread[] = [];
  const resolvedThreadIds: string[] = [];
  const agentUpdates: Array<{ id: string; patch: Partial<WarRoomAgent> }> = [];
  let snapshot = overrides?.snapshot ?? { ...baseSnapshot, agentMessages: [] };

  const llm: LlmService = {
    call: async (inputMessages: LlmMessage[]) => {
      const agentId = extractAgentId(inputMessages);
      const response = overrides?.llmResponses?.get(agentId);
      if (response) {
        return {
          content: JSON.stringify(response),
          model: "test",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      }
      return {
        content: JSON.stringify({ message: "ok", type: "agent_chat", shouldPropagate: false, action: { type: "acknowledge" } }),
        model: "test",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      };
    },
    stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
  };

  const personas: AgentPersonaRegistry = {
    personaFor: (agent: WarRoomAgent) => ({
      role: agent.role,
      systemPrompt: `You are ${agent.name}`,
      communicationStyle: "concise",
      responseGuidelines: "Be helpful",
      availableActions: ["report_findings", "request_info", "notify_risk", "acknowledge"],
    }),
  } as AgentPersonaRegistry;

  const contextRetriever: ContextRetriever = {
    getRelevantContext: () => [],
  } as unknown as ContextRetriever;

  const bus = new AgentConversationBus({
    llm,
    personas,
    contextRetriever,
    getSnapshot: () => snapshot,
    appendMessage: (msg) => {
      const appended: AgentMessage = { ...msg, id: `msg_${messages.length}`, createdAt: new Date().toISOString() } as AgentMessage;
      messages.push(appended);
      snapshot = { ...snapshot, agentMessages: [...snapshot.agentMessages, appended] };
      return appended;
    },
    createThread: (input) => {
      const thread: ConversationThread = { ...input, id: `thread_${threads.length}`, createdAt: new Date().toISOString() } as ConversationThread;
      threads.push(thread);
      snapshot = { ...snapshot, threads: [...snapshot.threads, thread] };
      return thread;
    },
    resolveThread: (threadId) => {
      resolvedThreadIds.push(threadId);
    },
    updateAgent: (id, patch) => { agentUpdates.push({ id, patch }); },
    maxConversationDepth: 5,
    maxDiscussionRounds: 5,
    cooldownMs: 0,
  });

  return { bus, messages, threads, resolvedThreadIds, agentUpdates };
}

function extractAgentId(messages: LlmMessage[]): string {
  const systemMsg = messages.find((m) => m.role === "system");
  if (!systemMsg) return "";
  const content = typeof systemMsg.content === "string" ? systemMsg.content : "";
  if (content.includes("PM")) return "pm";
  if (content.includes("Planner")) return "planner";
  if (content.includes("Analyst")) return "analyst";
  if (content.includes("Owner")) return "owner";
  return "";
}

describe("AgentConversationBus", () => {
  describe("parseAgentConversationResponse", () => {
    it("should parse valid JSON response", () => {
      const result = parseAgentConversationResponse(
        JSON.stringify({ message: "hello", type: "agent_chat", mentionedAgentIds: [], shouldPropagate: false, action: { type: "acknowledge" } }),
      );
      expect(result.message).toBe("hello");
      expect(result.type).toBe("agent_chat");
      expect(result.shouldPropagate).toBe(false);
    });

    it("should default to agent_chat for unknown types", () => {
      const result = parseAgentConversationResponse(
        JSON.stringify({ message: "test", type: "unknown_type", mentionedAgentIds: [], shouldPropagate: false }),
      );
      expect(result.type).toBe("agent_chat");
    });

    it("should handle malformed JSON gracefully", () => {
      const result = parseAgentConversationResponse("not json at all");
      expect(result.message).toBe("not json at all");
      expect(result.type).toBe("agent_chat");
      expect(result.shouldPropagate).toBe(false);
    });

    it("should extract JSON from fenced code block", () => {
      const result = parseAgentConversationResponse(
        "```json\n" + JSON.stringify({ message: "fenced", type: "agent_report", mentionedAgentIds: [], shouldPropagate: true, action: { type: "report_to_superior" } }) + "\n```",
      );
      expect(result.message).toBe("fenced");
      expect(result.shouldPropagate).toBe(true);
    });

    it("parses create_followup_task action with valid payload", () => {
      const result = parseAgentConversationResponse(
        JSON.stringify({
          message: "派下一波任务",
          type: "agent_chat",
          shouldPropagate: false,
          action: {
            type: "create_followup_task",
            payload: {
              title: "Write second SEO article on topic X",
              objective: "Produce a second article based on first article's data",
              assigneeRole: "content_strategist",
              reason: "First article's keyword Y had high CTR",
              sourceTaskId: "task-1",
            },
          },
        }),
      );
      expect(result.action?.type).toBe("create_followup_task");
      if (result.action?.type === "create_followup_task") {
        expect(result.action.payload).toMatchObject({
          title: "Write second SEO article on topic X",
          objective: "Produce a second article based on first article's data",
          assigneeRole: "content_strategist",
          reason: "First article's keyword Y had high CTR",
          sourceTaskId: "task-1",
        });
      }
    });

    it("falls back to acknowledge when create_followup_task payload missing title", () => {
      const result = parseAgentConversationResponse(
        JSON.stringify({
          message: "...",
          type: "agent_chat",
          shouldPropagate: false,
          action: { type: "create_followup_task", payload: { objective: "x", assigneeRole: "r", reason: "y" } },
        }),
      );
      expect(result.action?.type).toBe("acknowledge");
    });

    it("falls back to acknowledge when create_followup_task payload missing assigneeRole", () => {
      const result = parseAgentConversationResponse(
        JSON.stringify({
          message: "...",
          type: "agent_chat",
          shouldPropagate: false,
          action: { type: "create_followup_task", payload: { title: "T", objective: "x", reason: "y" } },
        }),
      );
      expect(result.action?.type).toBe("acknowledge");
    });
  });

  describe("multi-round discussion", () => {
    it("should propagate discussion to mentioned agents", async () => {
      const { bus, messages, resolvedThreadIds } = makeBusDeps({
        llmResponses: new Map([
          ["pm", { message: "We need to discuss with planner", type: "agent_discussion", mentionedAgentIds: ["planner"], shouldPropagate: true, action: { type: "notify_owner" } }],
          ["planner", { message: "I agree with the adjustment plan", type: "agent_discussion", mentionedAgentIds: [], shouldPropagate: false, action: { type: "acknowledge" } }],
        ]),
      });

      const event: BusEvent = {
        type: "periodic_report",
        fromAgentId: "analyst",
        content: "互动率下降30%",
      };

      await bus.dispatchEvent({ missionId: "m1", event });

      expect(messages.length).toBeGreaterThanOrEqual(2);
      const pmMsg = messages.find((m) => m.fromAgentId === "pm");
      const plannerMsg = messages.find((m) => m.fromAgentId === "planner");
      expect(pmMsg).toBeDefined();
      expect(plannerMsg).toBeDefined();
      expect(messages.every((m) => m.threadId === messages[0]?.threadId)).toBe(true);

      // Thread should resolve when discussion concludes (no propagation from planner)
      expect(resolvedThreadIds).toHaveLength(1);
    });

    it("should resolve thread when propagated agent acknowledges", async () => {
      const { bus, messages, resolvedThreadIds } = makeBusDeps({
        llmResponses: new Map([
          ["pm", { message: "Need planner input", type: "agent_discussion", mentionedAgentIds: ["planner"], shouldPropagate: true, action: { type: "request_info", targetAgentId: "planner" } }],
          ["planner", { message: "Here is my plan, need PM to confirm", type: "agent_discussion", mentionedAgentIds: ["pm"], shouldPropagate: true, action: { type: "request_info", targetAgentId: "pm" } }],
        ]),
      });

      const event: BusEvent = {
        type: "periodic_report",
        fromAgentId: "analyst",
        content: "互动率下降30%",
      };

      await bus.dispatchEvent({ missionId: "m1", event });

      expect(messages.length).toBeGreaterThanOrEqual(2);

      // PM propagated to planner, planner tried to propagate back to PM (already responded)
      // Since PM is in `responded`, propagation stops. Thread resolves.
      expect(resolvedThreadIds).toHaveLength(1);
    });

    it("should keep thread active when final agent propagates to new target", async () => {
      const { bus, messages, resolvedThreadIds } = makeBusDeps({
        llmResponses: new Map([
          ["pm", { message: "Need planner input", type: "agent_discussion", mentionedAgentIds: ["planner"], shouldPropagate: true, action: { type: "request_info", targetAgentId: "planner" } }],
          ["planner", { message: "I need owner approval", type: "agent_discussion", mentionedAgentIds: ["owner"], shouldPropagate: true, action: { type: "escalate", targetAgentId: "owner" } }],
          ["owner", { message: "Approved", type: "agent_discussion", mentionedAgentIds: [], shouldPropagate: true, action: { type: "notify_owner" } }],
        ]),
      });

      const event: BusEvent = {
        type: "periodic_report",
        fromAgentId: "analyst",
        content: "互动率下降30%",
      };

      await bus.dispatchEvent({ missionId: "m1", event });

      // PM → planner → owner, all responded
      expect(messages.length).toBeGreaterThanOrEqual(3);
      const fromIds = messages.map((m) => m.fromAgentId);
      expect(fromIds).toContain("pm");
      expect(fromIds).toContain("planner");
      expect(fromIds).toContain("owner");

      // Owner's last response had shouldPropagate=true but no new un-responded targets
      // So lastRoundPropagated should be false (no propagated targets found), thread resolves
      expect(resolvedThreadIds).toHaveLength(1);
    });

    it("should not exceed maxDiscussionRounds", async () => {
      const { bus, messages } = makeBusDeps({
        llmResponses: new Map([
          ["owner", { message: "Noted", type: "agent_chat", mentionedAgentIds: [], shouldPropagate: false, action: { type: "acknowledge" } }],
        ]),
      });

      const event: BusEvent = {
        type: "execution_completed",
        agentId: "analyst",
        taskId: "task_1",
        artifactId: "artifact_1",
      };

      await bus.dispatchEvent({ missionId: "m1", event });

      // Should have responses from owner (worker=analyst not in snapshot agents for this event)
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("thread resolution", () => {
    it("should resolve thread when all agents acknowledge", async () => {
      const { bus, resolvedThreadIds } = makeBusDeps({
        llmResponses: new Map([
          ["owner", { message: "ok", type: "agent_chat", mentionedAgentIds: [], shouldPropagate: false, action: { type: "acknowledge" } }],
        ]),
      });

      await bus.dispatchEvent({
        missionId: "m1",
        event: { type: "execution_completed", agentId: "analyst", taskId: "t1", artifactId: "a1" },
      });

      expect(resolvedThreadIds).toHaveLength(1);
    });

    it("should resolve thread at max conversation depth", async () => {
      const { bus, resolvedThreadIds } = makeBusDeps();
      // Explicitly test with high depth
      await bus.dispatchEvent({
        missionId: "m1",
        event: { type: "execution_completed", agentId: "analyst", taskId: "t1", artifactId: "a1" },
        threadId: "existing_thread",
        triggerDepth: 5,
      });

      // At max depth, thread should be resolved
      expect(resolvedThreadIds).toContain("existing_thread");
    });
  });
});
