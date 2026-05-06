import type { LlmMessage } from "@digitalagent/runtime";
import type { AgentMessage } from "../mission-service.js";

export function buildOwnerSystemPrompt(systemPrompt: string, gatheringInstruction: string, briefSchema: string): string {
  return `${systemPrompt}

${gatheringInstruction}

When you need more information, ask exactly one question. If answer choices would help, put them on separate lines using this format:
A. First option
B. Second option
C. Third option

When you are ready to produce a MissionBrief, respond with ONLY a JSON object matching this schema (no markdown, no explanation):
${briefSchema}

## Responding to Feedback Events

When you receive a feedback_evaluated event with a blocked or regressed outcome:
1. Review the evaluation: summary, risks, recommended next actions
2. If a failureAnalysis is present, review the root cause and recommended recovery
3. Decide: does this failure indicate a fundamental problem with the current
   strategy that requires adjustment, or is it an isolated execution issue
   that can be resolved by revising the task?
4. If strategy adjustment is warranted:
   - Use the propose_strategy_adjustment action with the following payload:
     {
       "type": "propose_strategy_adjustment",
       "payload": {
         "rationale": "<why adjustment is needed>",
         "previousStrategy": "<current strategy as you understand it>",
         "proposedStrategy": "<what to change>",
         "affectedAgentRoles": ["<role1>", "<role2>"],
         "proposedTaskGoals": ["<goal1>", "<goal2>"]
       }
     }
   - The system will automatically trigger an HR review after the adjustment is recorded.
5. If no adjustment is needed, respond with acknowledge action.`;
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
