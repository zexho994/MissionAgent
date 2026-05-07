import { createId, type Mission } from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";
import { extractQuestionWithOptions, parseOwnerDecision } from "./owner/index.js";

export interface OwnerStreamingDeps {
  getMission(missionId: string): Mission | undefined;
  getMessages(missionId: string): Array<{ type: string; createdAt: string }>;
  setMission(mission: Mission): void;
  appendMessage(msg: { missionId: string; fromAgentId: string; type: string; content: string; options?: unknown }): void;
  updateAgent(agentId: string, patch: { status: string; lastAction: string }): void;
  notifyStream(missionId: string, event: { type: string; content?: string; messageId?: string }): void;
  persist(): void;
}

export interface OwnerStreamingInput {
  missionId: string;
  ownerId: string;
  systemPrompt: string;
  userMessage: string | undefined;
  llmMessages: { role: "system" | "user" | "assistant"; content: string }[] | undefined;
  isCreation: boolean;
}

export async function runOwnerLlmStreaming(
  llm: LlmService,
  input: OwnerStreamingInput,
  deps: OwnerStreamingDeps,
): Promise<void> {
  const { missionId, ownerId, systemPrompt, userMessage, llmMessages, isCreation } = input;

  const messages = llmMessages || (userMessage ? [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userMessage },
  ] : []);

  let fullContent = "";
  const messageId = createId("message");

  try {
    const response = await llm.call(messages, {
      onStream: (token: string) => {
        fullContent += token;
        deps.notifyStream(missionId, { type: "token", content: token });
      },
    });

    const finalContent = fullContent || response.content;
    deps.notifyStream(missionId, { type: "done", messageId });

    const decision = parseOwnerDecision(finalContent);
    const choiceResult = decision.status === "needs_info"
      ? undefined
      : extractQuestionWithOptions(finalContent);
    const messageOptions = choiceResult?.options ? { options: choiceResult.options } : undefined;

    if (decision.status === "ready") {
      if (hasUnansweredOwnerFollowup(deps.getMessages(missionId))) {
        deps.updateAgent(ownerId, {
          status: "idle",
          lastAction: "Waiting for user answer before generating MissionBrief",
        });
        deps.persist();
        return;
      }
      const currentMission = deps.getMission(missionId);
      if (!currentMission) throw new Error("Mission disappeared during LLM call");
      deps.setMission({ ...currentMission, brief: decision.brief });
      deps.appendMessage({
        missionId,
        fromAgentId: ownerId,
        type: "mission_brief",
        content: finalContent,
        ...messageOptions,
      });
      deps.updateAgent(ownerId, {
        status: "idle",
        lastAction: "Generated MissionBrief from conversation",
      });
    } else if (decision.status === "needs_info") {
      deps.appendMessage({
        missionId,
        fromAgentId: ownerId,
        type: "owner_followup",
        content: decision.question,
      });
      deps.updateAgent(ownerId, {
        status: "idle",
        lastAction: isCreation ? "Analyzed user goal and asked clarifying question" : "Asked follow-up question",
      });
    } else {
      deps.appendMessage({
        missionId,
        fromAgentId: ownerId,
        type: "owner_followup",
        content: finalContent,
        ...messageOptions,
      });
      deps.updateAgent(ownerId, {
        status: "idle",
        lastAction: isCreation ? "Analyzed user goal and asked clarifying question" : "Asked follow-up question",
      });
    }

    deps.persist();
  } catch (error) {
    console.error("[Owner] LLM call failed:", error instanceof Error ? error.message : String(error));
    const errorMessage = `Owner LLM failed: ${error instanceof Error ? error.message : String(error)}`;
    deps.notifyStream(missionId, { type: "done", messageId });

    deps.appendMessage({
      missionId,
      fromAgentId: ownerId,
      type: "owner_error",
      content: errorMessage,
    });
    deps.updateAgent(ownerId, {
      status: "blocked",
      lastAction: errorMessage,
    });
    deps.persist();
  }
}

function hasUnansweredOwnerFollowup(messages: Array<{ type: string; createdAt: string }>): boolean {
  const sorted = [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const latestOwnerFollowupIndex = findLastMessageIndex(sorted, "owner_followup");
  if (latestOwnerFollowupIndex === -1) return false;
  const latestUserMessageIndex = findLastMessageIndex(sorted, "user_message");
  return latestUserMessageIndex < latestOwnerFollowupIndex;
}

function findLastMessageIndex(messages: Array<{ type: string }>, type: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === type) return index;
  }
  return -1;
}
