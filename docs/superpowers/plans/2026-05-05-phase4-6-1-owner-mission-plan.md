# Phase 4.6.1 Owner MissionPlan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a confirmed `MissionPlan` gate between confirmed `MissionBrief` and autopilot readiness.

**Architecture:** Add typed MissionPlan state in core, parse Owner planning JSON through a dedicated prompt/parser, store plans inside `InMemoryMissionService`, expose plan endpoints, and render a plan review surface before War Room creation. The autopilot diagnosis must derive `hasPlan` from confirmed plan state instead of an API hard-code.

**Tech Stack:** TypeScript, Node.js, Vitest, `@digitalagent/core`, `@digitalagent/runtime`, existing static frontend in `apps/server/public`.

---

## File Structure

- Modify `packages/core/src/types.ts`: add `MissionPlan` types, `confirmedPlanId` on `Mission`, and `plans` on `MissionSnapshot` consumers.
- Create `apps/server/src/owner/mission-plan.ts`: Owner planning prompt builder and strict parser.
- Modify `apps/server/src/owner/index.ts`: export MissionPlan prompt/parser helpers.
- Modify `apps/server/src/owner/brief-parser.test.ts` or create `apps/server/src/owner/mission-plan.test.ts`: parser/prompt tests.
- Modify `apps/server/src/mission-service.ts`: add plan store, generation, revision, confirmation, snapshot persistence, and diagnosis integration.
- Modify `apps/server/src/mission-service.test.ts`: service workflow tests.
- Modify `apps/server/src/api.ts`: add plan API routes and remove hard-coded `hasPlan: false`.
- Modify `apps/server/src/api.test.ts`: endpoint tests.
- Modify `apps/server/public/app.js`: render plan review UI and wire generate/confirm/revise actions.
- Modify `apps/server/public/war-room.js` only if copy needs to reflect plan state; the existing signal chip should work once diagnosis is correct.
- Modify `apps/server/public/styles.css`: plan review layout.

## Task 1: Core MissionPlan Types

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/src/types.ts` through `pnpm --filter @digitalagent/core typecheck`

- [ ] **Step 1: Add MissionPlan type definitions**

Add these definitions after `MissionBrief`:

```ts
export type MissionPlanStatus = "draft" | "confirmed" | "superseded";

export interface MissionPlanPhase {
  name: string;
  objective: string;
  deliverables: string[];
  successCriteria: string[];
}

export interface MissionPlanWorkstream {
  name: string;
  objective: string;
  requiredRole: string;
  responsibilities: string[];
  firstTaskGoal: string;
}

export interface MissionPlanReportingLine {
  fromRole: string;
  toRole: string;
  cadence: string;
  purpose: string;
}

export interface MissionPlanScheduleRhythm {
  name: string;
  cadence: string;
  ownerRole: string;
  purpose: string;
}

export interface MissionPlan {
  id: string;
  missionId: string;
  status: MissionPlanStatus;
  createdAt: Date;
  confirmedAt?: Date;
  revision: number;
  feedback?: string;
  goal: string;
  successMetrics: string[];
  phases: MissionPlanPhase[];
  workstreams: MissionPlanWorkstream[];
  reportingLines: MissionPlanReportingLine[];
  scheduleRhythms: MissionPlanScheduleRhythm[];
  risks: string[];
  checkpoints: string[];
}
```

- [ ] **Step 2: Add confirmed plan pointer to Mission**

Update `Mission`:

```ts
export interface Mission {
  id: string;
  goal: string;
  successMetrics: string[];
  constraints: string[];
  status: MissionStatus;
  budget: MissionBudget;
  createdAt: Date;
  brief?: MissionBrief;
  briefConfirmed?: boolean;
  confirmedPlanId?: string;
  scheduleRules: ScheduleRule[];
}
```

- [ ] **Step 3: Run core typecheck**

Run:

```bash
pnpm --filter @digitalagent/core typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat: add mission plan core types"
```

## Task 2: Owner MissionPlan Prompt And Parser

**Files:**
- Create: `apps/server/src/owner/mission-plan.ts`
- Modify: `apps/server/src/owner/index.ts`
- Test: `apps/server/src/owner/mission-plan.test.ts`

- [ ] **Step 1: Write parser tests first**

Create `apps/server/src/owner/mission-plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMissionPlanMessages, parseMissionPlanDraft } from "./mission-plan.js";
import type { MissionBrief } from "@digitalagent/core";

const brief: MissionBrief = {
  goal: "Grow two GitHub repositories past 1k stars",
  scope: "GitHub account and repository growth",
  constraints: ["one month"],
  successMetrics: ["two repositories exceed 1k stars"],
  keyAssumptions: ["developer audience"],
  targetAudience: "GitHub developers",
  timeline: "one month",
};

describe("MissionPlan Owner prompt/parser", () => {
  it("parses a complete MissionPlan JSON object", () => {
    const plan = parseMissionPlanDraft(`{
      "goal":"Grow two GitHub repositories past 1k stars",
      "successMetrics":["two repositories exceed 1k stars"],
      "phases":[{"name":"Positioning","objective":"Clarify repository story","deliverables":["profile update"],"successCriteria":["story is clear"]}],
      "workstreams":[{"name":"Content","objective":"Publish useful updates","requiredRole":"Content Strategist","responsibilities":["write posts"],"firstTaskGoal":"Draft launch post"}],
      "reportingLines":[{"fromRole":"Content Strategist","toRole":"Owner","cadence":"daily","purpose":"Progress updates"}],
      "scheduleRhythms":[{"name":"Daily growth check","cadence":"daily","ownerRole":"Owner","purpose":"Review star growth"}],
      "risks":["content may not resonate"],
      "checkpoints":["weekly star review"]
    }`);

    expect(plan.goal).toBe("Grow two GitHub repositories past 1k stars");
    expect(plan.workstreams[0]?.requiredRole).toBe("Content Strategist");
    expect(plan.scheduleRhythms[0]?.cadence).toBe("daily");
  });

  it("rejects malformed plan output instead of falling back", () => {
    expect(() => parseMissionPlanDraft(`{"goal":"x","successMetrics":[]}`)).toThrow("MissionPlan must have non-empty successMetrics");
    expect(() => parseMissionPlanDraft("plain text")).toThrow("No JSON object found in LLM response");
  });

  it("builds planning messages with confirmed brief and optional feedback", () => {
    const messages = buildMissionPlanMessages({ brief, feedback: "Add a stronger analytics role." });

    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain("Grow two GitHub repositories past 1k stars");
    expect(messages[1]?.content).toContain("Add a stronger analytics role.");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- owner/mission-plan.test.ts
```

Expected: FAIL because `apps/server/src/owner/mission-plan.ts` does not exist.

- [ ] **Step 3: Implement prompt and strict parser**

Create `apps/server/src/owner/mission-plan.ts`:

```ts
import type { MissionBrief, MissionPlan } from "@digitalagent/core";
import type { LlmMessage } from "@digitalagent/runtime";

export type MissionPlanDraft = Omit<MissionPlan, "id" | "missionId" | "status" | "createdAt" | "confirmedAt" | "revision" | "feedback">;

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
    scheduleRhythms: requireNonEmptyArray(parsed.scheduleRhythms, "MissionPlan.scheduleRhythms").map(parseScheduleRhythm),
    risks: requireArray(parsed.risks, "MissionPlan.risks").map(String),
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
    responsibilities: requireNonEmptyStringArray(record.responsibilities, "MissionPlanWorkstream.responsibilities"),
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
    throw new Error(`${name} must not be empty`);
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
  const array = requireNonEmptyArray(value, name).map((item) => requireNonEmptyString(item, name));
  return array;
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
    if (char === "\"") inString = true;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
```

- [ ] **Step 4: Export helpers**

Update `apps/server/src/owner/index.ts`:

```ts
export { parseMissionBrief, detectBriefInResponse, parseOwnerDecision, type OwnerDecision } from "./brief-parser.js";
export { buildOwnerSystemPrompt, buildConversationMessages, buildSummaryRequest } from "./prompts.js";
export { buildMissionPlanMessages, parseMissionPlanDraft, type MissionPlanDraft } from "./mission-plan.js";
```

- [ ] **Step 5: Run parser tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- owner/mission-plan.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/owner/mission-plan.ts apps/server/src/owner/mission-plan.test.ts apps/server/src/owner/index.ts
git commit -m "feat: add owner mission plan parser"
```

## Task 3: MissionService Plan State And Diagnosis

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write service tests first**

Append tests inside `describe("InMemoryMissionService", () => { ... })` near the autopilot diagnosis tests in `apps/server/src/mission-service.test.ts`:

```ts
  it("does not generate a MissionPlan before brief confirmation", async () => {
    const service = new InMemoryMissionService({ llm: diagnosisBriefLlm() });
    const mission = await service.createMission({ goal: "Run a mission" });

    await expect(service.generateMissionPlan({ missionId: mission.id })).rejects.toThrow(
      "MissionBrief must be confirmed before generating MissionPlan",
    );
  });

  it("generates, revises, and confirms MissionPlan state", async () => {
    const service = new InMemoryMissionService({
      llm: new FakeLlmAdapter(() => JSON.stringify({
        goal: "Run a mission",
        successMetrics: ["Mission is runnable"],
        phases: [{ name: "Plan", objective: "Define work", deliverables: ["work plan"], successCriteria: ["plan approved"] }],
        workstreams: [{ name: "Execution", objective: "Run work", requiredRole: "Execution Lead", responsibilities: ["execute"], firstTaskGoal: "Start first task" }],
        reportingLines: [{ fromRole: "Execution Lead", toRole: "Owner", cadence: "daily", purpose: "Report progress" }],
        scheduleRhythms: [{ name: "Daily check", cadence: "daily", ownerRole: "Owner", purpose: "Review progress" }],
        risks: ["unclear inputs"],
        checkpoints: ["daily owner review"],
      })),
    });
    const mission = await createConfirmedMission(service);

    const firstPlan = await service.generateMissionPlan({ missionId: mission.id });
    const secondPlan = await service.generateMissionPlan({ missionId: mission.id, feedback: "Make execution role clearer." });

    expect(firstPlan.status).toBe("draft");
    expect(service.snapshot().plans.find((plan) => plan.id === firstPlan.id)?.status).toBe("superseded");
    expect(secondPlan.revision).toBe(2);
    expect(secondPlan.feedback).toBe("Make execution role clearer.");

    const confirmed = service.confirmMissionPlan({ missionId: mission.id, planId: secondPlan.id });

    expect(confirmed.confirmedPlanId).toBe(secondPlan.id);
    expect(service.getMissionPlan({ missionId: mission.id })?.status).toBe("confirmed");
  });

  it("uses confirmed MissionPlan for autopilot diagnosis hasPlan", async () => {
    const service = new InMemoryMissionService({
      llm: new FakeLlmAdapter(() => JSON.stringify({
        goal: "Run a mission",
        successMetrics: ["Mission is runnable"],
        phases: [{ name: "Plan", objective: "Define work", deliverables: ["work plan"], successCriteria: ["plan approved"] }],
        workstreams: [{ name: "Execution", objective: "Run work", requiredRole: "Execution Lead", responsibilities: ["execute"], firstTaskGoal: "Start first task" }],
        reportingLines: [{ fromRole: "Execution Lead", toRole: "Owner", cadence: "daily", purpose: "Report progress" }],
        scheduleRhythms: [{ name: "Daily check", cadence: "daily", ownerRole: "Owner", purpose: "Review progress" }],
        risks: [],
        checkpoints: ["daily owner review"],
      })),
    });
    const mission = await createConfirmedMission(service);

    const draft = await service.generateMissionPlan({ missionId: mission.id });
    expect(service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true }).signals.hasPlan).toBe(false);

    service.confirmMissionPlan({ missionId: mission.id, planId: draft.id });

    const diagnosis = service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true });
    expect(diagnosis.signals.hasPlan).toBe(true);
    expect(diagnosis.stage).not.toBe("missing_plan");
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "MissionPlan|hasPlan"
```

Expected: FAIL because service methods and snapshot `plans` do not exist.

- [ ] **Step 3: Add imports and snapshot fields**

Update `apps/server/src/mission-service.ts` imports:

```ts
import {
  createArtifact,
  createId,
  createMission,
  createReview,
  createScheduleRule,
  createTask,
  transitionTask,
  validateScheduleRule,
  type Artifact,
  type Mission,
  type MissionBrief,
  type MissionPlan,
  type Review,
  type ScheduleRule,
  type Task,
} from "@digitalagent/core";
import {
  buildMissionPlanMessages,
  buildOwnerSystemPrompt,
  buildConversationMessages,
  buildSummaryRequest,
  parseMissionPlanDraft,
} from "./owner/index.js";
```

Update `MissionSnapshot`:

```ts
export interface MissionSnapshot {
  missions: Mission[];
  plans: MissionPlan[];
  tasks: Task[];
  artifacts: Artifact[];
  reviews: Review[];
  executions: Execution[];
  agents: WarRoomAgent[];
  agentRelations: AgentRelation[];
  agentMessages: AgentMessage[];
  threads: ConversationThread[];
  taskEvents: WarRoomTaskEvent[];
  scheduleTriggerEvents: ScheduleTriggerEvent[];
  toolCalls: ToolCallRecord[];
  decisions: DecisionRecord[];
  knowledgeEntries: KnowledgeEntry[];
}
```

Add private store:

```ts
private readonly plans = new Map<string, MissionPlan>();
```

- [ ] **Step 4: Update runtime signal interface**

Change `AutopilotRuntimeSignals` so `hasPlan` is not supplied by API:

```ts
export interface AutopilotRuntimeSignals {
  hasExecutionRunner: boolean;
}
```

Update `assertAutopilotRuntimeSignals`:

```ts
function assertAutopilotRuntimeSignals(runtime: AutopilotRuntimeSignals): void {
  if (!runtime || typeof runtime !== "object") {
    throw new Error("Autopilot runtime signals must be provided");
  }
  if (typeof runtime.hasExecutionRunner !== "boolean") {
    throw new Error("Autopilot runtime signal hasExecutionRunner must be boolean");
  }
}
```

In `getAutopilotDiagnosis`, compute:

```ts
const confirmedPlan = this.getMissionPlan({ missionId });
```

and set:

```ts
hasPlan: confirmedPlan?.status === "confirmed",
```

- [ ] **Step 5: Implement service plan methods**

Add these methods before `getAutopilotDiagnosis`:

```ts
  async generateMissionPlan(input: { missionId: string; feedback?: string }): Promise<MissionPlan> {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    if (!mission.brief || mission.briefConfirmed !== true) {
      throw new Error("MissionBrief must be confirmed before generating MissionPlan");
    }
    if (!this.llm) {
      throw new Error("LLM is required for MissionPlan generation");
    }

    const response = await this.llm.call(buildMissionPlanMessages({
      brief: mission.brief,
      feedback: input.feedback,
    }));
    const draft = parseMissionPlanDraft(response.content);
    const existingPlans = [...this.plans.values()].filter((plan) => plan.missionId === mission.id);
    for (const plan of existingPlans) {
      if (plan.status === "draft") {
        this.plans.set(plan.id, { ...plan, status: "superseded" });
      }
    }
    const revision = existingPlans.length + 1;
    const plan: MissionPlan = {
      id: createId("plan"),
      missionId: mission.id,
      status: "draft",
      createdAt: new Date(),
      revision,
      ...(input.feedback ? { feedback: input.feedback } : {}),
      ...draft,
    };

    this.plans.set(plan.id, plan);
    const messageId = createId("msg");
    this.agentMessages.set(messageId, {
      id: messageId,
      missionId: mission.id,
      fromAgentId: this.agentByRole(mission.id, "owner").id,
      type: "task_plan",
      content: `Owner generated MissionPlan revision ${String(revision)}.`,
      createdAt: new Date().toISOString(),
    });
    this.persist();
    return plan;
  }

  confirmMissionPlan(input: { missionId: string; planId: string }): Mission {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const plan = this.plans.get(input.planId);
    if (!plan || plan.missionId !== mission.id) {
      throw new Error(`MissionPlan not found: ${input.planId}`);
    }
    if (plan.status !== "draft") {
      throw new Error("Only draft MissionPlan can be confirmed");
    }

    for (const candidate of this.plans.values()) {
      if (candidate.missionId === mission.id && candidate.status === "confirmed") {
        this.plans.set(candidate.id, { ...candidate, status: "superseded" });
      }
    }
    const confirmedPlan: MissionPlan = {
      ...plan,
      status: "confirmed",
      confirmedAt: new Date(),
    };
    this.plans.set(plan.id, confirmedPlan);
    const updatedMission: Mission = { ...mission, confirmedPlanId: plan.id };
    this.missions.set(mission.id, updatedMission);
    this.persist();
    return updatedMission;
  }

  getMissionPlan(input: { missionId: string }): MissionPlan | undefined {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    if (mission.confirmedPlanId) {
      const confirmed = this.plans.get(mission.confirmedPlanId);
      if (!confirmed || confirmed.status !== "confirmed") {
        throw new Error(`Confirmed MissionPlan not found: ${mission.confirmedPlanId}`);
      }
      return confirmed;
    }
    return [...this.plans.values()]
      .filter((plan) => plan.missionId === mission.id && plan.status === "draft")
      .sort((a, b) => b.revision - a.revision)[0];
  }
```

- [ ] **Step 6: Update snapshot persistence**

In `snapshot()` add:

```ts
plans: [...this.plans.values()],
```

In `loadFromFile()` add after missions:

```ts
for (const plan of stored.plans ?? []) {
  this.plans.set(plan.id, {
    ...plan,
    createdAt: new Date(plan.createdAt),
    ...(plan.confirmedAt ? { confirmedAt: new Date(plan.confirmedAt) } : {}),
  });
}
```

- [ ] **Step 7: Update existing tests that pass `hasPlan` runtime**

Replace calls like:

```ts
service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true, hasPlan: false })
```

with:

```ts
service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true })
```

For tests that need `hasPlan: true`, generate and confirm a plan first or create a helper:

```ts
async function createConfirmedPlan(service: InMemoryMissionService, missionId: string) {
  const plan = await service.generateMissionPlan({ missionId });
  service.confirmMissionPlan({ missionId, planId: plan.id });
  return plan;
}
```

- [ ] **Step 8: Run service tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "MissionPlan|diagnoses|hasPlan"
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat: store and confirm mission plans"
```

## Task 4: MissionPlan API

**Files:**
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/api.test.ts`

- [ ] **Step 1: Write API tests first**

Add tests to `apps/server/src/api.test.ts`:

```ts
  it("GET /api/missions/:id/plan returns no plan before generation", async () => {
    const { handler, missions } = createTestHandler();
    const mission = await missions.createMission({ goal: "Run a mission" });

    const response = await handler({ method: "GET", path: `/api/missions/${mission.id}/plan` });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  it("generates and confirms a MissionPlan via API", async () => {
    const { handler, missions } = createTestHandler({
      llm: new FakeLlmAdapter(() => JSON.stringify({
        goal: "Run a mission",
        successMetrics: ["Mission is runnable"],
        phases: [{ name: "Plan", objective: "Define work", deliverables: ["work plan"], successCriteria: ["plan approved"] }],
        workstreams: [{ name: "Execution", objective: "Run work", requiredRole: "Execution Lead", responsibilities: ["execute"], firstTaskGoal: "Start first task" }],
        reportingLines: [{ fromRole: "Execution Lead", toRole: "Owner", cadence: "daily", purpose: "Report progress" }],
        scheduleRhythms: [{ name: "Daily check", cadence: "daily", ownerRole: "Owner", purpose: "Review progress" }],
        risks: [],
        checkpoints: ["daily owner review"],
      })),
    });
    const mission = await createConfirmedMissionForApi(missions);

    const generateResponse = await handler({
      method: "POST",
      path: `/api/missions/${mission.id}/plan/generate`,
      body: { feedback: "Include analytics." },
    });
    expect(generateResponse.status).toBe(200);
    const plan = (generateResponse.body as { plan: { id: string; status: string; feedback: string } }).plan;
    expect(plan.status).toBe("draft");
    expect(plan.feedback).toBe("Include analytics.");

    const confirmResponse = await handler({
      method: "POST",
      path: `/api/missions/${mission.id}/plan/confirm`,
      body: { planId: plan.id },
    });
    expect(confirmResponse.status).toBe(200);
    expect((confirmResponse.body as { mission: { confirmedPlanId: string } }).mission.confirmedPlanId).toBe(plan.id);

    const diagnosisResponse = await handler({
      method: "GET",
      path: `/api/missions/${mission.id}/autopilot-diagnosis`,
    });
    expect((diagnosisResponse.body as { diagnosis: { signals: { hasPlan: boolean } } }).diagnosis.signals.hasPlan).toBe(true);
  });
```

If `createConfirmedMissionForApi` does not exist, add this local helper in `api.test.ts`:

```ts
async function createConfirmedMissionForApi(missions: InMemoryMissionService) {
  const mission = await missions.createMission({ goal: "Run a mission" });
  await missions.continueMission({ missionId: mission.id, message: "Audience is developers. Timeline is one month." });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = missions.snapshot().missions.find((candidate) => candidate.id === mission.id);
    if (current?.brief) {
      missions.confirmBrief({ missionId: mission.id });
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("brief should exist");
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts -t "MissionPlan|autopilot-diagnosis"
```

Expected: FAIL because routes do not exist and diagnosis API still passes `hasPlan`.

- [ ] **Step 3: Add plan API routes**

In `apps/server/src/api.ts`, before the autopilot diagnosis route, add:

```ts
    const planMatch = request.path.match(/^\/api\/missions\/([^/]+)\/plan(?:\/(generate|confirm))?$/);
    if (planMatch) {
      const missionId = planMatch[1];
      const action = planMatch[2];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      if (request.method === "GET" && !action) {
        const plan = deps.missions.getMissionPlan({ missionId });
        return json(200, plan ? { plan } : {});
      }
      if (request.method === "POST" && action === "generate") {
        const body = expectObject(request.body ?? {});
        const feedback = body.feedback === undefined ? undefined : expectString(body.feedback, "feedback");
        const plan = await deps.missions.generateMissionPlan({ missionId, feedback });
        return json(200, { plan, snapshot: deps.missions.snapshot() });
      }
      if (request.method === "POST" && action === "confirm") {
        const body = expectObject(request.body);
        const planId = expectString(body.planId, "planId");
        const mission = deps.missions.confirmMissionPlan({ missionId, planId });
        const plan = deps.missions.getMissionPlan({ missionId });
        return json(200, { mission, plan, snapshot: deps.missions.snapshot() });
      }
    }
```

Update autopilot diagnosis route:

```ts
const diagnosis = deps.missions.getAutopilotDiagnosis(missionId, {
  hasExecutionRunner: openclawHealth.available,
});
```

- [ ] **Step 4: Run API tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts -t "MissionPlan|autopilot-diagnosis"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api.ts apps/server/src/api.test.ts
git commit -m "feat: expose mission plan API"
```

## Task 5: MissionPlan Review UI

**Files:**
- Modify: `apps/server/public/app.js`
- Modify: `apps/server/public/styles.css`

- [ ] **Step 1: Extend empty snapshot**

In `apps/server/public/app.js`, update `emptySnapshot()`:

```js
function emptySnapshot() {
  return {
    missions: [],
    plans: [],
    tasks: [],
    artifacts: [],
    reviews: [],
    executions: [],
    agents: [],
    agentMessages: [],
    threads: [],
    taskEvents: [],
    scheduleTriggerEvents: [],
    toolCalls: [],
    decisions: [],
    agentRelations: [],
  };
}
```

- [ ] **Step 2: Add plan helpers**

Add near `currentMission()` helpers:

```js
function currentMissionPlan() {
  const mission = currentMission();
  if (!mission) return undefined;
  if (mission.confirmedPlanId) {
    return state.snapshot.plans.find((plan) => plan.id === mission.confirmedPlanId);
  }
  return [...state.snapshot.plans]
    .filter((plan) => plan.missionId === mission.id && plan.status === "draft")
    .sort((a, b) => b.revision - a.revision)[0];
}

function isPlanPending() {
  const mission = currentMission();
  return Boolean(mission && state.planActionMissionId === mission.id);
}
```

Add to `state`:

```js
planActionMissionId: undefined,
planRevisionOpen: false,
planRevisionFeedback: "",
planError: "",
```

- [ ] **Step 3: Render plan review block**

Add:

```js
function renderMissionPlanReview(data) {
  const plan = currentMissionPlan();
  const pending = isPlanPending();
  const error = state.planError ? `<p class="plan-error">${esc(state.planError)}</p>` : "";
  if (!plan) {
    return `
      <div class="mission-plan-card">
        <strong>Owner Agent · MissionPlan</strong>
        <p>MissionBrief 已确认。下一步需要 Owner 生成执行计划，再进入团队组建。</p>
        ${error}
        <button type="button" data-generate-plan ${pending ? "disabled" : ""}>${pending ? "正在生成计划..." : "生成执行计划"}</button>
      </div>
    `;
  }

  return `
    <div class="mission-plan-card">
      <strong>Owner Agent · MissionPlan</strong>
      <div class="plan-summary">
        <div><span>目标</span>${esc(plan.goal)}</div>
        <div><span>状态</span>${plan.status === "confirmed" ? "已确认" : `草稿 v${esc(String(plan.revision))}`}</div>
      </div>
      <div class="plan-section">
        <strong>阶段</strong>
        ${plan.phases.map((phase) => `<p>${esc(phase.name)}：${esc(phase.objective)}</p>`).join("")}
      </div>
      <div class="plan-section">
        <strong>工作流</strong>
        ${plan.workstreams.map((stream) => `<p>${esc(stream.requiredRole)}：${esc(stream.firstTaskGoal)}</p>`).join("")}
      </div>
      <div class="plan-section">
        <strong>节奏</strong>
        ${plan.scheduleRhythms.map((rhythm) => `<p>${esc(rhythm.name)} · ${esc(rhythm.cadence)} · ${esc(rhythm.ownerRole)}</p>`).join("")}
      </div>
      ${error}
      ${plan.status === "draft" ? `
        <div class="choice-row">
          <button type="button" data-confirm-plan="${esc(plan.id)}" ${pending ? "disabled" : ""}>确认 MissionPlan</button>
          <button type="button" data-toggle-plan-revision ${pending ? "disabled" : ""}>提出修改建议</button>
        </div>
        ${state.planRevisionOpen ? `
          <div class="plan-revision-box">
            <textarea id="plan-revision-feedback" rows="3" placeholder="告诉 Owner 你希望如何调整计划">${esc(state.planRevisionFeedback)}</textarea>
            <button type="button" data-submit-plan-revision="${esc(plan.id)}" ${pending ? "disabled" : ""}>重新生成计划</button>
          </div>
        ` : ""}
      ` : `
        <div class="choice-row">
          <button type="button" data-open-war-room>${data.tasks.length > 0 ? "进入作战室" : "创建作战室"}</button>
        </div>
      `}
    </div>
  `;
}
```

- [ ] **Step 4: Replace post-brief buttons**

In `renderMissionConversation`, replace:

```js
if (data.mission.briefConfirmed) {
  parts.push(`
    <div class="choice-row" style="margin-top: 12px;">
      <button type="button" data-open-war-room>${data.tasks.length > 0 ? "进入作战室" : "确认并创建作战室"}</button>
    </div>
  `);
}
```

with:

```js
if (data.mission.briefConfirmed) {
  parts.push(renderMissionPlanReview(data));
}
```

- [ ] **Step 5: Add UI event handlers**

In `wireEvents()`, add:

```js
  document.querySelectorAll("[data-generate-plan]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      state.planActionMissionId = mission.id;
      state.planError = "";
      renderAll();
      try {
        const result = await api(`/api/missions/${mission.id}/plan/generate`, { method: "POST", body: {} });
        state.snapshot = result.snapshot;
        state.planRevisionOpen = false;
        state.planRevisionFeedback = "";
      } catch (error) {
        state.planError = error instanceof Error ? error.message : String(error);
      } finally {
        state.planActionMissionId = undefined;
        renderAll();
      }
    });
  });

  document.querySelectorAll("[data-confirm-plan]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      const planId = button.getAttribute("data-confirm-plan");
      state.planActionMissionId = mission.id;
      state.planError = "";
      renderAll();
      try {
        const result = await api(`/api/missions/${mission.id}/plan/confirm`, { method: "POST", body: { planId } });
        state.snapshot = result.snapshot;
        await loadAutopilotDiagnosis(mission.id);
      } catch (error) {
        state.planError = error instanceof Error ? error.message : String(error);
      } finally {
        state.planActionMissionId = undefined;
        renderAll();
      }
    });
  });

  document.querySelectorAll("[data-toggle-plan-revision]").forEach((button) => {
    button.addEventListener("click", () => {
      state.planRevisionOpen = !state.planRevisionOpen;
      renderAll();
    });
  });

  const revisionTextarea = $("plan-revision-feedback");
  if (revisionTextarea) {
    revisionTextarea.addEventListener("input", (event) => {
      state.planRevisionFeedback = event.target.value;
    });
  }

  document.querySelectorAll("[data-submit-plan-revision]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      const feedback = state.planRevisionFeedback.trim();
      if (!feedback) {
        state.planError = "请输入修改建议。";
        renderAll();
        return;
      }
      state.planActionMissionId = mission.id;
      state.planError = "";
      renderAll();
      try {
        const result = await api(`/api/missions/${mission.id}/plan/generate`, { method: "POST", body: { feedback } });
        state.snapshot = result.snapshot;
        state.planRevisionOpen = false;
        state.planRevisionFeedback = "";
      } catch (error) {
        state.planError = error instanceof Error ? error.message : String(error);
      } finally {
        state.planActionMissionId = undefined;
        renderAll();
      }
    });
  });
```

- [ ] **Step 6: Add CSS**

Append to `apps/server/public/styles.css`:

```css
.mission-plan-card {
  display: grid;
  gap: 12px;
  margin-top: 12px;
  padding: 16px;
  border: 1px solid #d7dce2;
  border-radius: 8px;
  background: #ffffff;
}

.plan-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.plan-summary div,
.plan-section {
  display: grid;
  gap: 4px;
}

.plan-summary span,
.plan-section strong {
  font-size: 12px;
  color: #637083;
}

.plan-section p {
  margin: 0;
}

.plan-revision-box {
  display: grid;
  gap: 8px;
}

.plan-revision-box textarea {
  width: 100%;
  resize: vertical;
}

.plan-error {
  margin: 0;
  color: #b42318;
}
```

- [ ] **Step 7: Run typecheck/build**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/public/app.js apps/server/public/styles.css
git commit -m "feat: add mission plan review UI"
```

## Task 6: End-To-End Verification

**Files:**
- No code changes expected unless verification exposes bugs.

- [ ] **Step 1: Run targeted tests**

```bash
pnpm --filter @digitalagent/server test -- owner/mission-plan.test.ts mission-service.test.ts api.test.ts -t "MissionPlan|autopilot-diagnosis|hasPlan"
```

Expected: PASS.

- [ ] **Step 2: Run full server tests**

```bash
pnpm --filter @digitalagent/server test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Browser acceptance**

Start the server:

```bash
pnpm dev
```

Use the in-app browser at `http://127.0.0.1:3000/` and verify:

```text
Create Mission
-> Owner produces MissionBrief
-> Confirm MissionBrief
-> "生成执行计划" appears instead of immediate War Room creation
-> Generate MissionPlan
-> Plan summary appears with phases/workstreams/schedule rhythm
-> Confirm MissionPlan
-> War Room can be opened
-> Autopilot panel shows "计划已就绪" as OK and does not show missing_plan
```

- [ ] **Step 5: Stop dev server**

Stop the `pnpm dev` process before final handoff.

- [ ] **Step 6: Final commit if verification fixes were needed**

If bugs were fixed during verification:

```bash
git add apps/server/src apps/server/public packages/core/src
git commit -m "fix: complete mission plan acceptance"
```

If no files changed:

```bash
git status --short
```

Expected: clean worktree.

## Self-Review

- Spec coverage: The plan covers domain model, Owner prompt/parser, service plan lifecycle, API endpoints, UI review flow, diagnosis integration, tests, and browser acceptance.
- Scope check: HR plan-driven assembly, initial task generation, schedule bootstrap, and runner execution are intentionally excluded because they belong to Phase 4.6.2+.
- Type consistency: `MissionPlan`, `Mission.confirmedPlanId`, `MissionSnapshot.plans`, `generateMissionPlan`, `confirmMissionPlan`, and `getMissionPlan` are consistently named across tasks.
- Fastfail check: Parser failures throw, missing LLM throws, missing confirmed brief throws, and no fallback MissionPlan is allowed.
