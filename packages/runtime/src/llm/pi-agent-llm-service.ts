import type { AgentTool } from "@earendil-works/pi-agent-core";
import { runPiAgent, type PiAgentLike, type PiAgentConfig, type PiAgentMessage } from "../pi-agent-runner.js";
import type { LlmService } from "./llm-service.js";
import type { LlmCallStats, LlmMessage } from "./types.js";

export interface CreatePiAgentLlmServiceOptions {
  apiKey: string;
  modelProvider?: string;
  modelId?: string;
  tools: AgentTool<any>[];
  timeoutSeconds?: number;
  agentFactory?: (config: PiAgentConfig) => PiAgentLike;
}

export function createPiAgentLlmService(options: CreatePiAgentLlmServiceOptions): LlmService {
  if (!options.apiKey) {
    throw new Error("LLM API key is required");
  }

  let stats: LlmCallStats = {
    totalCalls: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
  };

  return {
    async call(messages, callOptions) {
      const prepared = preparePiAgentMessages(messages);
      const timeoutSeconds = callOptions?.timeoutMs !== undefined
        ? Math.ceil(callOptions.timeoutMs / 1000)
        : options.timeoutSeconds ?? 90;
      const result = await runPiAgent({
        apiKey: options.apiKey,
        modelProvider: options.modelProvider,
        modelId: callOptions?.model ?? options.modelId,
        systemPrompt: prepared.systemPrompt,
        messages: prepared.messages,
        prompt: prepared.prompt,
        tools: options.tools,
        timeoutSeconds,
        ...(options.agentFactory ? { agentFactory: options.agentFactory } : {}),
      });

      const content = extractLastAssistantText(result.messages);
      if (!content.trim()) {
        throw new Error("PiAgentLlmService returned no assistant content");
      }
      callOptions?.onStream?.(content);

      const promptTokens = messages.reduce((sum, message) => sum + message.content.length, 0);
      const completionTokens = content.length;
      stats = {
        totalCalls: stats.totalCalls + 1,
        totalPromptTokens: stats.totalPromptTokens + promptTokens,
        totalCompletionTokens: stats.totalCompletionTokens + completionTokens,
        lastCallAt: new Date().toISOString(),
      };

      return {
        content,
        model: callOptions?.model ?? options.modelId ?? "MiniMax-M2.7-highspeed",
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        finishReason: "stop",
      };
    },
    stats() {
      return stats;
    },
  };
}

function preparePiAgentMessages(messages: LlmMessage[]): { systemPrompt: string; messages: PiAgentMessage[]; prompt: string } {
  const systemParts: string[] = [];
  const conversational: PiAgentMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else if (message.role === "assistant") {
      conversational.push({ role: "assistant", content: [{ type: "text", text: message.content }] });
    } else {
      conversational.push({ role: "user", content: message.content });
    }
  }

  const last = conversational.at(-1);
  if (!last || last.role !== "user" || typeof last.content !== "string") {
    throw new Error("PiAgentLlmService requires a user message");
  }

  return {
    systemPrompt: systemParts.join("\n\n"),
    messages: conversational.slice(0, -1),
    prompt: last.content,
  };
}

function extractLastAssistantText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
        .join("");
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}