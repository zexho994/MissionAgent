import { createId, type Mission, type MissionBrief } from "@digitalagent/core";
import type { LlmService, ToolCallTraceEvent } from "@digitalagent/runtime";
import { extractQuestionWithOptions, parseOwnerDecision } from "./owner/index.js";

export interface OwnerStreamingDeps {
  getMission(missionId: string): Mission | undefined;
  getMessages(missionId: string): Array<{ type: string; createdAt: string }>;
  setMission(mission: Mission): void;
  appendMessage(msg: { missionId: string; fromAgentId: string; type: string; content: string; options?: unknown }): void;
  updateAgent(agentId: string, patch: { status: string; lastAction: string }): void;
  notifyStream(missionId: string, event: { type: string; content?: string; messageId?: string }): void;
  notifyToolCall(missionId: string, event: ToolCallTraceEvent): void;
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

  const messageId = createId("message");

  try {
    let finalContent = await callOwnerLlm(llm, messages, missionId, deps);
    let decision = parseOwnerDecision(finalContent);
    if (decision.status === "invalid_json") {
      const repairMessages = buildOwnerJsonRepairMessages(messages, finalContent, decision.error);
      finalContent = await callOwnerLlm(llm, repairMessages, missionId, deps);
      decision = parseOwnerDecision(finalContent);
      if (decision.status === "invalid_json") {
        throw new Error(`Owner MissionBrief JSON parse failed after repair retry: ${decision.error}`);
      }
    }
    deps.notifyStream(missionId, { type: "done", messageId });
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
      const sourceContract = await extractMissionContract(llm, messages, currentMission.goal, missionId, deps);
      const contractValidation = await validateMissionBriefContract(llm, messages, currentMission.goal, sourceContract, decision.brief, missionId, deps);
      if (contractValidation.status === "fail") {
        const repairMessages = buildOwnerSemanticRepairMessages(messages, currentMission.goal, sourceContract, finalContent, contractValidation.reasons);
        finalContent = await callOwnerLlmSilent(llm, repairMessages, missionId, deps);
        decision = parseOwnerDecision(finalContent);
        if (decision.status === "invalid_json") {
          const repairJsonMessages = buildOwnerJsonRepairMessages(repairMessages, finalContent, decision.error);
          finalContent = await callOwnerLlmSilent(llm, repairJsonMessages, missionId, deps);
          decision = parseOwnerDecision(finalContent);
        }
        if (decision.status === "invalid_json") {
          throw new Error(`Owner MissionBrief JSON parse failed after semantic repair retry: ${decision.error}`);
        }
        if (decision.status !== "ready") {
          throw new Error("Owner MissionBrief semantic repair did not return a ready MissionBrief");
        }
        const repairedValidation = await validateMissionBriefContract(llm, messages, currentMission.goal, sourceContract, decision.brief, missionId, deps);
        if (repairedValidation.status === "fail") {
          throw new Error(`Owner MissionBrief contract validation failed after repair retry: ${repairedValidation.reasons.join("; ")}`);
        }
      }
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

async function callOwnerLlm(
  llm: LlmService,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  missionId: string,
  deps: OwnerStreamingDeps,
): Promise<string> {
  let streamedContent = "";
  const response = await llm.call(messages, {
    onStream: (token: string) => {
      streamedContent += token;
      deps.notifyStream(missionId, { type: "token", content: token });
    },
    onToolEvent: (event) => deps.notifyToolCall(missionId, event),
  });
  return streamedContent || response.content;
}

async function callOwnerLlmSilent(
  llm: LlmService,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  missionId: string,
  deps: OwnerStreamingDeps,
): Promise<string> {
  const response = await llm.call(messages, {
    onToolEvent: (event) => deps.notifyToolCall(missionId, event),
  });
  return response.content;
}

type BriefContractValidation =
  | { status: "pass"; reasons: string[] }
  | { status: "fail"; reasons: string[] };

interface MissionContract {
  requirements: string[];
}

async function extractMissionContract(
  llm: LlmService,
  originalMessages: { role: "system" | "user" | "assistant"; content: string }[],
  originalMissionGoal: string,
  missionId: string,
  deps: OwnerStreamingDeps,
): Promise<MissionContract> {
  const response = await callOwnerLlmSilent(llm, buildMissionContractExtractionMessages(originalMessages, originalMissionGoal), missionId, deps);
  const parsed = parseJsonRecord(response);
  const requirements = Array.isArray(parsed.requirements)
    ? parsed.requirements.map(String).map((requirement) => requirement.trim()).filter(Boolean)
    : [];
  return { requirements };
}

function buildMissionContractExtractionMessages(
  originalMessages: { role: "system" | "user" | "assistant"; content: string }[],
  originalMissionGoal: string,
): { role: "system" | "user" | "assistant"; content: string }[] {
  return [
    {
      role: "system",
      content: [
        "You extract the user's mission contract from a conversation.",
        "The original mission goal is always source-of-truth and must be included unless a later user message explicitly changes it.",
        "Use only user messages as source-of-truth requirements. Assistant messages are context only.",
        "Extract concrete requirements that the final MissionBrief must preserve: exact quantities, units, participant counts, actor types, turn counts, ordering requirements, exclusions, failure policies, deliverables, and completion criteria.",
        "Preserve exact numbers and units. Do not infer smaller examples, samples, timelines, or alternative counts.",
        "If a later user message explicitly changes an earlier requirement, keep only the later requirement.",
        "Return ONLY strict JSON: {\"requirements\":[\"specific user-stated requirement\"]}.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Mission contract extraction",
        originalMissionGoal,
        conversation: originalMessages
          .filter((message) => message.role !== "system")
          .map((message) => ({ role: message.role, content: message.content })),
      }),
    },
  ];
}

async function validateMissionBriefContract(
  llm: LlmService,
  originalMessages: { role: "system" | "user" | "assistant"; content: string }[],
  originalMissionGoal: string,
  sourceContract: MissionContract,
  brief: MissionBrief,
  missionId: string,
  deps: OwnerStreamingDeps,
): Promise<BriefContractValidation> {
  const response = await callOwnerLlmSilent(llm, buildMissionBriefContractValidationMessages(originalMessages, originalMissionGoal, sourceContract, brief), missionId, deps);
  return parseBriefContractValidation(response);
}

function buildMissionBriefContractValidationMessages(
  originalMessages: { role: "system" | "user" | "assistant"; content: string }[],
  originalMissionGoal: string,
  sourceContract: MissionContract,
  brief: MissionBrief,
): { role: "system" | "user" | "assistant"; content: string }[] {
  return [
    {
      role: "system",
      content: [
        "You are a strict MissionBrief contract validation reviewer.",
        "Your job is semantic preservation, not domain solving.",
        "Treat user messages as the source of truth. Assistant follow-up questions provide context but cannot weaken user-stated requirements.",
        "Check whether the candidate MissionBrief preserves every concrete requirement the user stated, including exact quantities, participant counts, round counts, ordering requirements, deliverables, exclusions, validation expectations, and completion criteria.",
        "Concrete numbers and their units are contract terms. A number may only change if a later user message explicitly changes it.",
        "Fail if the candidate changes the quantity or unit for the same requirement, such as changing 50 turns into 5 rounds, exactly 5 agents into 5 or more people, or a required runtime agent into a human participant.",
        "Fail if the candidate adds a smaller sample, estimate, or timeline that conflicts with the user's requested completion count.",
        "When multiple user messages exist, compare the candidate against the latest complete user intent while preserving all earlier concrete requirements that were not explicitly superseded.",
        "Fail if a user requirement is omitted, softened, generalized, changed into a different actor type, or replaced by an unrelated activity.",
        "Do not invent requirements that the user did not state.",
        "Return ONLY strict JSON: {\"status\":\"pass\",\"reasons\":[]} or {\"status\":\"fail\",\"reasons\":[\"specific actionable reason\"]}.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "MissionBrief contract validation",
        originalMissionGoal,
        extractedUserContract: sourceContract.requirements,
        conversation: originalMessages
          .filter((message) => message.role !== "system")
          .map((message) => ({ role: message.role, content: message.content })),
        candidateMissionBrief: brief,
      }),
    },
  ];
}

function parseBriefContractValidation(text: string): BriefContractValidation {
  const parsed = parseJsonRecord(text);
  const status = parsed.status;
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String).filter((reason) => reason.trim()) : [];
  if (status === "pass") return { status: "pass", reasons };
  if (status === "fail") {
    return { status: "fail", reasons: reasons.length ? reasons : ["MissionBrief contract validation failed without a reason."] };
  }
  throw new Error(`Owner MissionBrief contract validation returned invalid status: ${String(status)}`);
}

function buildOwnerSemanticRepairMessages(
  originalMessages: { role: "system" | "user" | "assistant"; content: string }[],
  originalMissionGoal: string,
  sourceContract: MissionContract,
  invalidResponse: string,
  reasons: string[],
): { role: "system" | "user" | "assistant"; content: string }[] {
  return [
    ...originalMessages,
    { role: "assistant", content: invalidResponse },
    {
      role: "user",
      content: [
        "MissionBrief contract validation failed.",
        "You must rewrite the MissionBrief once so it semantically preserves the user's original requirements.",
        "",
        "Validation reasons:",
        ...reasons.map((reason) => `- ${reason}`),
        "",
        "Original mission goal:",
        originalMissionGoal,
        "",
        "Extracted user contract requirements that must be preserved:",
        ...sourceContract.requirements.map((requirement) => `- ${requirement}`),
        "",
        "Return ONLY one valid MissionBrief JSON object.",
        "Do not ask another question unless the user's requirement is genuinely ambiguous.",
        "Do not soften exact quantities, participant counts, turn counts, ordering requirements, validation requirements, deliverables, exclusions, or completion criteria.",
      ].join("\n"),
    },
  ];
}

function buildOwnerJsonRepairMessages(
  originalMessages: { role: "system" | "user" | "assistant"; content: string }[],
  invalidResponse: string,
  parseError: string,
): { role: "system" | "user" | "assistant"; content: string }[] {
  return [
    ...originalMessages,
    { role: "assistant", content: invalidResponse },
    {
      role: "user",
      content: [
        "Previous Owner response JSON parse error:",
        parseError,
        "",
        "Previous invalid response:",
        invalidResponse,
        "",
        "Return ONLY one valid JSON object now.",
        "Use strict JSON syntax with ASCII punctuation: double quotes, colon, comma, square brackets, and braces.",
        "Do not include markdown, prose, or Chinese punctuation in JSON separators.",
        "If you still need information, return {\"status\":\"needs_info\",\"question\":\"...\"}.",
        "If ready, return a complete MissionBrief JSON object matching the required schema.",
      ].join("\n"),
    },
  ];
}

function parseJsonRecord(text: string): Record<string, unknown> {
  const candidate = extractJsonObject(text);
  if (!candidate) {
    throw new Error("No JSON object found in Owner contract validation response");
  }
  const parsed = JSON.parse(candidate) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Owner contract validation response must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function extractJsonObject(text: string): string | undefined {
  const stripped = text.trim();

  if (stripped.startsWith("{")) {
    const endIndex = findMatchingBrace(stripped, 0);
    if (endIndex !== -1) return stripped.slice(0, endIndex + 1);
  }

  const codeBlockMatch = stripped.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch?.[1]) {
    const inner = codeBlockMatch[1].trim();
    if (inner.startsWith("{")) return inner;
  }

  const braceIndex = stripped.indexOf("{");
  if (braceIndex !== -1) {
    const endIndex = findMatchingBrace(stripped, braceIndex);
    if (endIndex !== -1) return stripped.slice(braceIndex, endIndex + 1);
  }

  return undefined;
}

function findMatchingBrace(text: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
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
