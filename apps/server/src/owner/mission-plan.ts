import type { MissionBrief, MissionPlan } from "@digitalagent/core";
import type { LlmMessage } from "@digitalagent/runtime";

export type MissionPlanDraft = Omit<
  MissionPlan,
  "id" | "missionId" | "status" | "createdAt" | "confirmedAt" | "revision" | "feedback"
>;

export type MissionPlanContractValidation =
  | { status: "pass"; reasons: string[] }
  | { status: "fail"; reasons: string[] };

export function buildMissionPlanMessages(input: { brief: MissionBrief; feedback?: string }): LlmMessage[] {
  return buildMissionPlanMessagesWithRepair(input);
}

export function buildMissionPlanMessagesWithRepair(input: {
  brief: MissionBrief;
  feedback?: string;
  parseError?: string;
}): LlmMessage[] {
  const repairInstruction = input.parseError
    ? [
        "",
        "Previous MissionPlan JSON parse error:",
        input.parseError,
        "",
        "Repair requirement: return one valid JSON object only. Preserve every hard constraint from the MissionBrief.",
      ].join("\n")
    : "";
  return [
    {
      role: "system",
      content: `You are the Owner planning workflow for DigitalAgent.
You have access to skill loading tools: list_skill_files and load_skill.
Use load_skill with digitalagent/SKILL.md when you need DigitalAgent capability context for planning.
Do not expose skill loading details in the returned JSON.
Return ONLY a JSON object. No markdown, no explanation.
The JSON must contain: goal, successMetrics, phases, workstreams, reportingLines, scheduleRhythms, risks, checkpoints.
goal must be a string. successMetrics, risks, and checkpoints must be arrays of strings.
Preserve explicit participant counts, round counts, and validation requirements from the MissionBrief exactly.
If the MissionBrief asks for 5 agents to participate, the plan workstreams must not downgrade that into fewer meta roles only.
If the MissionBrief fixes the participant agent count, do not add additional mandatory runtime roles, requiredRole entries, reporting roles, reviewers, coordinators, trackers, or validators beyond that fixed participant set unless the MissionBrief explicitly allows extra roles.
Validation, tracking, and coordination responsibilities must be assigned to the fixed participants or the Owner when the participant count is fixed.
Each phase must contain: name, objective, deliverables, successCriteria.
Each phase deliverables and successCriteria must be arrays of strings.
Each workstream must contain: name, objective, requiredRole, responsibilities, firstTaskGoal.
Each workstream responsibilities must be an array of strings.
Each reporting line must contain: fromRole, toRole, cadence, purpose.
Each schedule rhythm must contain: name, cadence, ownerRole, purpose.
Keep arrays concise with 1 to 3 items. Do not omit arrays. Use empty arrays only for risks when there are genuinely no risks.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        MissionBrief: input.brief,
        revisionFeedback: input.feedback ?? "",
      }) + repairInstruction,
    },
  ];
}

export function parseMissionPlanDraft(text: string): MissionPlanDraft {
  const jsonCandidate = extractJsonObject(text);
  if (!jsonCandidate) {
    throw new Error("No JSON object found in LLM response");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Invalid MissionPlan JSON in LLM response${detail}`);
  }

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

export function buildMissionPlanContractValidationMessages(input: {
  brief: MissionBrief;
  draft: MissionPlanDraft;
}): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a strict MissionPlan contract validation reviewer.",
        "Your job is semantic preservation from MissionBrief to MissionPlan, not domain solving.",
        "Treat the MissionBrief as the contract.",
        "Check whether the candidate MissionPlan preserves every concrete requirement from the MissionBrief, including exact quantities, participant counts, round counts, ordering requirements, deliverables, exclusions, validation expectations, and completion criteria.",
        "Fail if the plan omits, softens, generalizes, or changes a requirement.",
        "Fail if the plan adds mandatory runtime actors, tools, workstreams, or acceptance conditions that violate a fixed count or other constraint in the MissionBrief.",
        "When participant count is fixed, extra requiredRole entries, reporting roles, reviewer/coordinator/tracker/validator roles, or schedule owner roles count as added mandatory runtime actors unless the MissionBrief explicitly allows them.",
        "Do not invent requirements that the MissionBrief did not state.",
        "Return ONLY strict JSON: {\"status\":\"pass\",\"reasons\":[]} or {\"status\":\"fail\",\"reasons\":[\"specific actionable reason\"]}.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "MissionPlan contract validation",
        MissionBrief: input.brief,
        candidateMissionPlan: input.draft,
      }),
    },
  ];
}

export function parseMissionPlanContractValidation(text: string): MissionPlanContractValidation {
  const candidate = extractJsonObject(text);
  if (!candidate) {
    throw new Error("No JSON object found in MissionPlan contract validation response");
  }
  const parsed = JSON.parse(candidate) as Record<string, unknown>;
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String).filter((reason) => reason.trim()) : [];
  if (parsed.status === "pass") return { status: "pass", reasons };
  if (parsed.status === "fail") {
    return {
      status: "fail",
      reasons: reasons.length ? reasons : ["MissionPlan contract validation failed without a reason."],
    };
  }
  throw new Error(`MissionPlan contract validation returned invalid status: ${String(parsed.status)}`);
}

export function buildMissionPlanSemanticRepairMessages(input: {
  brief: MissionBrief;
  draft: MissionPlanDraft;
  reasons: string[];
  feedback?: string;
}): LlmMessage[] {
  return [
    {
      role: "system",
      content: `You are the Owner planning workflow for DigitalAgent.
Return ONLY one valid MissionPlan JSON object. No markdown, no explanation.
The JSON must contain: goal, successMetrics, phases, workstreams, reportingLines, scheduleRhythms, risks, checkpoints.
Rewrite the MissionPlan so it preserves the MissionBrief contract exactly.
Do not add mandatory runtime actors, tools, workstreams, or acceptance conditions that violate a fixed count or other constraint in the MissionBrief.
When participant count is fixed, validation, tracking, and coordination responsibilities must be assigned to the fixed participants or the Owner, not to extra reviewer/coordinator/tracker/validator roles.
Do not soften exact quantities, participant counts, turn counts, ordering requirements, validation requirements, deliverables, exclusions, or completion criteria.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Repair MissionPlan after contract validation failure",
        MissionBrief: input.brief,
        rejectedMissionPlan: input.draft,
        validationReasons: input.reasons,
        revisionFeedback: input.feedback ?? "",
      }),
    },
  ];
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
