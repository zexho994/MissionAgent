import type { MissionBrief } from "@digitalagent/core";

export function detectBriefInResponse(text: string): boolean {
  const jsonCandidate = extractJsonObject(text);
  if (!jsonCandidate) return false;

  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    return typeof parsed.goal === "string" && Array.isArray(parsed.successMetrics);
  } catch {
    return false;
  }
}

export function parseMissionBrief(text: string): MissionBrief {
  const jsonCandidate = extractJsonObject(text);
  if (!jsonCandidate) {
    throw new Error("No JSON object found in LLM response");
  }

  const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;

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
