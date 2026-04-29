import type { LlmMessage, LlmService } from "@digitalagent/runtime";
import type { AgentPersonaRegistry } from "./agent-personas.js";
import type { ContextRetriever } from "./context-retriever.js";
import type { BusEvent, ConversationThread } from "./agent-conversation-types.js";
import type { AgentMessage, MissionSnapshot, WarRoomAgent } from "./mission-service.js";
import { parseAgentConversationResponse } from "./agent-conversation-bus.js";

export interface AgentAutonomyConfig {
  tickIntervalMs: number;
  maxConcurrentEvals: number;
  reportFrequencyTicks: number;
}

export interface TimerHandle {
  clear(): void;
}

export interface AgentAutonomyDeps {
  config: AgentAutonomyConfig;
  llm: LlmService;
  personas: AgentPersonaRegistry;
  contextRetriever: ContextRetriever;
  getSnapshot: () => MissionSnapshot;
  dispatchEvent: (input: { missionId: string; event: BusEvent }) => Promise<void>;
  appendMessage: (message: Omit<AgentMessage, "id" | "createdAt">) => AgentMessage;
  updateAgent: (id: string, patch: Partial<WarRoomAgent>) => void;
  maxConversationDepth: number;
}

export class AgentAutonomyService {
  private readonly loops = new Map<string, TimerHandle>();
  private readonly tickCounts = new Map<string, number>();
  private activeEvals = 0;

  constructor(
    private readonly deps: AgentAutonomyDeps,
    private readonly timer: {
      setInterval: (callback: () => void, ms: number) => TimerHandle;
    } = {
      setInterval: (cb, ms) => ({ clear: () => clearInterval(setInterval(cb, ms)) }),
    },
  ) {}

  startLoop(missionId: string): void {
    if (this.loops.has(missionId)) return;

    this.tickCounts.set(missionId, 0);
    const handle = this.timer.setInterval(() => {
      void this.tick(missionId);
    }, this.deps.config.tickIntervalMs);
    this.loops.set(missionId, handle);
  }

  stopLoop(missionId: string): void {
    const handle = this.loops.get(missionId);
    if (handle) {
      handle.clear();
      this.loops.delete(missionId);
      this.tickCounts.delete(missionId);
    }
  }

  stopAll(): void {
    for (const missionId of [...this.loops.keys()]) {
      this.stopLoop(missionId);
    }
  }

  isRunning(missionId: string): boolean {
    return this.loops.has(missionId);
  }

  getTickCount(missionId: string): number {
    return this.tickCounts.get(missionId) ?? 0;
  }

  private async tick(missionId: string): Promise<void> {
    const snapshot = this.deps.getSnapshot();
    const mission = snapshot.missions.find((m) => m.id === missionId);
    if (!mission || mission.status === "completed" || mission.status === "cancelled") {
      this.stopLoop(missionId);
      return;
    }

    const tickCount = (this.tickCounts.get(missionId) ?? 0) + 1;
    this.tickCounts.set(missionId, tickCount);

    const agents = snapshot.agents.filter(
      (a) => a.missionId === missionId && a.role !== "owner" && a.role !== "hr" && a.status !== "blocked" && a.status !== "done",
    );

    for (const agent of agents) {
      if (this.activeEvals >= this.deps.config.maxConcurrentEvals) break;
      await this.evaluateAgent(missionId, agent, tickCount);
    }
  }

  private async evaluateAgent(missionId: string, agent: WarRoomAgent, tickCount: number): Promise<void> {
    this.activeEvals += 1;
    this.deps.updateAgent(agent.id, {
      status: "thinking",
      lastAction: "Evaluating whether to communicate",
    });

    try {
      const persona = this.deps.personas.personaFor(agent);
      const context = this.deps.contextRetriever.getRelevantContext({
        missionId,
        agentId: agent.id,
        currentTopic: "Periodic self-evaluation",
      });

      const recentMessages = this.deps.getSnapshot().agentMessages
        .filter((m) => m.missionId === missionId && m.fromAgentId === agent.id)
        .slice(-3)
        .map((m) => m.content)
        .join("; ");

      const snapshot = this.deps.getSnapshot();
      const mission = snapshot.missions.find((m) => m.id === missionId);

      const messages: LlmMessage[] = [
        {
          role: "system",
          content: [
            persona.systemPrompt,
            `Communication style: ${persona.communicationStyle}`,
            `You are performing a periodic self-evaluation.`,
            `Mission goal: ${mission?.goal ?? "unknown"}`,
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Context: ${JSON.stringify(context)}`,
            `Your recent messages: ${recentMessages || "(none)"}`,
            "",
            "Given your current context and role, should you communicate? If you have findings to report, use report_to_superior action. If you need information, use request_info. If nothing to communicate, respond with acknowledge.",
            "",
            "Respond with one JSON object only: {\"message\":\"...\",\"type\":\"agent_report|agent_chat|agent_request|agent_notify\",\"mentionedAgentIds\":[],\"shouldPropagate\":false,\"action\":{\"type\":\"acknowledge|report_to_superior|request_info|notify_owner|escalate\"}}",
          ].join("\n"),
        },
      ];

      const result = await this.deps.llm.call(messages, { temperature: 0.3 });
      const response = parseAgentConversationResponse(result.content);

      if (response.action?.type === "report_to_superior" && tickCount % this.deps.config.reportFrequencyTicks === 0) {
        await this.deps.dispatchEvent({
          missionId,
          event: {
            type: "periodic_report",
            fromAgentId: agent.id,
            content: response.message,
          },
        });
      } else if (response.shouldPropagate && response.action?.type !== "acknowledge") {
        const messageInput: Omit<AgentMessage, "id" | "createdAt"> = {
          missionId,
          fromAgentId: agent.id,
          type: response.type,
          content: response.message,
        };
        if (response.mentionedAgentIds?.length) {
          messageInput.mentionedAgentIds = response.mentionedAgentIds;
        }
        this.deps.appendMessage(messageInput);
      }

      this.deps.updateAgent(agent.id, {
        status: "idle",
        lastAction: "Completed self-evaluation",
      });
    } catch (error) {
      this.deps.updateAgent(agent.id, {
        status: "idle",
        lastAction: `Self-evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.activeEvals -= 1;
    }
  }
}
