import type { LlmMessage, LlmCallOptions, LlmResponse, LlmCallStats } from "./types.js";
import type { LlmService } from "./llm-service.js";

export class FakeLlmAdapter implements LlmService {
  private readonly handler: (messages: LlmMessage[]) => string;
  private callCount = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private lastCallAt: string | undefined;
  private lastMessages: LlmMessage[] = [];

  constructor(handler: (messages: LlmMessage[]) => string) {
    this.handler = handler;
  }

  async call(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    this.callCount += 1;
    this.lastCallAt = new Date().toISOString();
    this.lastMessages = [...messages];

    const content = this.handler(messages);
    const promptTokens = messages.reduce((sum, message) => sum + message.content.length, 0);
    const completionTokens = content.length;

    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;

    if (options?.onStream) {
      for (const char of content) {
        options.onStream(char);
      }
    }

    return {
      content,
      model: "fake-llm",
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: "stop",
    };
  }

  stats(): LlmCallStats {
    return {
      totalCalls: this.callCount,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      lastCallAt: this.lastCallAt,
    };
  }

  getLastMessages(): LlmMessage[] {
    return this.lastMessages;
  }
}
