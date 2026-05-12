import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel, type Model } from "@earendil-works/pi-ai";
import type { Source } from "@digitalagent/core";

export interface PiSdkAdapterOptions {
  apiKey: string;
  modelProvider?: string;
  modelId?: string;
  tools?: AgentTool<any>[];
  agentFactory?: (config: AgentConfig) => AgentLike;
}

export interface AgentConfig {
  initialState: {
    systemPrompt: string;
    model: Model<any>;
    tools: AgentTool<any>[];
    messages: never[];
  };
  sessionId?: string;
  getApiKey?: () => Promise<string>;
}

export interface AgentLike {
  prompt(text: string): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): void;
  state: {
    messages: unknown[];
  };
}

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
    this.modelProvider = options.modelProvider ?? "minimax";
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
    const model = resolveModelSafe(this.modelProvider, this.modelId);
    const sources: Source[] = [];

    const config: AgentConfig = {
      initialState: {
        systemPrompt: input.systemPrompt ?? "",
        model,
        tools: this.tools,
        messages: [] as never[],
      },
      getApiKey: async () => this.apiKey,
    };
    if (input.sessionId) {
      config.sessionId = input.sessionId;
    }

    const agent = this.agentFactory(config);

    agent.subscribe((event) => {
      collectSourcesFromEvent(event, sources);
    });

    try {
      await runWithTimeout(agent.prompt(input.message), input.timeoutSeconds);
      return {
        status: "completed",
        output: { messages: agent.state.messages },
        stderr: "",
        sources,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        output: { messages: agent.state.messages, error: message },
        stderr: message,
        sources,
        error: message,
      };
    }
  }
}

function resolveModelSafe(provider: string, modelId: string): Model<any> {
  try {
    const m = getModel(provider as never, modelId as never);
    if (m) return m;
  } catch {
    // fall through
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

function runWithTimeout<T>(promise: Promise<T>, timeoutSeconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`pi agent task timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
