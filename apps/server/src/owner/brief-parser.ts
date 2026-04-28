import type { MissionBrief } from "@digitalagent/core";

export type OwnerDecision =
  | { status: "ready"; brief: MissionBrief }
  | { status: "needs_info"; question: string }
  | { status: "followup"; content: string };

export function detectBriefInResponse(text: string): boolean {
  return parseOwnerDecision(text).status === "ready";
}

export function parseOwnerDecision(text: string): OwnerDecision {
  const jsonCandidate = extractJsonObject(text);
  if (!jsonCandidate) return { status: "followup", content: text };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
  } catch {
    return { status: "followup", content: text };
  }

  if (parsed.status === "needs_info" && typeof parsed.question === "string" && parsed.question.trim()) {
    return { status: "needs_info", question: parsed.question.trim() };
  }

  if (parsed.status === "ready") {
    const briefCandidate = isRecord(parsed.brief) ? parsed.brief : parsed;
    const brief = tryParseMissionBriefRecord(briefCandidate);
    if (brief) return { status: "ready", brief };
    return { status: "followup", content: text };
  }

  const brief = tryParseMissionBriefRecord(parsed);
  if (brief) return { status: "ready", brief };

  return { status: "followup", content: text };
}

export function parseMissionBrief(text: string): MissionBrief {
  const jsonCandidate = extractJsonObject(text);
  if (!jsonCandidate) {
    throw new Error("No JSON object found in LLM response");
  }

  const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;

  return parseMissionBriefRecord(parsed);
}

function tryParseMissionBriefRecord(parsed: Record<string, unknown>): MissionBrief | undefined {
  try {
    return parseMissionBriefRecord(parsed);
  } catch {
    return undefined;
  }
}

function parseMissionBriefRecord(parsed: Record<string, unknown>): MissionBrief {
  if (typeof parsed.goal !== "string" || !parsed.goal.trim()) {
    throw new Error("MissionBrief must have a non-empty goal");
  }
  if (!Array.isArray(parsed.successMetrics)) {
    throw new Error("MissionBrief must have successMetrics array");
  }
  if (!Array.isArray(parsed.constraints)) {
    throw new Error("MissionBrief must have constraints array");
  }

  return {
    goal: parsed.goal,
    scope: typeof parsed.scope === "string" ? parsed.scope : "",
    constraints: (parsed.constraints as string[]).map(String),
    successMetrics: (parsed.successMetrics as string[]).map(String),
    keyAssumptions: Array.isArray(parsed.keyAssumptions) ? (parsed.keyAssumptions as unknown[]).map(String) : [],
    targetAudience: typeof parsed.targetAudience === "string" ? parsed.targetAudience : undefined,
    timeline: typeof parsed.timeline === "string" ? parsed.timeline : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
