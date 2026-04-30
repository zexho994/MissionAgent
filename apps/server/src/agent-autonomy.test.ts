import { describe, it, expect, beforeEach } from "vitest";
import { AgentAutonomyService, type AgentAutonomyDeps, type TimerHandle } from "./agent-autonomy.js";
import type { LlmService } from "@digitalagent/runtime";
import type { AgentPersonaRegistry } from "./agent-personas.js";
import type { ContextRetriever } from "./context-retriever.js";
import type { BusEvent, ConversationThread } from "./agent-conversation-types.js";
import type { AgentMessage, MissionSnapshot, WarRoomAgent } from "./mission-service.js";

function makeTestDeps(): {
  deps: AgentAutonomyDeps;
  dispatchedEvents: BusEvent[];
  appendedMessages: Omit<AgentMessage, "id" | "createdAt">[];
  agentUpdates: Array<{ id: string; patch: Partial<WarRoomAgent> }>;
} {
  const dispatchedEvents: BusEvent[] = [];
  const appendedMessages: Omit<AgentMessage, "id" | "createdAt">[] = [];
  const agentUpdates: Array<{ id: string; patch: Partial<WarRoomAgent> }> = [];

  let callCount = 0;
  const llm: LlmService = {
    call: async () => {
      callCount += 1;
      return {
        content: JSON.stringify({
          message: "Nothing to report",
          type: "agent_report",
          mentionedAgentIds: [],
          shouldPropagate: false,
          action: { type: "acknowledge" },
        }),
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

  const snapshot: MissionSnapshot = {
    missions: [{ id: "mission_1", goal: "test", successMetrics: [], constraints: [], status: "active", budget: { maxRuntimeMinutes: 60 }, createdAt: new Date(), scheduleRules: [] }],
    tasks: [],
    artifacts: [],
    reviews: [],
    executions: [],
    agents: [
      { id: "owner_1", missionId: "mission_1", role: "owner", name: "Owner", responsibility: "oversee", status: "idle", currentTaskId: undefined, lastAction: "", avatarSeed: "o", sortOrder: 0 },
      { id: "agent_1", missionId: "mission_1", role: "data_analyst", name: "Analyst", responsibility: "analyze data", status: "idle", currentTaskId: undefined, lastAction: "", avatarSeed: "a", sortOrder: 1 },
      { id: "agent_2", missionId: "mission_1", role: "writer", name: "Writer", responsibility: "write content", status: "idle", currentTaskId: undefined, lastAction: "", avatarSeed: "w", sortOrder: 2 },
    ],
    agentRelations: [
      { id: "rel_1", missionId: "mission_1", fromAgentId: "owner_1", toAgentId: "agent_1", label: "Oversee and guide", status: "active", createdAt: new Date().toISOString() },
    ],
    agentMessages: [],
    threads: [],
    taskEvents: [],
    scheduleTriggerEvents: [],
    toolCalls: [],
    decisions: [],
    knowledgeEntries: [],
  };

  const deps: AgentAutonomyDeps = {
    config: {
      tickIntervalMs: 60_000,
      maxConcurrentEvals: 3,
      reportFrequencyTicks: 2,
    },
    llm,
    personas,
    contextRetriever,
    getSnapshot: () => snapshot,
    dispatchEvent: async (input) => { dispatchedEvents.push(input.event); },
    appendMessage: (msg) => {
      appendedMessages.push(msg);
      return { ...msg, id: "msg_1", createdAt: new Date().toISOString() } as AgentMessage;
    },
    updateAgent: (id, patch) => { agentUpdates.push({ id, patch }); },
    maxConversationDepth: 5,
  };

  return { deps, dispatchedEvents, appendedMessages, agentUpdates };
}

describe("AgentAutonomyService", () => {
  it("should start and stop a loop", () => {
    const { deps } = makeTestDeps();
    const service = new AgentAutonomyService(deps);

    service.startLoop("mission_1");
    expect(service.isRunning("mission_1")).toBe(true);

    service.stopLoop("mission_1");
    expect(service.isRunning("mission_1")).toBe(false);
  });

  it("should not start duplicate loops for same mission", () => {
    const { deps } = makeTestDeps();
    const service = new AgentAutonomyService(deps);

    service.startLoop("mission_1");
    service.startLoop("mission_1");

    expect(service.isRunning("mission_1")).toBe(true);
    service.stopLoop("mission_1");
  });

  it("should stop all loops", () => {
    const { deps } = makeTestDeps();
    const service = new AgentAutonomyService(deps);

    service.startLoop("mission_1");
    service.startLoop("mission_2");
    service.stopAll();

    expect(service.isRunning("mission_1")).toBe(false);
    expect(service.isRunning("mission_2")).toBe(false);
  });

  it("should evaluate agents on manual tick", async () => {
    const { deps, agentUpdates } = makeTestDeps();
    let tickCallback: (() => Promise<void>) | undefined;
    const timer = {
      setInterval: (cb: () => void, _ms: number) => {
        tickCallback = cb as () => Promise<void>;
        return { clear: () => {} };
      },
    };
    const service = new AgentAutonomyService(deps, timer);

    service.startLoop("mission_1");
    expect(tickCallback).toBeDefined();
    await tickCallback!();

    const thinkingUpdates = agentUpdates.filter((u) => u.patch.status === "thinking");
    const idleUpdates = agentUpdates.filter((u) => u.patch.status === "idle");
    expect(thinkingUpdates.length).toBeGreaterThan(0);
    expect(idleUpdates.length).toBeGreaterThan(0);
  });

  it("should dispatch periodic_report when agent reports on report tick", async () => {
    const { deps, dispatchedEvents } = makeTestDeps();

    deps.llm = {
      call: async () => ({
        content: JSON.stringify({
          message: "Daily metrics: engagement up 15%",
          type: "agent_report",
          mentionedAgentIds: [],
          shouldPropagate: true,
          action: { type: "report_to_superior" },
        }),
        model: "test",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      }),
      stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
    };

    let tickCallback: (() => Promise<void>) | undefined;
    const timer = {
      setInterval: (cb: () => void, _ms: number) => {
        tickCallback = cb as () => Promise<void>;
        return { clear: () => {} };
      },
    };
    const service = new AgentAutonomyService(deps, timer);

    service.startLoop("mission_1");

    await tickCallback!();
    expect(dispatchedEvents).toHaveLength(0);

    await tickCallback!();
    expect(dispatchedEvents.length).toBeGreaterThan(0);
    expect(dispatchedEvents[0]?.type).toBe("periodic_report");
  });

  it("should evaluate all non-owner, non-hr agents", async () => {
    const { deps, agentUpdates } = makeTestDeps();

    let llmCalls = 0;
    deps.llm = {
      call: async () => {
        llmCalls += 1;
        return {
          content: JSON.stringify({ message: "ok", type: "agent_chat", shouldPropagate: false, action: { type: "acknowledge" } }),
          model: "test",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      },
      stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
    };

    let tickCallback: (() => Promise<void>) | undefined;
    const timer = {
      setInterval: (cb: () => void, _ms: number) => {
        tickCallback = cb as () => Promise<void>;
        return { clear: () => {} };
      },
    };
    const service = new AgentAutonomyService(deps, timer);

    service.startLoop("mission_1");
    await tickCallback!();

    expect(llmCalls).toBeGreaterThanOrEqual(1);

    const evaluatedIds = agentUpdates
      .filter((u) => u.patch.lastAction === "Completed self-evaluation")
      .map((u) => u.id);
    expect(evaluatedIds.length).toBeGreaterThanOrEqual(1);
    expect(evaluatedIds).not.toContain("owner_1");
  });

  it("should auto-stop loop when mission is completed", async () => {
    const { deps } = makeTestDeps();

    let tickCallback: (() => Promise<void>) | undefined;
    const timer = {
      setInterval: (cb: () => void, _ms: number) => {
        tickCallback = cb as () => Promise<void>;
        return { clear: () => {} };
      },
    };
    const service = new AgentAutonomyService(deps, timer);

    service.startLoop("mission_1");

    const snapshot = deps.getSnapshot();
    snapshot.missions[0] = { ...snapshot.missions[0]!, status: "completed" };

    await tickCallback!();

    expect(service.isRunning("mission_1")).toBe(false);
  });

  it("should skip agent on non-report tick when no new activity", async () => {
    const { deps } = makeTestDeps();
    deps.config.reportFrequencyTicks = 10;

    let llmCalls = 0;
    deps.llm = {
      call: async () => {
        llmCalls += 1;
        return {
          content: JSON.stringify({ message: "nothing new", type: "agent_chat", shouldPropagate: false, action: { type: "acknowledge" } }),
          model: "test",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      },
      stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
    };

    let tickCallback: (() => Promise<void>) | undefined;
    const timer = {
      setInterval: (cb: () => void, _ms: number) => {
        tickCallback = cb as () => Promise<void>;
        return { clear: () => {} };
      },
    };
    const service = new AgentAutonomyService(deps, timer);

    service.startLoop("mission_1");

    // Tick 1: agents evaluated (no prior activity count)
    await tickCallback!();
    const callsAfterFirstTick = llmCalls;
    expect(callsAfterFirstTick).toBeGreaterThan(0);

    // Tick 2: non-report tick, no new messages/artifacts → agents skipped
    await tickCallback!();
    expect(llmCalls).toBe(callsAfterFirstTick);
  });

  it("should evaluate agent on non-report tick when new activity exists", async () => {
    const { deps, appendedMessages } = makeTestDeps();
    deps.config.reportFrequencyTicks = 10;

    let llmCalls = 0;
    deps.llm = {
      call: async () => {
        llmCalls += 1;
        return {
          content: JSON.stringify({ message: "seen new activity", type: "agent_chat", shouldPropagate: false, action: { type: "acknowledge" } }),
          model: "test",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      },
      stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
    };

    let tickCallback: (() => Promise<void>) | undefined;
    const timer = {
      setInterval: (cb: () => void, _ms: number) => {
        tickCallback = cb as () => Promise<void>;
        return { clear: () => {} };
      },
    };
    const service = new AgentAutonomyService(deps, timer);

    service.startLoop("mission_1");

    // Tick 1: establishes baseline activity count
    await tickCallback!();
    const callsAfterFirstTick = llmCalls;
    expect(callsAfterFirstTick).toBeGreaterThan(0);

    // Simulate new activity: a message mentioning agent_1
    const snapshot = deps.getSnapshot();
    const prevMessages = snapshot.agentMessages;
    snapshot.agentMessages = [
      ...prevMessages,
      { id: "msg_new", missionId: "mission_1", fromAgentId: "owner_1", type: "agent_notify", content: "new data", mentionedAgentIds: ["agent_1"], createdAt: new Date().toISOString() } as any,
    ];

    // Tick 2: non-report tick, but agent_1 has new activity → should be evaluated
    await tickCallback!();
    expect(llmCalls).toBeGreaterThan(callsAfterFirstTick);
  });
});
