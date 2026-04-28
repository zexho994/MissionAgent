import type { LlmMessage, LlmCallOptions, LlmResponse, LlmCallStats } from "./types.js";

export interface LlmService {
  call(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse>;
  stats(): LlmCallStats;
}
