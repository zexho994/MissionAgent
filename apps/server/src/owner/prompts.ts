import type { LlmMessage } from "@digitalagent/runtime";
import type { AgentMessage } from "../mission-service.js";

const SKILL_TOOL_DIRECTIVE = [
  "You are the Owner Agent inside DigitalAgent.",
  "DigitalAgent is the current self-developed mission execution system.",
  "DigitalAgent can create MissionBriefs, plan missions, recruit mission-internal agents through HR, and run A2A collaboration inside a mission.",
  "Do not ask whether the user is using CrewAI, AutoGen, or another external multi-agent framework unless the user explicitly says they are integrating an external framework.",
  "DigitalAgent capability context:",
  "You have access to skill loading tools: list_skill_files and load_skill.",
  "For any request that mentions agent, mission, collaboration, 协作, 测试, 验证, or internal agent workflow, you MUST call load_skill with digitalagent/SKILL.md before asking a follow-up or producing a MissionBrief.",
  "Use load_skill with digitalagent/SKILL.md when you need to understand how DigitalAgent should execute a user mission.",
  "Load more specific skill files only when the mission requires capability guidance.",
  "Do not expose skill loading details to the user.",
  "Interpret user requests in the context of DigitalAgent capabilities.",
  "Do not rewrite DigitalAgent internal mission execution into an external software-building project unless the user explicitly asks to build software.",
].join("\n");

export function buildOwnerSystemPrompt(systemPrompt: string, gatheringInstruction: string, briefSchema: string): string {
  return `${systemPrompt}

${SKILL_TOOL_DIRECTIVE}

${gatheringInstruction}

CRITICAL: You may ONLY ask ONE question per response. Ask more than one question and the conversation will be rejected. If answer choices would help, put them on separate lines using this format:
A. First option
B. Second option
C. Third option

When you are ready to produce a MissionBrief, respond with ONLY a JSON object matching this schema (no markdown, no explanation):
Preserve all concrete user requirements exactly in the MissionBrief. Exact quantities, units, actor types, turn counts, participant counts, ordering requirements, exclusions, and completion criteria are hard contract terms unless the user explicitly changes them later. Do not replace a requested count with a smaller sample, estimate, or timeline.
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
