import { complete, getModel, type Context, type Model, type Provider } from "@earendil-works/pi-ai";
import type { LlmService } from "./llm-service.js";
import type {
  LlmCallOptions,
  LlmCallStats,
  LlmMessage,
  LlmResponse,
} from "./types.js";

export type LlmProvider = Provider;

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

const DEFAULT_LLM_PROVIDER: LlmProvider = "minimax-cn";
const DEFAULT_LLM_MODEL = "MiniMax-M2.7-highspeed";

export function createLlmService(options: CreateLlmServiceOptions): LlmService {
  if (!options.apiKey) {
    throw new Error("LLM API key is required");
  }
  const modelId = options.model ?? defaultModelForProvider(options.provider);
  const completeFn = options.completeFn ?? complete;
  const baseUrl = options.baseUrl;

  const model = resolveModel({
    piProvider: options.provider,
    modelId,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
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
      const responseModelId = extractModelId(piResponse, modelId);
      const finishReason = extractFinishReason(piResponse);

      if (isFailedPiResponse(piResponse, content, finishReason)) {
        throw new Error(formatLlmFailure({
          provider: options.provider,
          model: responseModelId,
          response: piResponse,
          finishReason,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        }));
      }

      stats = {
        totalCalls: stats.totalCalls + 1,
        totalPromptTokens: stats.totalPromptTokens + promptTokens,
        totalCompletionTokens: stats.totalCompletionTokens + completionTokens,
        lastCallAt: new Date().toISOString(),
      };

      return {
        content,
        model: responseModelId,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        finishReason,
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
    if (m) {
      if (input.baseUrl) {
        return { ...m, baseUrl: input.baseUrl };
      }
      return m;
    }
  } catch {
    // fall through to custom shape
  }
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

function toContext(messages: LlmMessage[]): Context {
  const systemParts: string[] = [];
  const conversational: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: "text"; text: string }>;
  }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "assistant") {
      conversational.push({
        role: "assistant",
        content: [{ type: "text", text: m.content }],
      });
    } else {
      conversational.push({ role: m.role, content: m.content });
    }
  }
  return {
    systemPrompt: systemParts.join("\n\n"),
    messages: conversational,
    tools: [],
  } as unknown as Context;
}

function extractFinishReason(response: any): string {
  if (typeof response?.stopReason === "string") return response.stopReason;
  if (typeof response?.finishReason === "string") return response.finishReason;
  return "stop";
}

function isFailedPiResponse(response: any, content: string, finishReason: string): boolean {
  if (finishReason === "error") return true;
  return content === "" && extractTotalTokens(response?.usage) === 0;
}

function extractTotalTokens(usage: any): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  if (typeof usage.total === "number") return usage.total;

  const input = typeof usage.input === "number"
    ? usage.input
    : typeof usage.promptTokens === "number"
      ? usage.promptTokens
      : undefined;
  const output = typeof usage.output === "number"
    ? usage.output
    : typeof usage.completionTokens === "number"
      ? usage.completionTokens
      : undefined;

  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0);
}

function formatLlmFailure(input: {
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  response: any;
  finishReason: string;
}): string {
  const detail = extractErrorDetail(input.response);
  const baseUrlPart = input.baseUrl ? ` baseUrl=${input.baseUrl}` : "";
  return `LLM call failed: provider=${input.provider} model=${input.model}${baseUrlPart} finishReason=${input.finishReason}${detail ? ` error=${detail}` : ""}`;
}

function extractErrorDetail(response: any): string {
  const message = response?.errorMessage ?? response?.error?.message ?? response?.message;
  if (typeof message === "string" && message.trim() !== "") return message;
  return "";
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

function extractModelId(response: any, fallback: string): string {
  const model = response?.model;
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && typeof model.id === "string") {
    return model.id;
  }
  return fallback;
}

export function createLlmServiceFromEnv(
  env: LlmEnv,
  options?: CreateLlmServiceFromEnvOptions,
): LlmService {
  const provider = (env.LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER) as LlmProvider;
  const apiKey =
    env.LLM_API_KEY ??
    env.MINIMAX_API_KEY ??
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

function defaultModelForProvider(provider: LlmProvider): string {
  if (provider === DEFAULT_LLM_PROVIDER) return DEFAULT_LLM_MODEL;
  throw new Error(`LLM model is required for provider: ${provider}`);
}
