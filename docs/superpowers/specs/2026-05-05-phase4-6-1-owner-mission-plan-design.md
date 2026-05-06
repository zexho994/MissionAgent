# Phase 4.6.1: Owner Workflow Prompts And MissionPlan — Product Design

## Overview

Phase 4.6.1 adds the missing planning layer between a confirmed `MissionBrief` and HR team assembly.

Phase 4.6.0 made the product honest: after a brief is confirmed, the War Room now reports `missing_plan`. This phase fixes that blocker by letting the Owner generate a structured `MissionPlan`, letting the user confirm or revise it, and making confirmed plans the source of truth for the next bootstrap steps.

This phase should not make the Mission run end to end. It should move a Mission through one specific gate:

```text
MissionBrief confirmed
-> Owner generates MissionPlan
-> user confirms MissionPlan
-> Autopilot diagnosis no longer reports missing_plan
```

## Current Problem

The current product jumps from `MissionBrief` confirmation toward War Room/HR activation too quickly.

Existing behavior:

- Owner can collect requirements and produce a `MissionBrief`.
- User can confirm the brief.
- The UI can enter or create the War Room after brief confirmation.
- HR assembly can run from the brief.
- Autopilot diagnosis always passes `hasPlan: false`, because no `MissionPlan` exists.

That means HR, initial tasks, reporting lines, schedules, and execution all lack a stable planning input. From first principles, this is the wrong dependency order. The team should not be assembled before the system knows what workstreams, roles, checkpoints, and cadence the mission requires.

## Goals

- Add a first-class `MissionPlan` domain model.
- Generate a plan after `MissionBrief` confirmation.
- Let users confirm the plan or request revisions.
- Store plan status and revision history in mission state.
- Make `AutopilotDiagnosis.signals.hasPlan` true only when the latest plan is confirmed.
- Prevent the autopilot path from treating unconfirmed plans as ready.
- Update the main UI so the user can review and confirm the plan before creating the War Room.
- Keep HR assembly plan-ready but do not rewrite HR to be fully plan-driven in this phase.

## Non-Goals

- Do not make HR fully plan-driven. That is Phase 4.6.2.
- Do not generate initial tasks from the plan. That is Phase 4.6.3.
- Do not add runner abstraction or automatic task execution.
- Do not bootstrap default schedules.
- Do not add complex plan version diff UI.
- Do not silently create a fallback plan if Owner planning fails.

## Recommended Approach

Use a narrow, explicit plan workflow owned by `InMemoryMissionService`.

The plan generation should use the existing Owner LLM adapter, but it should have its own prompt and parser instead of reusing `MissionBrief` parsing. A `MissionPlan` is not a conversation message; it is product state.

The service should expose explicit methods:

```ts
generateMissionPlan(input: { missionId: string; feedback?: string }): Promise<MissionPlan>
confirmMissionPlan(input: { missionId: string; planId: string }): Mission
getMissionPlan(input: { missionId: string }): MissionPlan | undefined
```

The API should expose this as read-only/get, generate/revise, and confirm endpoints. The UI should show a plan review surface after brief confirmation and before War Room creation.

Rejected alternatives:

- **Auto-confirm the generated plan:** Faster, but removes the user control loop. The user's original workflow explicitly includes plan confirmation.
- **Embed plan text only in Agent messages:** Easier, but later HR/task/schedule phases need typed data.
- **Jump straight to HR-driven planning:** This keeps the current dependency problem. HR should consume a confirmed plan, not invent one from the brief alone.

## Domain Model

Add to `packages/core/src/types.ts`:

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

Add `planId?: string` or `confirmedPlanId?: string` to `Mission`.

The service should keep plans in a `Map<string, MissionPlan>` and include them in `MissionSnapshot` so the frontend can render them without extra round trips. If snapshot size becomes a problem later, this can move to a dedicated endpoint, but 4.6.1 should favor simplicity and observability.

## Plan Generation Prompt

Add Owner planning prompt support under `apps/server/src/owner/`.

The prompt should include:

- The confirmed `MissionBrief`.
- The current mission goal, metrics, and constraints.
- Optional user revision feedback.
- A strict JSON schema.

The Owner must return only JSON. Parser failures should throw. Do not fall back to a hand-written plan.

Required output properties:

- `goal`
- `successMetrics`
- `phases`
- `workstreams`
- `reportingLines`
- `scheduleRhythms`
- `risks`
- `checkpoints`

Minimum validation:

- At least one phase.
- At least one workstream.
- Every workstream has `requiredRole`, `responsibilities`, and `firstTaskGoal`.
- At least one schedule rhythm.
- At least one checkpoint.
- `goal` and `successMetrics` must not be empty.

## State Rules

Plan lifecycle:

1. If a brief is not confirmed, plan generation must fail.
2. Generating a plan creates a `draft` plan.
3. If a previous draft exists, it becomes `superseded`.
4. Confirming a plan sets that plan to `confirmed`.
5. Confirming a new plan supersedes any older confirmed plan.
6. `Mission.confirmedPlanId` points to the latest confirmed plan.
7. `AutopilotDiagnosis.signals.hasPlan` is true only when `confirmedPlanId` points to a confirmed plan.

Important behavior:

- `confirmBrief` should not automatically confirm a plan.
- It may trigger plan generation only if the API/UI explicitly asks for it. For 4.6.1 MVP, prefer an explicit "生成执行计划" action so failures are visible.
- `activateMissionWithHR` should fail fast in the autopilot path if no confirmed plan exists. If legacy tests still need brief-only activation, keep that as a separate explicit legacy/manual path rather than hiding the missing plan.

## API Design

Add:

```text
GET /api/missions/:missionId/plan
POST /api/missions/:missionId/plan/generate
POST /api/missions/:missionId/plan/confirm
```

Responses:

```ts
GET -> { plan?: MissionPlan }
generate -> { plan: MissionPlan, snapshot: MissionSnapshot }
confirm -> { mission: Mission, plan: MissionPlan, snapshot: MissionSnapshot }
```

`generate` body:

```ts
{
  feedback?: string
}
```

`confirm` body:

```ts
{
  planId: string
}
```

Errors:

- Missing mission: throw `Mission not found`.
- Missing confirmed brief: throw `MissionBrief must be confirmed before generating MissionPlan`.
- Invalid plan output: throw with the parser validation message.
- Confirming a non-draft/non-current plan: throw.

## Main UI Experience

After `MissionBrief` is confirmed, the conversation panel should not jump straight to "确认并创建作战室".

Instead it should show a `MissionPlan` review block:

- If no plan exists: show "生成执行计划".
- If a draft plan exists: show structured plan summary and buttons:
  - "确认 MissionPlan"
  - "提出修改建议"
- If user chooses revision: allow a short feedback message and call plan generation again with feedback.
- If a plan is confirmed: show "进入作战室" or "创建作战室".

The plan block should prioritize scannability:

- Goal and success metrics.
- Phases.
- Workstreams and required roles.
- Reporting lines.
- Schedule rhythm.
- Risks/checkpoints.

Do not add rich diffing or large editing forms in 4.6.1. Revision is natural language feedback to Owner.

## War Room Experience

The War Room Autopilot panel should change through the new gate:

- Before plan confirmation: `缺少执行计划`.
- After plan confirmation: `计划已就绪` signal becomes OK.
- The next blocker should become whatever is actually next: team, initial tasks, runner, or schedule.

If the War Room is opened before a confirmed plan exists, it should still be diagnostic-only and should not hide the blocker.

## Testing Strategy

Service tests:

- Cannot generate plan before brief confirmation.
- Generates a valid draft plan from a confirmed brief.
- Parser rejects malformed Owner output.
- Regenerating with feedback supersedes previous draft.
- Confirming a draft plan sets `Mission.confirmedPlanId`.
- `getAutopilotDiagnosis` reports `hasPlan: true` only after confirmation.

API tests:

- `GET /plan` returns no plan initially.
- `POST /plan/generate` returns draft plan and snapshot.
- `POST /plan/confirm` confirms the plan.
- Invalid plan output returns an error.
- Autopilot diagnosis uses confirmed plan state instead of hard-coded `hasPlan: false`.

Frontend/browser acceptance:

```text
Create mission
-> Owner produces MissionBrief
-> Confirm MissionBrief
-> Generate MissionPlan
-> Review MissionPlan
-> Confirm MissionPlan
-> Open War Room
-> Autopilot panel no longer shows missing_plan
```

## Acceptance Criteria

- A confirmed brief can produce a structured `MissionPlan`.
- User can confirm the plan or request a revised plan.
- Confirmed plan is persisted in mission state and snapshot.
- `AutopilotDiagnosis.signals.hasPlan` reflects confirmed plan state.
- War Room advances past `missing_plan` after plan confirmation.
- HR activation is not treated as autopilot-ready without a confirmed plan.
- No fallback plan is generated when Owner output is invalid.

## Residual Risks

- The first plan schema may be too rigid or too broad. Keep parser validation strict, but allow wording flexibility inside fields.
- Existing tests and UI flows may assume brief confirmation directly unlocks War Room creation. The implementation plan must separate legacy/manual activation from the new autopilot path deliberately.
- Phase 4.6.2 will still need to update HR to consume the confirmed plan. Until then, a confirmed plan is a readiness gate and source of truth, but not yet fully used by team assembly.
