import type { MissionBrief, MissionPlan } from "@digitalagent/core";
import type { LlmMessage } from "@digitalagent/runtime";

export type MissionPlanDraft = Omit<
  MissionPlan,
  "id" | "missionId" | "status" | "createdAt" | "confirmedAt" | "revision" | "feedback"
>;

export function buildMissionPlanMessages(input: { brief: MissionBrief; feedback?: string }): LlmMessage[] {
  return [
    {
      role: "system",
      content: `You are the Owner planning workflow for DigitalAgent.
Return ONLY a JSON object. No markdown, no explanation.
The JSON must contain: goal, successMetrics, phases, workstreams, reportingLines, scheduleRhythms, risks, checkpoints.
Each phase must contain: name, objective, deliverables, successCriteria.
Each workstream must contain: name, objective, requiredRole, responsibilities, firstTaskGoal.
Each reporting line must contain: fromRole, toRole, cadence, purpose.
Each schedule rhythm must contain: name, cadence, ownerRole, purpose.
Do not omit arrays. Use empty arrays only for risks when there are genuinely no risks.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        missionBrief: input.brief,
        revisionFeedback: input.feedback ?? "",
      }),
    },
  ];
}

export function parseMissionPlanDraft(text: string): MissionPlanDraft {
  const jsonCandidate = extractJsonObject(text);
  if (!jsonCandidate) {
    throw new Error("No JSON object found in LLM response");
  }

  const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;

  return {
    goal: requireNonEmptyString(parsed.goal, "MissionPlan.goal"),
    successMetrics: requireNonEmptyStringArray(parsed.successMetrics, "MissionPlan.successMetrics"),
    phases: requireNonEmptyArray(parsed.phases, "MissionPlan.phases").map(parsePhase),
    workstreams: requireNonEmptyArray(parsed.workstreams, "MissionPlan.workstreams").map(parseWorkstream),
    reportingLines: requireArray(parsed.reportingLines, "MissionPlan.reportingLines").map(parseReportingLine),
    scheduleRhythms: requireNonEmptyArray(parsed.scheduleRhythms, "MissionPlan.scheduleRhythms").map(
      parseScheduleRhythm,
    ),
    risks: requireArray(parsed.risks, "MissionPlan.risks").map((risk) =>
      requireNonEmptyString(risk, "MissionPlan.risks"),
    ),
    checkpoints: requireNonEmptyStringArray(parsed.checkpoints, "MissionPlan.checkpoints"),
  };
}

function parsePhase(value: unknown) {
  const record = requireRecord(value, "MissionPlanPhase");
  return {
    name: requireNonEmptyString(record.name, "MissionPlanPhase.name"),
    objective: requireNonEmptyString(record.objective, "MissionPlanPhase.objective"),
    deliverables: requireNonEmptyStringArray(record.deliverables, "MissionPlanPhase.deliverables"),
    successCriteria: requireNonEmptyStringArray(record.successCriteria, "MissionPlanPhase.successCriteria"),
  };
}

function parseWorkstream(value: unknown) {
  const record = requireRecord(value, "MissionPlanWorkstream");
  return {
    name: requireNonEmptyString(record.name, "MissionPlanWorkstream.name"),
    objective: requireNonEmptyString(record.objective, "MissionPlanWorkstream.objective"),
    requiredRole: requireNonEmptyString(record.requiredRole, "MissionPlanWorkstream.requiredRole"),
    responsibilities: requireNonEmptyStringArray(
      record.responsibilities,
      "MissionPlanWorkstream.responsibilities",
    ),
    firstTaskGoal: requireNonEmptyString(record.firstTaskGoal, "MissionPlanWorkstream.firstTaskGoal"),
  };
}

function parseReportingLine(value: unknown) {
  const record = requireRecord(value, "MissionPlanReportingLine");
  return {
    fromRole: requireNonEmptyString(record.fromRole, "MissionPlanReportingLine.fromRole"),
    toRole: requireNonEmptyString(record.toRole, "MissionPlanReportingLine.toRole"),
    cadence: requireNonEmptyString(record.cadence, "MissionPlanReportingLine.cadence"),
    purpose: requireNonEmptyString(record.purpose, "MissionPlanReportingLine.purpose"),
  };
}

function parseScheduleRhythm(value: unknown) {
  const record = requireRecord(value, "MissionPlanScheduleRhythm");
  return {
    name: requireNonEmptyString(record.name, "MissionPlanScheduleRhythm.name"),
    cadence: requireNonEmptyString(record.cadence, "MissionPlanScheduleRhythm.cadence"),
    ownerRole: requireNonEmptyString(record.ownerRole, "MissionPlanScheduleRhythm.ownerRole"),
    purpose: requireNonEmptyString(record.purpose, "MissionPlanScheduleRhythm.purpose"),
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function requireNonEmptyArray(value: unknown, name: string): unknown[] {
  const array = requireArray(value, name);
  if (array.length === 0) {
    throw new Error(`${ownerName(name)} must have non-empty ${fieldName(name)}`);
  }
  return array;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireNonEmptyStringArray(value: unknown, name: string): string[] {
  return requireNonEmptyArray(value, name).map((item) => requireNonEmptyString(item, name));
}

function fieldName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function ownerName(name: string): string {
  return name.startsWith("MissionPlan.") ? "MissionPlan" : name;
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

  return undefined;
}

function findMatchingBrace(text: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}
