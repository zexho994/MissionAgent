# Phase 4.2: Recurring Task Templates — Product Design

## Overview

Phase 4.1 built the scheduler infrastructure (`MissionScheduler`, `ScheduleRule`, persistence, restore). The scheduler works — given rules, it ticks and creates Tasks. The hole is one layer above: **how those rules show up in a Mission in the first place**, and **what happens to them when the Mission ends**.

Today the chain looks intact on paper but breaks silently in practice:

1. HR's `proposeSchedulePlan()` LLM call exists in `apps/server/src/hr-agent.ts:235`, but it is gated behind `options.useLlmSchedule === true`. None of the production callers pass that flag, so the LLM-driven branch is dead code.
2. When the flag *is* set and the LLM returns garbage, `parseSchedulePlan()` silently filters it to `[]` and `proposeSchedulePlan()` swaps in the deterministic `designSchedulePlan()` fallback (`hr-agent.ts:249`). The caller never learns the LLM failed.
3. `MissionStatus` has values `active | paused | completed | cancelled`, but the only path that ever changes the status away from `"active"` is `deleteMission()` — which physically removes the Mission. There is no `completeMission` / `cancelMission` surface, so scheduled rules can keep firing on a "done" Mission until the user manually deletes it.
4. There is no canonical reusable template library. HR's LLM has to invent each periodic task from scratch every time — including bespoke cron expressions and bespoke success criteria — even for plain-vanilla "daily check" / "weekly report" rhythms.

Phase 4.2 fixes the chain end-to-end:

- HR's LLM is required to output a structured `schedulePlan`, and a missing/invalid response is a hard error rather than a silent empty array.
- A small library of `ScheduledTaskTemplate`s lives in core. HR can reference them by id (`templateId: "daily_metric_check"`) instead of reinventing common rhythms.
- Mission completion and cancellation become first-class operations that stop the scheduler and prevent further triggers.

## Current Problem (concrete)

| Symptom | File | Line | What's wrong |
|---|---|---|---|
| LLM schedule path never runs in prod | `apps/server/src/hr-agent.ts` | 218 | `brief && options?.useLlmSchedule === true` — no caller passes the flag |
| LLM failure swallowed silently | `apps/server/src/hr-agent.ts` | 249 | `return parsed.length > 0 ? parsed : fallback` |
| Parser silently drops invalid items | `apps/server/src/hr-agent.ts` | 793 | `flatMap` over filtered items returns `[]` if all invalid |
| No mission completion API | `apps/server/src/mission-service.ts` | — | Status `"completed"` is unreachable |
| No mission cancellation API | `apps/server/src/mission-service.ts` | — | Status `"cancelled"` is unreachable |
| Scheduler keeps firing post-end | `apps/server/src/mission-scheduler.ts` | 47 | `start()` only respects `enabled`, not Mission status |
| No template registry | — | — | Every HR run re-invents "daily check" from scratch |

## Goals

- **G1.** When HR proposes a team and a `MissionBrief` is present, the schedule plan must come from the LLM. A failure of that call surfaces as a structured error to the caller, not a silent fallback.
- **G2.** HR's prompt explicitly enumerates required fields, allowed cron syntax, and the option to reference a template by id. The parser rejects items missing required fields rather than dropping them.
- **G3.** Core ships a `ScheduledTaskTemplate` registry with at least four built-ins: daily metric check, weekly team report, biweekly strategy retrospective, engagement-drop alert (condition trigger). HR's prompt advertises the registry; HR's LLM may pick `templateId` or invent custom items.
- **G4.** When the negotiation is confirmed, items that reference a `templateId` expand into full `ScheduleRule`s using the registry. Custom items continue to work as before.
- **G5.** `InMemoryMissionService` exposes `completeMission(id)` and `cancelMission(id)`. Both transition Mission status, stop the scheduler, persist, and emit a War Room message. The API surfaces `POST /api/missions/:id/complete` and `POST /api/missions/:id/cancel`.
- **G6.** Restoring schedulers (`restoreSchedulers()`) only starts schedulers for `active` missions. `completed` and `cancelled` missions never have running schedulers, even after process restart.
- **G7.** End-to-end coverage: an LLM stub that returns a valid schedule plan results in `ScheduleRule`s that are persisted, that `MissionScheduler.start()` accepts, and that — when the fake clock advances — actually create `Task`s. A second test verifies that completing the mission halts the scheduler.

## Non-Goals

- **Not** unifying `SchedulePlanItem` (HR's intermediate output), `ScheduleTemplateRequest` (the user-driven manual template API), and the new `ScheduledTaskTemplate` (the library). They serve different layers and the cleanup is a follow-up. Phase 4.2 only adds the third one.
- **Not** changing the trigger model. `CronTrigger | ConditionTrigger` stays as-is.
- **Not** introducing a separate scheduler-config file. The template registry lives in code (`packages/core/src/schedule-templates.ts`), not JSON.
- **Not** adding milestone / checkpoint concepts to Mission. That belongs to Phase 6.
- **Not** auto-completing missions based on success metrics. Completion is explicit (user or Owner-agent driven). The cleanup hook just has to do the right thing once the transition happens.
- **Not** retrying failed LLM schedule generation inside `proposeTeam`. Retry policy belongs to the negotiation manager and is outside this scope; the spec only requires the error to be surfaced.

## Architecture Decisions

### AD1. Strict LLM schedule generation, structured error

`proposeTeam(missionId, roleSpecs, brief?, options?)` gains a unified `scheduleStrategy: "auto" | "llm" | "deterministic"` option:

- `"auto"` (new default) — `"llm"` when `brief` is provided, `"deterministic"` otherwise.
- `"llm"` — call the LLM. On any of: LLM throws, no JSON found, empty array, all items fail validation → throw `SchedulePlanGenerationError`.
- `"deterministic"` — use `designSchedulePlan()` (existing rule-based fallback).

The legacy `useLlmSchedule?: boolean` option is removed (only used in tests, easy migration).

`SchedulePlanGenerationError` lives in core (`packages/core/src/schedule.ts`) and carries:

```typescript
export class SchedulePlanGenerationError extends Error {
  constructor(
    public readonly reason:
      | "llm_call_failed"
      | "no_json_in_response"
      | "empty_plan"
      | "all_items_invalid",
    public readonly details: { rawResponse?: string; itemErrors?: string[] },
    cause?: unknown,
  ) {
    super(`Schedule plan generation failed: ${reason}`);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
```

The negotiation manager catches this error and emits a `team_planning_failed` War Room message before re-throwing. This keeps the user informed without hiding the failure.

### AD2. Template registry in core, prompt-advertised, expanded at confirm time

`ScheduledTaskTemplate` (new in `packages/core/src/types.ts`):

```typescript
export interface ScheduledTaskTemplate {
  id: string;                            // "daily_metric_check"
  name: string;                          // "Daily metric check"
  description: string;                   // shown to HR's LLM as catalog
  applicableRolePatterns: string[];      // regex strings — which roles fit
  trigger: ScheduleTrigger;              // pre-baked
  taskTemplate: {
    titleTemplate: string;               // "{{role.name}} 每日数据检查"
    contract: TaskContract;
    priority: "low" | "normal" | "high";
  };
  maxConcurrent: number;
  metadata: Record<string, unknown>;     // includes { source: "builtin", templateId }
}
```

Built-in registry in `packages/core/src/schedule-templates.ts`:

| Template id | Trigger | Default cron | Applicable roles |
|---|---|---|---|
| `daily_metric_check` | cron | `0 9 * * *` (UTC) | analyst, data, monitor, research |
| `weekly_team_report` | cron | `0 10 * * 1` | manager, lead, owner, coordinator |
| `biweekly_strategy_retrospective` | cron | `0 10 */14 * *` | content, strategist, planner, manager |
| `engagement_drop_alert` | condition | — | analyst, data, monitor |

`SchedulePlanItem` gains an optional `templateId?: string`. When set:

- Owner of the item still picks `assigneeRole`, `taskDescription` (used in title), and an optional `cronExpression` override.
- The other fields (contract structure, priority, default cron) come from the template.
- `negotiation-manager.createScheduleRulesFromProposal()` resolves `templateId` via the registry. Unknown id → log warning, fall back to inventing the ScheduleRule from the literal item fields.

The HR system prompt is extended with a "Template catalog" section listing the built-ins so the LLM can pick a known id rather than inventing a contract every time.

### AD3. Mission lifecycle: explicit terminal transitions

Two new core helpers in `packages/core/src/mission.ts`:

```typescript
export function completeMission(mission: Mission): Mission {
  if (mission.status === "completed") return mission;
  if (mission.status === "cancelled") {
    throw new Error("Cannot complete a cancelled mission");
  }
  return { ...mission, status: "completed" };
}

export function cancelMission(mission: Mission): Mission {
  if (mission.status === "cancelled") return mission;
  if (mission.status === "completed") {
    throw new Error("Cannot cancel a completed mission");
  }
  return { ...mission, status: "cancelled" };
}
```

Service-layer methods in `InMemoryMissionService`:

- `completeMission(missionId, summary?: string)` — apply the transition, stop scheduler, append a `mission_completed` War Room message, persist.
- `cancelMission(missionId, reason?: string)` — apply the transition, stop scheduler, append a `mission_cancelled` message, persist.

Both reject calls on a Mission already in a terminal state by re-using the core helpers' guards. Both leave Mission data (tasks, artifacts, agents) intact — only the scheduler is shut down.

`addScheduleRule()` rejects new rules on terminal Missions:

```typescript
if (mission.status === "completed" || mission.status === "cancelled") {
  throw new Error(`Cannot add schedule rule to ${mission.status} mission`);
}
```

`triggerScheduleRule()` and `triggerNextScheduleRule()` similarly reject.

### AD4. Restore on startup respects terminal status

`restoreSchedulers()` already guards on `mission.status === "active"`. The change is conceptual only — it now means something concrete because terminal status is reachable.

### AD5. New AgentMessage types

Add to the message-type union (`apps/server/src/mission-service.ts:149`):

- `mission_completed`
- `mission_cancelled`
- `team_planning_failed`

UI rendering can be a follow-up; the server-side types are needed now so persisted messages round-trip.

## Domain Types Summary

```typescript
// packages/core/src/types.ts (additions)
export interface ScheduledTaskTemplate { /* see AD2 */ }

// packages/core/src/schedule.ts (additions)
export class SchedulePlanGenerationError extends Error { /* see AD1 */ }

// packages/core/src/mission.ts (additions)
export function completeMission(mission: Mission): Mission;
export function cancelMission(mission: Mission): Mission;

// packages/core/src/schedule-templates.ts (new file)
export const BUILTIN_SCHEDULE_TEMPLATES: ScheduledTaskTemplate[];
export function findTemplateById(id: string): ScheduledTaskTemplate | undefined;
export function describeTemplatesForPrompt(): string;

// apps/server/src/hr-agent.ts (modification)
export interface SchedulePlanItem {
  // existing fields...
  templateId?: string;          // NEW — references a ScheduledTaskTemplate
}

// apps/server/src/mission-service.ts (additions)
class InMemoryMissionService {
  completeMission(missionId: string, summary?: string): Mission;
  cancelMission(missionId: string, reason?: string): Mission;
}
```

## Flows

### Flow A: Negotiation confirm → scheduled rules

```
Owner /confirm
   └─> NegotiationManager.confirmNegotiation
         ├─ proposal already contains schedulePlan from LLM (strict path)
         ├─ createScheduleRulesFromProposal
         │    ├─ for each item with templateId → expand from registry
         │    └─ for each custom item → existing path
         ├─ mission.scheduleRules = expanded rules
         └─ MissionService.confirmNegotiation
               └─ scheduler.start(mission.scheduleRules)
```

### Flow B: LLM returns invalid schedule

```
NegotiationManager.startNegotiation
   └─> hrAgent.proposeTeam(brief, scheduleStrategy: "auto")
         └─ proposeSchedulePlan (LLM)
               └─ throws SchedulePlanGenerationError
   ├─ catch: append "team_planning_failed" message
   └─ re-throw → API returns 500 with structured detail
```

### Flow C: Mission completion → scheduler stops

```
POST /api/missions/:id/complete
   └─> MissionService.completeMission
         ├─ mission = completeMission(mission)   // pure helper
         ├─ this.schedulers.get(id)?.stop()
         ├─ this.schedulers.delete(id)
         ├─ appendMessage("mission_completed")
         └─ persist
```

## Acceptance Criteria

1. **AC1.** Running `pnpm --filter @digitalagent/server vitest run src/hr-agent.test.ts` passes a new test that asserts: when the LLM returns `[]` and `scheduleStrategy: "llm"` is used, `proposeTeam` throws `SchedulePlanGenerationError` with `reason: "empty_plan"`.

2. **AC2.** Running the same test file passes a new test that asserts: with `scheduleStrategy: "auto"` and a brief, the LLM is called exactly once and the deterministic `designSchedulePlan` is *not* invoked.

3. **AC3.** A new test in `apps/server/src/negotiation-manager.test.ts` (or end-to-end test in `mission-service.test.ts`) asserts: a stubbed LLM returning a valid plan with one `templateId: "daily_metric_check"` item results in a `ScheduleRule` registered on the Mission whose `taskTemplate.contract.objective` matches the template (not the raw item).

4. **AC4.** A new test asserts: after `completeMission(id)`, the scheduler for that Mission is no longer in `service.snapshot()`'s active scheduler set, and a fake-clock advance does not produce new tasks for that Mission.

5. **AC5.** A new test asserts: after `cancelMission(id)`, calling `addScheduleRule` on the same Mission throws.

6. **AC6.** Manual: `pnpm dev`, create a Mission, run through negotiation with the real LLM (or a stub fixture), confirm — the resulting Mission has at least one `ScheduleRule` whose metadata contains `source: "builtin"` if the LLM used a `templateId`.

7. **AC7.** `pnpm typecheck` passes — no `useLlmSchedule` references remain; `scheduleStrategy` is the only schedule-control parameter.

8. **AC8.** `ROADMAP.md` Phase 4.2 checkboxes are marked complete: P0 LLM strict output, P0 e2e test, ScheduledTaskTemplate, common patterns, mission auto-register on confirm, mission complete/cancel cleanup.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Existing HR tests break because LLM is now called by default | Migration: tests that don't want the LLM call pass `scheduleStrategy: "deterministic"` explicitly; spec lists the affected tests |
| LLM unreliability blocks negotiation in production | The negotiation manager already has an escalation path for max-rounds; reuse it for `SchedulePlanGenerationError` so the user sees a clear "couldn't propose a schedule, please try again" message |
| Built-in template cron uses UTC but Chinese users want local time | Templates store the cron in their natural timezone (`"Asia/Shanghai"`); the existing `config.scheduler.defaultTimezone` already handles per-instance overrides |
| Adding mission status transitions invalidates persisted store | The persisted shape doesn't change — only the `status` field's set of observed values broadens. Store-loader already accepts the full `MissionStatus` union |

## Out-of-Scope Follow-ups

- Unify `SchedulePlanItem` / `ScheduleTemplateRequest` / `ScheduledTaskTemplate` (cleanup phase)
- Auto-completion of Missions based on success-metric satisfaction (Phase 5 strategy adaptation)
- Template versioning and migration (when templates evolve)
- UI surface for browsing the template catalog from War Room (Phase 4.5)
