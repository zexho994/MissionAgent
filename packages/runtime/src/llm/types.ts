export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  onStream?: (token: string) => void;
  extraBody?: Record<string, unknown>;
}

export interface LlmResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
}

export interface LlmCallStats {
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  lastCallAt?: string | undefined;
}

export interface LlmStreamChunk {
  type: "token" | "done";
  content?: string;
  messageId?: string;
}
