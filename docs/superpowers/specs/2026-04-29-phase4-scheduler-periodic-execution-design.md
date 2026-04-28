# Phase 4: Scheduler & Periodic Execution Specification

## Overview

Phase 4 adds mission-level scheduling so long-running Missions can create tasks automatically from time rules and condition rules. The system must support daily checks, weekly reports, biweekly reviews, and future external metric triggers without depending on a hosted queue in the first version.

This spec is written for an implementation agent. It assumes Phase 3 conversation types and `InMemoryMissionService` are present.

## Goals

- Register, update, cancel, persist, and restore mission schedules.
- Trigger schedules into real `Task` records assigned to the correct `WarRoomAgent`.
- Define reusable `ScheduledTaskTemplate` records for common mission rhythms.
- Clean up schedules when a mission is completed or cancelled.
- Add condition triggers for metric-based events, with an explicit external data adapter boundary.

## Non-Goals

- Do not implement real Xiaohongshu or third-party metric ingestion in Phase 4.
- Do not add distributed locking or multi-process coordination. The current server runs a single `InMemoryMissionService`.
- Do not auto-run OpenClaw when a scheduled task is created. Phase 4 creates and assigns tasks; execution remains an explicit later step.
- Do not silently ignore invalid schedule definitions. Invalid cron, missing mission, missing role, and missing template fields must throw.

## Architecture Decision

Use an internal scheduler owned by `InMemoryMissionService`.

Reasoning: the current app already persists mission state through a JSON store, has no database, and has a single server process. Adding BullMQ, Temporal, or a database-backed job system now would be infrastructure before product proof. The correct Phase 4 design is a small deterministic scheduler service with a pluggable clock for tests and a clean future replacement boundary.

The scheduler has three layers:

1. Core domain types in `packages/core/src/types.ts`.
2. Server scheduler logic in `apps/server/src/scheduler-service.ts`.
3. Mission lifecycle/API integration in `apps/server/src/mission-service.ts` and `apps/server/src/api.ts`.

## File Plan

- Modify `packages/core/src/types.ts`
  - Add schedule, template, trigger, and clock-facing domain types.
- Create `packages/core/src/schedule.ts`
  - Add constructors and validators for scheduled task templates, schedule registrations, and condition triggers.
- Modify `packages/core/src/index.ts`
  - Export `schedule.ts`.
- Create `packages/core/src/schedule.test.ts`
  - Unit tests for fast-fail validation and schedule object creation.
- Create `apps/server/src/schedule-rules.ts`
  - Parse a strict cron subset and compute next run times.
- Create `apps/server/src/schedule-rules.test.ts`
  - Unit tests for supported cron expressions and invalid expressions.
- Create `apps/server/src/scheduler-service.ts`
  - Own in-memory schedule ticking, registration, cancellation, and task creation callbacks.
- Create `apps/server/src/scheduler-service.test.ts`
  - Unit tests with fake clock and callback spies.
- Modify `apps/server/src/mission-service.ts`
  - Store schedules/templates/triggers in snapshot.
  - Initialize scheduler after loading persisted state.
  - Add public schedule APIs.
  - Register default templates on mission activation.
  - Cancel schedules on mission completion/cancellation.
- Modify `apps/server/src/api.ts`
  - Add schedule and trigger endpoints.
- Modify `apps/server/src/api.test.ts`
  - API tests for schedule CRUD and condition trigger evaluation.
- Modify `apps/server/src/server.ts`
  - Start scheduler ticking when server boots.
  - Stop scheduler on process shutdown if implemented as a timer.
- Modify `apps/server/config/agent-system.json`
  - Add default Phase 4 schedule templates.
- Modify `apps/server/src/system-config.ts`
  - Validate schedule template config.

## Domain Types

Add these types to `packages/core/src/types.ts`.

```typescript
export type ScheduleStatus = "active" | "paused" | "cancelled";

export type ScheduleTriggerRule =
  | {
      type: "cron";
      expression: string;
      timezone: string;
    }
  | {
      type: "interval";
      everyMinutes: number;
    };

export interface ScheduledTaskTemplate {
  id: string;
  missionId?: string;
  name: string;
  description: string;
  triggerRule: ScheduleTriggerRule;
  taskTitleTemplate: string;
  taskObjectiveTemplate: string;
  successCriteria: string[];
  inputTemplate: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  assignToRole: string;
  approvalRequired: boolean;
  enabled: boolean;
}

export interface ScheduleRegistration {
  id: string;
  missionId: string;
  templateId: string;
  status: ScheduleStatus;
  triggerRule: ScheduleTriggerRule;
  assignToAgentId: string;
  lastRunAt?: string;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ConditionOperator = "lt" | "lte" | "gt" | "gte" | "eq";

export interface ConditionTriggerRule {
  metricName: string;
  operator: ConditionOperator;
  threshold: number;
  compareTo?: "absolute" | "previous";
}

export interface ConditionTrigger {
  id: string;
  missionId: string;
  name: string;
  rule: ConditionTriggerRule;
  sourceAdapter: string;
  detectorAgentId: string;
  notifyAgentIds: string[];
  status: "active" | "paused" | "cancelled";
  lastEvaluatedAt?: string;
  lastTriggeredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MetricSnapshot {
  missionId: string;
  sourceAdapter: string;
  metricName: string;
  value: number;
  capturedAt: string;
}
```

Add constructors to `packages/core/src/schedule.ts`:

```typescript
export function createScheduledTaskTemplate(input: Omit<ScheduledTaskTemplate, "id">): ScheduledTaskTemplate
export function createScheduleRegistration(input: Omit<ScheduleRegistration, "id" | "createdAt" | "updatedAt">): ScheduleRegistration
export function createConditionTrigger(input: Omit<ConditionTrigger, "id" | "createdAt" | "updatedAt">): ConditionTrigger
export function evaluateConditionTrigger(trigger: ConditionTrigger, current: MetricSnapshot, previous?: MetricSnapshot): boolean
```

Validation rules:

- `name`, `description`, `taskTitleTemplate`, `taskObjectiveTemplate`, `assignToRole`, `timezone`, and cron `expression` must be non-empty.
- `successCriteria` must contain at least one non-empty string.
- `interval.everyMinutes` must be a positive integer.
- `ConditionTrigger.notifyAgentIds` must not be empty.
- `compareTo: "previous"` requires a previous metric snapshot when evaluating; otherwise throw.
- Mismatched `missionId`, `sourceAdapter`, or `metricName` between trigger and metric snapshot throws.

## Cron Support

Create `apps/server/src/schedule-rules.ts`.

Phase 4 should support a strict five-field cron subset:

```text
minute hour dayOfMonth month dayOfWeek
```

Supported field values:

- `*`
- A single integer in the valid range.
- A comma-separated list of integers.
- `*/n` for intervals.

Supported examples:

- `0 9 * * *` means every day at 09:00.
- `0 10 * * 1` means every Monday at 10:00.
- `0 16 */14 * *` means every 14 days at 16:00.
- `*/30 * * * *` means every 30 minutes.

Do not support ranges like `1-5`, named days like `MON`, seconds, or Quartz extensions. Throw `Unsupported cron expression: <expression>` when unsupported syntax appears. This is intentional: partial cron must fail fast instead of looking like full cron.

API:

```typescript
export function validateCronExpression(expression: string): void
export function nextRunAfter(rule: ScheduleTriggerRule, after: Date): Date
export function isDue(nextRunAt: string, now: Date): boolean
```

Timezone in Phase 4 is stored and validated as non-empty, but calculation may use server local time until a timezone library is introduced. The spec should document this limitation in code comments near `nextRunAfter`.

## Scheduler Service

Create `apps/server/src/scheduler-service.ts`.

```typescript
export interface SchedulerClock {
  now(): Date;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SchedulerStore {
  listActiveSchedules(): ScheduleRegistration[];
  getTemplate(templateId: string): ScheduledTaskTemplate | undefined;
  getMission(missionId: string): Mission | undefined;
  getAgent(agentId: string): WarRoomAgent | undefined;
  createTaskFromSchedule(input: {
    schedule: ScheduleRegistration;
    template: ScheduledTaskTemplate;
    runAt: string;
  }): Task;
  updateSchedule(registration: ScheduleRegistration): void;
  appendMessage(message: Omit<AgentMessage, "id" | "createdAt">): AgentMessage;
  persist(): void;
}

export class SchedulerService {
  constructor(deps: {
    clock: SchedulerClock;
    store: SchedulerStore;
    tickMs: number;
  });

  start(): void;
  stop(): void;
  tick(): void;
}
```

Behavior:

- `start()` throws if called twice.
- `stop()` is idempotent.
- `tick()` reads active schedules whose `nextRunAt <= now`.
- For each due schedule:
  - Load mission, template, and agent.
  - If any is missing, throw. Do not skip silently.
  - Create one task from the template.
  - Append an `agent_notify` message from `"scheduler"` to the assigned agent.
  - Set `lastRunAt = now.toISOString()`.
  - Set `nextRunAt = nextRunAfter(schedule.triggerRule, now).toISOString()`.
  - Persist once after processing all due schedules.
- If one due schedule fails, let the error surface in tests. In server timer mode, catch at the timer boundary in `server.ts` and log the error so the process can keep serving requests.

## Mission Service Integration

Add private maps:

```typescript
private readonly scheduledTaskTemplates = new Map<string, ScheduledTaskTemplate>();
private readonly scheduleRegistrations = new Map<string, ScheduleRegistration>();
private readonly conditionTriggers = new Map<string, ConditionTrigger>();
private readonly metricSnapshots = new Map<string, MetricSnapshot[]>();
private scheduler: SchedulerService | undefined;
```

Extend `MissionSnapshot`:

```typescript
scheduledTaskTemplates: ScheduledTaskTemplate[];
scheduleRegistrations: ScheduleRegistration[];
conditionTriggers: ConditionTrigger[];
metricSnapshots: MetricSnapshot[];
```

Public methods:

```typescript
registerScheduleTemplate(input: Omit<ScheduledTaskTemplate, "id">): ScheduledTaskTemplate
registerMissionSchedule(input: {
  missionId: string;
  templateId: string;
}): ScheduleRegistration
updateSchedule(input: {
  scheduleId: string;
  status?: ScheduleStatus;
  triggerRule?: ScheduleTriggerRule;
}): ScheduleRegistration
cancelSchedule(input: { scheduleId: string }): ScheduleRegistration
listSchedules(input: { missionId: string }): ScheduleRegistration[]
startScheduler(): void
stopScheduler(): void
evaluateConditionTrigger(input: {
  triggerId: string;
  metric: MetricSnapshot;
  previousMetric?: MetricSnapshot;
}): boolean
registerConditionTrigger(input: Omit<ConditionTrigger, "id" | "createdAt" | "updatedAt">): ConditionTrigger
```

Task creation from schedule:

```typescript
const task = createTask({
  missionId: schedule.missionId,
  title: renderScheduleTemplate(template.taskTitleTemplate, { missionGoal: mission.goal, runAt }),
  dependencies: [],
  contract: {
    objective: renderScheduleTemplate(template.taskObjectiveTemplate, { missionGoal: mission.goal, runAt }),
    input: {
      ...template.inputTemplate,
      scheduleId: schedule.id,
      templateId: template.id,
      scheduledRunAt: runAt,
    },
    outputSchema: { ...template.outputSchema },
    successCriteria: [...template.successCriteria],
  },
  approvalRequired: template.approvalRequired,
});
```

After creating the task, assign it to the scheduled agent by applying the existing task state machine:

```typescript
const ready = transitionTask(task, { type: "contract.completed" });
const queued = transitionTask(ready, { type: "dependencies.met" });
const running = transitionTask(queued, { type: "worker.assigned", agentInstanceId: schedule.assignToAgentId });
```

This means a scheduled task appears as `running` and assigned, but no external tool execution has started. That is acceptable for Phase 4 because execution remains explicit. Do not create an `Execution` record inside the scheduler.

Agent status update:

- Assigned agent status becomes `"idle"` unless it was `"running"`.
- `currentTaskId` becomes the scheduled task id only if the agent is not already running another task.
- `lastAction` becomes `Scheduled task created: <task.title>`.

## Default Templates

Add to `apps/server/config/agent-system.json`:

```json
"scheduler": {
  "tickMs": 60000,
  "defaultTemplates": [
    {
      "name": "Daily data check",
      "description": "Daily metric check for long-running growth missions.",
      "triggerRule": { "type": "cron", "expression": "0 9 * * *", "timezone": "Asia/Shanghai" },
      "taskTitleTemplate": "Daily data check - {{missionGoal}}",
      "taskObjectiveTemplate": "Check the latest mission metrics for {{missionGoal}} and report anomalies.",
      "successCriteria": ["Metric snapshot is reviewed", "Anomalies are reported with evidence", "Next action is recommended"],
      "inputTemplate": { "cadence": "daily", "kind": "metric_check" },
      "outputSchema": { "summary": "string", "metrics": "array", "risks": "array", "recommendations": "array" },
      "assignToRole": "researcher",
      "approvalRequired": false,
      "enabled": true
    },
    {
      "name": "Weekly topic meeting",
      "description": "Weekly planning task for content missions.",
      "triggerRule": { "type": "cron", "expression": "0 10 * * 1", "timezone": "Asia/Shanghai" },
      "taskTitleTemplate": "Weekly topic meeting - {{missionGoal}}",
      "taskObjectiveTemplate": "Review last week's progress for {{missionGoal}} and propose this week's content topics.",
      "successCriteria": ["Last week is summarized", "This week's topics are proposed", "Risks and dependencies are listed"],
      "inputTemplate": { "cadence": "weekly", "kind": "planning" },
      "outputSchema": { "retrospective": "string", "topics": "array", "risks": "array" },
      "assignToRole": "content_strategist",
      "approvalRequired": false,
      "enabled": true
    },
    {
      "name": "Biweekly strategy review",
      "description": "Biweekly strategic review for long-running missions.",
      "triggerRule": { "type": "cron", "expression": "0 16 */14 * *", "timezone": "Asia/Shanghai" },
      "taskTitleTemplate": "Biweekly strategy review - {{missionGoal}}",
      "taskObjectiveTemplate": "Review whether the strategy for {{missionGoal}} should change based on accumulated evidence.",
      "successCriteria": ["Progress toward success metrics is assessed", "Strategy changes are justified", "Owner decision points are listed"],
      "inputTemplate": { "cadence": "biweekly", "kind": "strategy_review" },
      "outputSchema": { "progress": "string", "decisionPoints": "array", "strategyChanges": "array" },
      "assignToRole": "owner",
      "approvalRequired": false,
      "enabled": true
    }
  ]
}
```

Modify `AgentSystemConfig` to include this shape and validate every default template using `createScheduledTaskTemplate`.

Mission activation behavior:

- After `activateMission` or `activateMissionWithHR` creates the team, call `registerDefaultSchedulesForMission(mission.id)`.
- Register only templates where `enabled === true`.
- Resolve `assignToRole` by exact `agent.role` first. If no exact match, use the same capability matching idea only for these roles:
  - `researcher` can match roles containing `research` or `analyst`.
  - `content_strategist` can match roles containing `content` or `strategist`.
  - `owner` must match exact owner.
- If no agent can be resolved, throw. Do not register a schedule against a fake agent.
- If a mission already has schedules, do not duplicate them on re-activation.

Mission cleanup behavior:

- Add a public method `updateMissionStatus({ missionId, status })` if no status update method exists yet.
- When status becomes `"completed"` or `"cancelled"`, mark all active schedules and condition triggers for that mission as `"cancelled"`.
- When status becomes `"paused"`, mark schedules `"paused"`.
- When status returns to `"active"`, do not automatically resume paused schedules. Require explicit `updateSchedule` to avoid surprise work.

## Condition Triggers

Phase 4 condition triggers are data-model and evaluation plumbing only.

External adapter interface:

```typescript
export interface ExternalMetricAdapter {
  name: string;
  fetchMetric(input: {
    missionId: string;
    metricName: string;
  }): Promise<MetricSnapshot>;
}
```

Do not implement concrete social media adapters in Phase 4.

When `evaluateConditionTrigger` returns true:

- Update `lastEvaluatedAt` and `lastTriggeredAt`.
- Append the metric snapshot to `metricSnapshots`.
- Append an `agent_notify` message:
  - `fromAgentId`: detector agent id
  - `mentionedAgentIds`: notify agent ids
  - `content`: `Condition triggered: <name>. <metricName> <operator> <threshold>, current value <value>.`
- If Phase 3 bus is configured with LLM, dispatch a `BusEvent` of type `agent_notify`.
- Do not create a task automatically from condition triggers in Phase 4. Notification is enough. Phase 5 owns strategy adaptation.

## API Endpoints

Add to `apps/server/src/api.ts`:

```text
GET  /api/missions/:missionId/schedules
POST /api/missions/schedules
PATCH /api/missions/schedules/:scheduleId
DELETE /api/missions/schedules/:scheduleId

POST /api/missions/condition-triggers
POST /api/missions/condition-triggers/:triggerId/evaluate
```

Request/response details:

`GET /api/missions/:missionId/schedules`

```json
{ "schedules": [] }
```

`POST /api/missions/schedules`

```json
{
  "missionId": "mission_1",
  "templateId": "schedule_template_1"
}
```

Returns:

```json
{ "schedule": {}, "snapshot": {} }
```

`PATCH /api/missions/schedules/:scheduleId`

```json
{
  "status": "paused",
  "triggerRule": { "type": "cron", "expression": "0 8 * * *", "timezone": "Asia/Shanghai" }
}
```

`DELETE /api/missions/schedules/:scheduleId`

Returns the cancelled schedule and snapshot.

`POST /api/missions/condition-triggers`

```json
{
  "missionId": "mission_1",
  "name": "Engagement drop alert",
  "rule": { "metricName": "engagementRate", "operator": "lte", "threshold": -20, "compareTo": "previous" },
  "sourceAdapter": "manual",
  "detectorAgentId": "agent_3",
  "notifyAgentIds": ["agent_1"]
}
```

`POST /api/missions/condition-triggers/:triggerId/evaluate`

```json
{
  "metric": {
    "missionId": "mission_1",
    "sourceAdapter": "manual",
    "metricName": "engagementRate",
    "value": -31,
    "capturedAt": "2026-04-29T09:00:00.000Z"
  },
  "previousMetric": {
    "missionId": "mission_1",
    "sourceAdapter": "manual",
    "metricName": "engagementRate",
    "value": 0,
    "capturedAt": "2026-04-28T09:00:00.000Z"
  }
}
```

Returns:

```json
{ "triggered": true, "snapshot": {} }
```

Parsing must use existing strict `expectObject`, `expectString`, and typed helpers. Add helpers for optional status, trigger rule, number, and string arrays. Invalid request bodies return `400` with a clear error.

## Persistence

`StoredMissionSnapshot.schemaVersion` can remain `1` if new fields are optional on load:

```typescript
for (const template of stored.scheduledTaskTemplates ?? []) this.scheduledTaskTemplates.set(template.id, template);
for (const registration of stored.scheduleRegistrations ?? []) this.scheduleRegistrations.set(registration.id, registration);
for (const trigger of stored.conditionTriggers ?? []) this.conditionTriggers.set(trigger.id, trigger);
for (const metric of stored.metricSnapshots ?? []) {
  const existing = this.metricSnapshots.get(metric.missionId) ?? [];
  this.metricSnapshots.set(metric.missionId, [...existing, metric]);
}
```

However, new snapshots must always include the new arrays.

On reload:

- Rehydrate all schedules before scheduler starts.
- Do not immediately execute overdue schedules during constructor load.
- The first explicit `startScheduler()` tick may execute overdue schedules. This behavior is acceptable and should be covered by tests.

## Testing Requirements

Core tests:

- `createScheduledTaskTemplate` rejects empty name.
- `createScheduledTaskTemplate` rejects empty success criteria.
- `createScheduleRegistration` rejects empty `nextRunAt`.
- `createConditionTrigger` rejects empty `notifyAgentIds`.
- `evaluateConditionTrigger` returns true for `lte` absolute threshold.
- `evaluateConditionTrigger` throws when `compareTo: "previous"` is used without previous metric.

Schedule rule tests:

- `nextRunAfter({ type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" }, 2026-04-29T08:59:00)` returns 2026-04-29T09:00:00.
- `nextRunAfter({ type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" }, 2026-04-29T09:00:00)` returns 2026-04-30T09:00:00.
- `nextRunAfter({ type: "cron", expression: "0 10 * * 1", timezone: "Asia/Shanghai" }, Wednesday 2026-04-29)` returns Monday 2026-05-04T10:00:00.
- `validateCronExpression("0 9 * * MON")` throws.
- `validateCronExpression("0 9 1-5 * *")` throws.
- `nextRunAfter({ type: "interval", everyMinutes: 30 }, 2026-04-29T09:00:00)` returns 2026-04-29T09:30:00.

Scheduler service tests:

- `start()` throws when called twice.
- `tick()` creates exactly one task for one due active schedule.
- `tick()` does not create a task for a paused schedule.
- `tick()` advances `nextRunAt` after task creation.
- `tick()` throws if the template is missing.
- `tick()` throws if the assigned agent is missing.

Mission service tests:

- Activating a social mission registers daily, weekly, and biweekly schedules when matching agents exist.
- Re-activating a mission does not duplicate schedules.
- A persisted service reload includes schedules and can tick them.
- Cancelling a schedule changes status to `cancelled`.
- Pausing a mission pauses schedules.
- Completing or cancelling a mission cancels schedules and condition triggers.
- Evaluating a condition trigger appends an `agent_notify` message when true.
- Evaluating a condition trigger does not append a notification when false.

API tests:

- `GET /api/missions/:missionId/schedules` lists schedules.
- `POST /api/missions/schedules` registers a schedule from a template.
- `PATCH /api/missions/schedules/:scheduleId` pauses a schedule.
- `DELETE /api/missions/schedules/:scheduleId` cancels a schedule.
- `POST /api/missions/condition-triggers` creates a trigger.
- `POST /api/missions/condition-triggers/:triggerId/evaluate` returns `{ triggered: true }` and records notification.

Run verification:

```bash
pnpm --filter @digitalagent/core test
pnpm --filter @digitalagent/server test
pnpm --filter @digitalagent/server typecheck
pnpm test
```

## Acceptance Scenario

Given a user creates and activates this mission:

```text
运营一个小红书账号，一个月涨到1000粉丝
```

Expected behavior:

1. Mission activation creates the team as before.
2. Phase 4 registers:
   - Daily data check at `0 9 * * *`.
   - Weekly topic meeting at `0 10 * * 1`.
   - Biweekly strategy review at `0 16 */14 * *`.
3. When the fake clock reaches the daily schedule time, `SchedulerService.tick()` creates a task assigned to the researcher or analyst-like agent.
4. The task appears in `snapshot.tasks` with:
   - `contract.input.scheduleId`
   - `contract.input.templateId`
   - `contract.input.scheduledRunAt`
   - `assigneeAgentId` equal to the scheduled agent id.
5. An `agent_notify` message records that the scheduler created the task.
6. If a condition trigger for engagement drop receives value `-31` with threshold `-20`, the detector agent notifies the project owner/strategist through `agent_notify`.

## Implementation Order

1. Add core schedule types, constructors, and unit tests.
2. Add cron/interval rule parsing and tests.
3. Add `SchedulerService` with fake clock tests.
4. Extend `MissionSnapshot`, persistence, and mission service schedule maps.
5. Add default scheduler config and config validation.
6. Register default schedules during mission activation.
7. Add schedule API endpoints and tests.
8. Add condition trigger model, evaluation methods, API endpoints, and tests.
9. Wire server scheduler start/stop.
10. Run full verification.

## Self-Review

- No placeholder sections remain.
- Scope is focused on Phase 4 only; external adapters are intentionally interface-only.
- The design follows existing app constraints: TypeScript monorepo, in-memory maps, JSON persistence, strict request parsing, and Vitest.
- The scheduler fails fast for bad definitions and missing references, matching the project rule that bugs should surface early.
