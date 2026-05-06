import { AnthropicLlmAdapter } from "./anthropic-adapter.js";
import type { LlmService } from "./llm-service.js";
import { OpenAiLlmAdapter } from "./openai-adapter.js";

export type LlmProvider = "openai" | "glm" | "claude" | "anthropic" | "minimax";

export interface CreateLlmServiceOptions {
  provider: LlmProvider;
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type LlmEnv = Record<string, string | undefined>;

export interface CreateLlmServiceFromEnvOptions {
  fetch?: typeof fetch;
}

const providerDefaults: Record<Exclude<LlmProvider, "claude">, { baseUrl: string; model: string }> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  glm: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-haiku-latest",
  },
  minimax: {
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M2.7-highspeed",
  },
};

export function createLlmService(options: CreateLlmServiceOptions): LlmService {
  if (!options.apiKey) {
    throw new Error("LLM API key is required");
  }

  switch (options.provider) {
    case "openai":
      return createOpenAiCompatibleService(options, providerDefaults.openai);
    case "glm":
      return createOpenAiCompatibleService(options, providerDefaults.glm);
    case "minimax":
      return createOpenAiCompatibleService(options, providerDefaults.minimax);
    case "claude":
    case "anthropic":
      return new AnthropicLlmAdapter({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl ?? providerDefaults.anthropic.baseUrl,
        defaultModel: options.model ?? providerDefaults.anthropic.model,
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    default:
      throw new Error(`Unsupported LLM provider: ${String(options.provider)}`);
  }
}

export function createLlmServiceFromEnv(
  env: LlmEnv = process.env,
  options: CreateLlmServiceFromEnvOptions = {},
): LlmService | undefined {
  const provider = env.LLM_PROVIDER;
  const apiKey = env.LLM_API_KEY;

  if (!provider && !apiKey) {
    return undefined;
  }
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required when LLM provider is configured");
  }

  return createLlmService({
    provider: normalizeProvider(provider ?? "openai"),
    apiKey,
    baseUrl: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function createOpenAiCompatibleService(
  options: CreateLlmServiceOptions,
  defaults: { baseUrl: string; model: string },
): LlmService {
  return new OpenAiLlmAdapter({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? defaults.baseUrl,
    defaultModel: options.model ?? defaults.model,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function normalizeProvider(provider: string): LlmProvider {
  const normalized = provider.trim().toLowerCase();
  switch (normalized) {
    case "openai":
    case "glm":
    case "claude":
    case "anthropic":
    case "minimax":
      return normalized;
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}
