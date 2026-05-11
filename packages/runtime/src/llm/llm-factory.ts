import { complete, getModel, type Context, type Model } from "@earendil-works/pi-ai";
import type { LlmService } from "./llm-service.js";
import type {
  LlmCallOptions,
  LlmCallStats,
  LlmMessage,
  LlmResponse,
} from "./types.js";

export type LlmProvider = "openai" | "glm" | "claude" | "anthropic" | "minimax";

export type CompleteFn = typeof complete;

export interface CreateLlmServiceOptions {
  provider: LlmProvider;
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  maxRetries?: number;
  timeoutMs?: number;
  completeFn?: CompleteFn;
}

export type LlmEnv = Record<string, string | undefined>;

export interface CreateLlmServiceFromEnvOptions {
  completeFn?: CompleteFn;
}

interface ProviderResolution {
  piProvider: string;
  defaultModel: string;
  baseUrlOverride?: string;
}

const providerMap: Record<LlmProvider, ProviderResolution> = {
  openai: { piProvider: "openai", defaultModel: "gpt-4o-mini" },
  glm: {
    piProvider: "openai",
    defaultModel: "glm-4-flash",
    baseUrlOverride: "https://open.bigmodel.cn/api/paas/v4",
  },
  anthropic: { piProvider: "anthropic", defaultModel: "claude-3-5-haiku-latest" },
  claude: { piProvider: "anthropic", defaultModel: "claude-3-5-haiku-latest" },
  minimax: {
    piProvider: "openai",
    defaultModel: "MiniMax-M2.7-highspeed",
    baseUrlOverride: "https://api.minimax.io/v1",
  },
};

export function createLlmService(options: CreateLlmServiceOptions): LlmService {
  if (!options.apiKey) {
    throw new Error("LLM API key is required");
  }
  const resolution = providerMap[options.provider];
  const modelId = options.model ?? resolution.defaultModel;
  const completeFn = options.completeFn ?? complete;

  const model = resolveModel({
    piProvider: resolution.piProvider,
    modelId,
    baseUrl: options.baseUrl ?? resolution.baseUrlOverride,
  });

  let stats: LlmCallStats = {
    totalCalls: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
  };

  return {
    async call(messages: LlmMessage[], callOptions?: LlmCallOptions): Promise<LlmResponse> {
      const context = toContext(messages);
      const piResponse = await completeFn(model, context, {
        apiKey: options.apiKey,
        ...(callOptions?.maxTokens !== undefined
          ? { maxTokens: callOptions.maxTokens }
          : {}),
        ...(callOptions?.temperature !== undefined
          ? { temperature: callOptions.temperature }
          : {}),
      });

      const content = extractTextContent(piResponse);
      const promptTokens = piResponse.usage?.input ?? 0;
      const completionTokens = piResponse.usage?.output ?? 0;

      stats = {
        totalCalls: stats.totalCalls + 1,
        totalPromptTokens: stats.totalPromptTokens + promptTokens,
        totalCompletionTokens: stats.totalCompletionTokens + completionTokens,
        lastCallAt: new Date().toISOString(),
      };

      return {
        content,
        model: piResponse.model?.id ?? modelId,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        finishReason: piResponse.stopReason ?? "stop",
      };
    },
    stats() {
      return stats;
    },
  };
}

function resolveModel(input: {
  piProvider: string;
  modelId: string;
  baseUrl?: string;
}): Model<any> {
  try {
    const m = getModel(input.piProvider as any, input.modelId as any);
    if (input.baseUrl) {
      return { ...m, baseUrl: input.baseUrl };
    }
    return m;
  } catch {
    return {
      id: input.modelId,
      name: input.modelId,
      api: "openai-completions",
      provider: input.piProvider,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    } as Model<any>;
  }
}

function toContext(messages: LlmMessage[]): Context {
  const systemParts: string[] = [];
  const conversational: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      conversational.push({ role: m.role, content: m.content });
    }
  }
  return {
    systemPrompt: systemParts.join("\n\n"),
    messages: conversational,
    tools: [],
  };
}

function extractTextContent(response: any): string {
  const content = response?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
  }
  if (typeof content === "string") return content;
  return "";
}

export function createLlmServiceFromEnv(
  env: LlmEnv,
  options?: CreateLlmServiceFromEnvOptions,
): LlmService {
  const provider = (env.LLM_PROVIDER ?? "anthropic") as LlmProvider;
  const apiKey =
    env.LLM_API_KEY ??
    env.ANTHROPIC_API_KEY ??
    env.OPENAI_API_KEY ??
    "";
  return createLlmService({
    provider,
    apiKey,
    ...(env.LLM_MODEL !== undefined ? { model: env.LLM_MODEL } : {}),
    ...(env.LLM_BASE_URL !== undefined ? { baseUrl: env.LLM_BASE_URL } : {}),
    ...(options?.completeFn !== undefined ? { completeFn: options.completeFn } : {}),
  });
}
