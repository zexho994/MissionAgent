import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel, type Model } from "@earendil-works/pi-ai";
import type { ToolCallTraceEvent } from "./tool-call-trace.js";

export interface PiAgentMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: "text"; text: string }>;
}

export interface PiAgentConfig {
  initialState: {
    systemPrompt: string;
    model: Model<any>;
    tools: AgentTool<any>[];
    messages: PiAgentMessage[];
  };
  sessionId?: string;
  getApiKey?: () => Promise<string>;
}

export interface PiAgentLike {
  prompt(text: string): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): void;
  state: {
    messages: unknown[];
  };
}

export interface RunPiAgentInput {
  apiKey: string;
  modelProvider?: string;
  modelId?: string;
  systemPrompt: string;
  messages: PiAgentMessage[];
  prompt: string;
  tools: AgentTool<any>[];
  timeoutSeconds: number;
  sessionId?: string;
  traceLabel?: string;
  onToolEvent?: (event: ToolCallTraceEvent) => void;
  onEvent?: (event: AgentEvent) => void;
  agentFactory?: (config: PiAgentConfig) => PiAgentLike;
}

export interface RunPiAgentResult {
  messages: unknown[];
}

export async function runPiAgent(input: RunPiAgentInput): Promise<RunPiAgentResult> {
  const model = resolveModelSafe(input.modelProvider ?? "minimax-cn", input.modelId ?? "MiniMax-M2.7-highspeed");
  const config: PiAgentConfig = {
    initialState: {
      systemPrompt: input.systemPrompt,
      model,
      tools: input.tools,
      messages: input.messages,
    },
    getApiKey: async () => input.apiKey,
  };
  if (input.sessionId) {
    config.sessionId = input.sessionId;
  }

  const agentFactory = input.agentFactory ?? ((agentConfig) => new Agent(agentConfig as never) as unknown as PiAgentLike);
  const agent = agentFactory(config);
  agent.subscribe((event) => {
    const toolEvent = toToolTraceEvent(event, input.traceLabel, input.sessionId);
    if (toolEvent) {
      logToolEvent(toolEvent);
      input.onToolEvent?.(toolEvent);
    }
    input.onEvent?.(event);
  });

  await runWithTimeout(agent.prompt(input.prompt), input.timeoutSeconds);
  return { messages: agent.state.messages };
}

function toToolTraceEvent(event: AgentEvent, traceLabel = "unknown", sessionId?: string): ToolCallTraceEvent | undefined {
  if (event.type === "tool_execution_start") {
    const toolEvent: ToolCallTraceEvent = {
      status: "start",
      traceLabel,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    };
    if (sessionId !== undefined) toolEvent.sessionId = sessionId;
    if (event.args !== undefined) toolEvent.args = event.args;
    return toolEvent;
  }

  if (event.type === "tool_execution_end") {
    const result = event.result as Record<string, unknown> | undefined;
    const toolEvent: ToolCallTraceEvent = {
      status: "end",
      traceLabel,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ok: !event.isError,
    };
    if (sessionId !== undefined) toolEvent.sessionId = sessionId;
    if (event.isError) toolEvent.error = result?.error ?? result;
    if (result?.details !== undefined) toolEvent.details = result.details;
    return toolEvent;
  }

  return undefined;
}

function logToolEvent(event: ToolCallTraceEvent): void {
  console.log(
    `[pi-agent tool][${event.traceLabel}] ${event.status} ${event.toolName}`,
    compactLogPayload({
      sessionId: event.sessionId,
      toolCallId: event.toolCallId,
      args: event.args,
      ok: event.ok,
      error: event.error,
      details: event.details,
    }),
  );
}

function compactLogPayload(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

export function resolveModelSafe(provider: string, modelId: string): Model<any> {
  try {
    const model = getModel(provider as any, modelId as any);
    if (model) return model as Model<any>;
  } catch {
    // fall through to custom model shape
  }
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<any>;
}

export function runWithTimeout<T>(promise: Promise<T>, timeoutSeconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`pi-agent timed out after ${timeoutSeconds}s`)), timeoutSeconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
