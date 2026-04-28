import { createId, type Mission } from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";
import { parseMissionBrief, detectBriefInResponse, extractQuestionWithOptions } from "./owner/index.js";

export interface OwnerStreamingDeps {
  getMission(missionId: string): Mission | undefined;
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
  fallbackContent: string;
}

export async function runOwnerLlmStreaming(
  llm: LlmService,
  input: OwnerStreamingInput,
  deps: OwnerStreamingDeps,
): Promise<void> {
  const { missionId, ownerId, systemPrompt, userMessage, llmMessages, isCreation, fallbackContent } = input;

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

    const choiceResult = extractQuestionWithOptions(finalContent);
    const hasBrief = detectBriefInResponse(finalContent);
    const messageOptions = choiceResult?.options ? { options: choiceResult.options } : undefined;

    if (hasBrief) {
      try {
        const brief = parseMissionBrief(finalContent);
        const currentMission = deps.getMission(missionId);
        if (!currentMission) throw new Error("Mission disappeared during LLM call");
        deps.setMission({ ...currentMission, brief });
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
      } catch (parseError) {
        console.error("[Owner] MissionBrief parse failed:", parseError instanceof Error ? parseError.message : String(parseError));
        deps.appendMessage({
          missionId,
          fromAgentId: ownerId,
          type: "owner_followup",
          content: finalContent,
          ...messageOptions,
        });
        deps.updateAgent(ownerId, {
          status: "idle",
          lastAction: "LLM response received but Brief parsing failed",
        });
      }
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
    deps.notifyStream(missionId, { type: "done", messageId });

    deps.appendMessage({
      missionId,
      fromAgentId: ownerId,
      type: "owner_followup",
      content: fallbackContent,
    });
    deps.updateAgent(ownerId, {
      status: "idle",
      lastAction: "LLM failed, used template fallback",
    });
    deps.persist();
  }
}
