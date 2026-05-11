import type { LlmMessage, LlmService } from "@digitalagent/runtime";
import type { AgentPersonaRegistry } from "./agent-personas.js";
import type { ContextRetriever } from "./context-retriever.js";
import type { BusEvent, ConversationThread, CreateFollowupTaskPayload } from "./agent-conversation-types.js";
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
  createFollowupTask?: (input: {
    missionId: string;
    triggeringEventId: string;
    payload: CreateFollowupTaskPayload;
  }) => Promise<
    | { created: true; taskId: string }
    | { created: false; reason: string; escalateMessageSent?: boolean }
  >;
}

export class AgentAutonomyService {
  private readonly loops = new Map<string, TimerHandle>();
  private readonly tickCounts = new Map<string, number>();
  private readonly tickingMissions = new Set<string>();
  private readonly lastActivityCount = new Map<string, number>();
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
      if (this.tickingMissions.has(missionId)) return;
      this.tickingMissions.add(missionId);
      return this.tick(missionId).finally(() => { this.tickingMissions.delete(missionId); });
    }, this.deps.config.tickIntervalMs);
    this.loops.set(missionId, handle);
  }

  stopLoop(missionId: string): void {
    const handle = this.loops.get(missionId);
    if (handle) {
      handle.clear();
      this.loops.delete(missionId);
      this.tickCounts.delete(missionId);
      this.tickingMissions.delete(missionId);
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
      const isReportTick = tickCount % this.deps.config.reportFrequencyTicks === 0;
      if (!isReportTick && !this.hasNewActivity(snapshot, missionId, agent.id)) {
        continue;
      }
      await this.evaluateAgent(missionId, agent, tickCount);
    }
  }

  private hasNewActivity(snapshot: MissionSnapshot, missionId: string, agentId: string): boolean {
    if (!this.lastActivityCount.has(agentId)) return true;
    const missionTaskIds = new Set(
      snapshot.tasks.filter((t) => t.missionId === missionId).map((t) => t.id),
    );
    const missionArtifactCount = snapshot.artifacts.filter((a) => missionTaskIds.has(a.taskId)).length;
    const relevantMessageCount = snapshot.agentMessages.filter(
      (m) => m.fromAgentId === agentId || m.mentionedAgentIds?.includes(agentId),
    ).length + missionArtifactCount;
    return relevantMessageCount > (this.lastActivityCount.get(agentId) ?? 0);
  }

  private recordActivity(snapshot: MissionSnapshot, missionId: string, agentId: string): void {
    const missionTaskIds = new Set(
      snapshot.tasks.filter((t) => t.missionId === missionId).map((t) => t.id),
    );
    const missionArtifactCount = snapshot.artifacts.filter((a) => missionTaskIds.has(a.taskId)).length;
    const count = snapshot.agentMessages.filter(
      (m) => m.fromAgentId === agentId || m.mentionedAgentIds?.includes(agentId),
    ).length + missionArtifactCount;
    this.lastActivityCount.set(agentId, count);
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
            "Given your current context and role, should you communicate? If you have findings to report, use report_to_superior action. If you need information, use request_info. If `create_followup_task` is in your available actions AND the recent activity indicates the mission needs the next concrete work step (e.g., a task completed and the next substantive work is clear), you MAY return: {\"action\":{\"type\":\"create_followup_task\",\"payload\":{\"title\":\"<short task name>\",\"objective\":\"<one-sentence what to deliver>\",\"assigneeRole\":\"<role from team>\",\"reason\":\"<why this is the right next step>\"}}}. If nothing to communicate, respond with acknowledge.",
            "",
            "Respond with one JSON object only: {\"message\":\"...\",\"type\":\"agent_report|agent_chat|agent_request|agent_notify\",\"mentionedAgentIds\":[],\"shouldPropagate\":false,\"action\":{...}}",
          ].join("\n"),
        },
      ];

      const result = await this.deps.llm.call(messages, { temperature: 0.3 });
      const response = parseAgentConversationResponse(result.content);

      if (response.action?.type === "create_followup_task" && this.deps.createFollowupTask) {
        const triggeringEventId = `autonomy:${missionId}:${agent.id}:${tickCount}`;
        try {
          await this.deps.createFollowupTask({
            missionId,
            triggeringEventId,
            payload: response.action.payload,
          });
        } catch (error) {
          console.error(
            "[AgentAutonomyService] createFollowupTask failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      } else if (response.action?.type === "report_to_superior" && tickCount % this.deps.config.reportFrequencyTicks === 0) {
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
      this.recordActivity(this.deps.getSnapshot(), missionId, agent.id);
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
