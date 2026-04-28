import type { LlmMessage } from "@digitalagent/runtime";
import type { AgentMessage } from "../mission-service.js";

export function buildOwnerSystemPrompt(systemPrompt: string, gatheringInstruction: string, briefSchema: string): string {
  return `${systemPrompt}

${gatheringInstruction}

When you are ready to produce a MissionBrief, respond with ONLY a JSON object matching this schema (no markdown, no explanation):
${briefSchema}`;
}

export function buildConversationMessages(
  systemPrompt: string,
  history: AgentMessage[],
  currentMessage: string,
): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "system", content: systemPrompt }];

  for (const message of history) {
    if (message.type === "user_message") {
      messages.push({ role: "user", content: message.content });
    } else if (message.type === "owner_followup" || message.type === "mission_brief") {
      messages.push({ role: "assistant", content: message.content });
    }
  }

  messages.push({ role: "user", content: currentMessage });
  return messages;
}

export function buildSummaryRequest(
  systemPrompt: string,
  history: AgentMessage[],
): LlmMessage[] {
  const messages = buildConversationMessages(systemPrompt, history, "Based on our conversation, please generate the MissionBrief JSON now.");
  return messages;
}
