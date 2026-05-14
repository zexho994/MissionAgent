import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Source } from "@digitalagent/core";
import { runPiAgent, type PiAgentConfig, type PiAgentLike } from "./pi-agent-runner.js";

export interface PiSdkAdapterOptions {
  apiKey: string;
  modelProvider?: string;
  modelId?: string;
  tools?: AgentTool<any>[];
  agentFactory?: (config: AgentConfig) => AgentLike;
}

export type AgentConfig = PiAgentConfig;
export type AgentLike = PiAgentLike;

export interface RunAgentTaskInput {
  message: string;
  timeoutSeconds: number;
  systemPrompt?: string;
  sessionId?: string;
}

export interface RunAgentTaskResult {
  status: "completed" | "failed";
  output: unknown;
  stderr: string;
  sources: Source[];
  error?: string;
}

export interface PiHealth {
  available: boolean;
  version?: string;
  error?: string;
}

export class PiSdkAdapter {
  private readonly apiKey: string;
  private readonly modelProvider: string;
  private readonly modelId: string;
  private readonly tools: AgentTool<any>[];
  private readonly agentFactory: (config: AgentConfig) => AgentLike;

  constructor(options: PiSdkAdapterOptions) {
    this.apiKey = options.apiKey;
    this.modelProvider = options.modelProvider ?? "minimax-cn";
    this.modelId = options.modelId ?? "MiniMax-M2.7-highspeed";
    this.tools = options.tools ?? [];
    this.agentFactory =
      options.agentFactory ??
      ((config) => new Agent(config as never) as unknown as AgentLike);
  }

  async health(): Promise<PiHealth> {
    return {
      available: true,
      version: "pi-agent-core-sdk-0.74.0",
    };
  }

  async runAgentTask(input: RunAgentTaskInput): Promise<RunAgentTaskResult> {
    const sources: Source[] = [];

    try {
      const result = await runPiAgent({
        apiKey: this.apiKey,
        modelProvider: this.modelProvider,
        modelId: this.modelId,
        systemPrompt: input.systemPrompt ?? "",
        messages: [],
        prompt: input.message,
        tools: this.tools,
        timeoutSeconds: input.timeoutSeconds,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        traceLabel: inferRuntimeTraceLabel(input.systemPrompt),
        onEvent: (event) => collectSourcesFromEvent(event, sources),
        agentFactory: this.agentFactory,
      });
      return {
        status: "completed",
        output: { messages: result.messages },
        stderr: "",
        sources,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        output: { messages: [], error: message },
        stderr: message,
        sources,
        error: message,
      };
    }
  }
}

function inferRuntimeTraceLabel(systemPrompt?: string): string {
  if (!systemPrompt?.trim()) return "RuntimeAgent";
  const firstLine = systemPrompt.trim().split(/\r?\n/)[0]?.trim();
  if (!firstLine) return "RuntimeAgent";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function collectSourcesFromEvent(event: AgentEvent, sources: Source[]): void {
  if (event.type !== "tool_execution_end") return;
  const anyEvent = event as Record<string, unknown>;
  const result = anyEvent.result as Record<string, unknown> | undefined;
  if (!result || result.ok === false) return;
  const toolName = anyEvent.toolName as string | undefined;
  if (toolName !== "web_search") return;
  const details = result.details as Record<string, unknown> | undefined;
  if (!details) return;
  const rawResults = details.results as Array<Record<string, unknown>> | undefined;
  const fallbackResults = details.sources as Array<Record<string, unknown>> | undefined;
  const list = rawResults ?? fallbackResults;
  const keyword = details.searchKeyword as string | undefined;
  if (!Array.isArray(list)) return;
  for (const r of list) {
    if (typeof r.url !== "string") continue;
    const src: Source = { url: r.url };
    if (typeof r.title === "string") src.title = r.title;
    if (typeof r.snippet === "string") src.snippet = r.snippet;
    if (keyword) src.searchKeyword = keyword;
    sources.push(src);
  }
}
