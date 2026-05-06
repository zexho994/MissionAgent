import type { LlmMessage, LlmCallOptions, LlmResponse, LlmCallStats } from "./types.js";
import type { LlmService } from "./llm-service.js";

export interface OpenAiAdapterOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  defaultModel?: string | undefined;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  defaultExtraBody?: Record<string, unknown>;
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

interface OpenAiStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      role?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
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
  private readonly defaultExtraBody: Record<string, unknown>;
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
    this.defaultExtraBody = options.defaultExtraBody ?? {};
  }

  async call(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model || this.defaultModel;
    const timeoutMs = options?.timeoutMs || this.timeoutMs;
    const idleTimeoutMs = options?.idleTimeoutMs;
    const shouldStream = options?.onStream !== undefined;

    const body = {
      model,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(shouldStream ? { stream: true } : {}),
      ...this.defaultExtraBody,
      ...(options?.extraBody ?? {}),
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

        if (shouldStream) {
          return await this.handleStreamingResponse(response, options?.onStream!, model, idleTimeoutMs);
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

  private async handleStreamingResponse(
    response: Response,
    onStream: (token: string) => void,
    model: string,
    idleTimeoutMs?: number,
  ): Promise<LlmResponse> {
    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let content = "";
    let finishReason = "unknown";
    let promptTokens = 0;
    let completionTokens = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveIdleAbort: (() => void) | undefined;
    let idleTimerActive = false;

    const startIdleTimer = (abortFn: () => void) => {
      if (idleTimeoutMs && !idleTimerActive) {
        idleTimerActive = true;
        idleTimer = setTimeout(() => {
          resolveIdleAbort = abortFn;
        }, idleTimeoutMs);
      }
    };

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      idleTimerActive = false;
    };

    try {
      while (true) {
        startIdleTimer(() => {
          reader.cancel().catch(() => {});
        });

        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (readError) {
          if (resolveIdleAbort) {
            throw new Error(`LLM stream idle timeout: no output for ${idleTimeoutMs}ms`);
          }
          throw readError;
        }

        clearIdleTimer();

        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let lineEnd = buffer.indexOf("\n");
        while (lineEnd !== -1) {
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 1);
          const result = this.handleStreamingLine(line, onStream);
          if (result.content) content += result.content;
          if (result.finishReason) finishReason = result.finishReason;
          if (result.promptTokens !== undefined) promptTokens = result.promptTokens;
          if (result.completionTokens !== undefined) completionTokens = result.completionTokens;
          lineEnd = buffer.indexOf("\n");
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const result = this.handleStreamingLine(buffer, onStream);
        if (result.content) content += result.content;
        if (result.finishReason) finishReason = result.finishReason;
        if (result.promptTokens !== undefined) promptTokens = result.promptTokens;
        if (result.completionTokens !== undefined) completionTokens = result.completionTokens;
      }

      this.callCount += 1;
      this.lastCallAt = new Date().toISOString();
      this.totalPromptTokens += promptTokens;
      this.totalCompletionTokens += completionTokens;

      return {
        content,
        model,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        finishReason,
      };
    } finally {
      clearIdleTimer();
      reader.releaseLock();
    }
  }

  private handleStreamingLine(
    line: string,
    onStream: (token: string) => void,
  ): {
    content?: string;
    finishReason?: string;
    promptTokens?: number;
    completionTokens?: number;
  } {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "data: [DONE]" || !trimmed.startsWith("data: ")) {
      return {};
    }

    try {
      const data = JSON.parse(trimmed.slice(6)) as OpenAiStreamChunk;
      const delta = data.choices?.[0]?.delta;
      const result: {
        content?: string;
        finishReason?: string;
        promptTokens?: number;
        completionTokens?: number;
      } = {};

      if (delta?.content) {
        result.content = delta.content;
        onStream(delta.content);
      }

      if (data.choices?.[0]?.finish_reason) {
        result.finishReason = data.choices[0].finish_reason;
      }

      if (data.usage) {
        result.promptTokens = data.usage.prompt_tokens || 0;
        result.completionTokens = data.usage.completion_tokens || 0;
      }

      return result;
    } catch (parseError) {
      console.warn("Failed to parse streaming chunk:", parseError);
      return {};
    }
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
