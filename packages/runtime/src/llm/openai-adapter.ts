import type { LlmMessage, LlmCallOptions, LlmResponse, LlmCallStats } from "./types.js";
import type { LlmService } from "./llm-service.js";

export interface OpenAiAdapterOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  defaultModel?: string | undefined;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface OpenAiChatResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAiLlmAdapter implements LlmService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private callCount = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private lastCallAt: string | undefined;

  constructor(options: OpenAiAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || "https://api.openai.com/v1";
    this.defaultModel = options.defaultModel || "gpt-4o-mini";
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.fetchFn = options.fetch || fetch;
  }

  async call(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model || this.defaultModel;
    const timeoutMs = options?.timeoutMs || this.timeoutMs;
    const body = {
      model,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "unknown error");
          throw new Error(`LLM API error ${response.status}: ${errorBody}`);
        }

        const data = (await response.json()) as OpenAiChatResponse;
        const choice = data.choices[0];
        if (!choice) {
          throw new Error("LLM API returned no choices");
        }

        this.callCount += 1;
        this.lastCallAt = new Date().toISOString();
        this.totalPromptTokens += data.usage.prompt_tokens;
        this.totalCompletionTokens += data.usage.completion_tokens;

        return {
          content: choice.message.content,
          model: data.model,
          usage: {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          },
          finishReason: choice.finish_reason,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.message.includes("LLM API error") && attempt < this.maxRetries) {
          await this.delay(Math.pow(2, attempt) * 500);
          continue;
        }
        if (lastError.name === "AbortError") {
          throw new Error(`LLM call timed out after ${timeoutMs}ms`);
        }
        if (attempt < this.maxRetries) {
          await this.delay(Math.pow(2, attempt) * 500);
          continue;
        }
      }
    }

    throw lastError || new Error("LLM call failed after retries");
  }

  stats(): LlmCallStats {
    return {
      totalCalls: this.callCount,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      lastCallAt: this.lastCallAt,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
