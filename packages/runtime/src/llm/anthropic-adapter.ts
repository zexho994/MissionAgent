import type { LlmMessage, LlmCallOptions, LlmResponse, LlmCallStats } from "./types.js";
import type { LlmService } from "./llm-service.js";

export interface AnthropicAdapterOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  defaultModel?: string | undefined;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stop_reason: string | null;
}

interface AnthropicStreamEvent {
  type: string;
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export class AnthropicLlmAdapter implements LlmService {
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

  constructor(options: AnthropicAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("Anthropic API key is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || "https://api.anthropic.com/v1";
    this.defaultModel = options.defaultModel || "claude-3-5-haiku-latest";
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.fetchFn = options.fetch || fetch;
  }

  async call(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model || this.defaultModel;
    const timeoutMs = options?.timeoutMs || this.timeoutMs;
    const body = this.buildRequestBody(messages, model, options);
    const shouldStream = options?.onStream !== undefined;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await this.fetchFn(`${this.baseUrl}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
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
          return await this.handleStreamingResponse(response, options.onStream!, model);
        }

        const data = (await response.json()) as AnthropicMessageResponse;
        const content = data.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("");

        this.callCount += 1;
        this.lastCallAt = new Date().toISOString();
        this.totalPromptTokens += data.usage.input_tokens;
        this.totalCompletionTokens += data.usage.output_tokens;

        return {
          content,
          model: data.model,
          usage: {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          },
          finishReason: data.stop_reason ?? "unknown",
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.name === "AbortError") {
          throw new Error(`LLM call timed out after ${timeoutMs}ms`);
        }
        if (lastError.message.includes("LLM API error") && attempt < this.maxRetries) {
          await this.delay(Math.pow(2, attempt) * 500);
          continue;
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

  private async handleStreamingResponse(
    response: Response,
    onStream: (token: string) => void,
    model: string,
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.handleStreamEvent(event, onStream, {
            appendToken: (token) => {
              content += token;
            },
            setFinishReason: (reason) => {
              finishReason = reason;
            },
            setPromptTokens: (tokens) => {
              promptTokens = tokens;
            },
            setCompletionTokens: (tokens) => {
              completionTokens = tokens;
            },
          });
          boundary = buffer.indexOf("\n\n");
        }
      }

      if (buffer.trim()) {
        this.handleStreamEvent(buffer, onStream, {
          appendToken: (token) => {
            content += token;
          },
          setFinishReason: (reason) => {
            finishReason = reason;
          },
          setPromptTokens: (tokens) => {
            promptTokens = tokens;
          },
          setCompletionTokens: (tokens) => {
            completionTokens = tokens;
          },
        });
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
      reader.releaseLock();
    }
  }

  private handleStreamEvent(
    event: string,
    onStream: (token: string) => void,
    state: {
      appendToken(token: string): void;
      setFinishReason(reason: string): void;
      setPromptTokens(tokens: number): void;
      setCompletionTokens(tokens: number): void;
    },
  ): void {
    const dataLine = event
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("data: "));
    if (!dataLine) return;

    const data = JSON.parse(dataLine.slice(6)) as AnthropicStreamEvent;
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta" && data.delta.text) {
      state.appendToken(data.delta.text);
      onStream(data.delta.text);
    }
    if (data.delta?.stop_reason) {
      state.setFinishReason(data.delta.stop_reason);
    }
    if (data.usage?.input_tokens !== undefined) {
      state.setPromptTokens(data.usage.input_tokens);
    }
    if (data.usage?.output_tokens !== undefined) {
      state.setCompletionTokens(data.usage.output_tokens);
    }
  }

  private buildRequestBody(messages: LlmMessage[], model: string, options?: LlmCallOptions): unknown {
    const systemMessages = messages.filter((message) => message.role === "system");
    if (systemMessages.length > 1) {
      throw new Error("Anthropic Messages API only supports one system message");
    }

    return {
      model,
      max_tokens: options?.maxTokens ?? 1024,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.onStream !== undefined ? { stream: true } : {}),
      ...(systemMessages[0] ? { system: systemMessages[0].content } : {}),
      messages: messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role,
          content: message.content,
        })),
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
