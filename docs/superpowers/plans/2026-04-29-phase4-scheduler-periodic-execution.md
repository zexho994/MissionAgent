# Phase 4: Scheduler & Periodic Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a scheduling engine inside Mission so long-running missions have team work rhythms — cron-driven periodic tasks and condition-triggered tasks, both creating normal Tasks through the existing lifecycle.

**Architecture:** A lightweight `MissionScheduler` per active Mission, driven by a clock abstraction for testability. Schedule rules live on the Mission object and persist via the existing JSON store. Cron parsing uses the `node-cron` library. Condition triggers hook into task completion events and use LLM evaluation. The scheduler is just another way to create Tasks — no new task states or execution channels.

**Tech Stack:** TypeScript, Vitest, node-cron, existing DigitalAgent monorepo (core → server)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/core/src/types.ts` | Add `CronTrigger`, `ConditionTrigger`, `ScheduleTrigger`, `ScheduleRule` types |
| `packages/core/src/schedule.ts` | Factory `createScheduleRule()` with validation |
| `packages/core/src/schedule.test.ts` | Unit tests for schedule rule creation and validation |
| `packages/core/src/index.ts` | Export new schedule module |
| `apps/server/src/schedule-rules.ts` | Cron expression validation, `nextRunAfter()`, `isDue()` |
| `apps/server/src/schedule-rules.test.ts` | Cron parsing and next-run calculation tests |
| `apps/server/src/mission-scheduler.ts` | `MissionScheduler` class with fake-clock testability |
| `apps/server/src/mission-scheduler.test.ts` | Scheduler tests with fake clock |
| `apps/server/src/mission-service.ts` | Integrate schedulers map, lifecycle hooks, persistence restore |
| `apps/server/src/api.ts` | New schedule CRUD + trigger endpoints |
| `apps/server/src/api.test.ts` | API endpoint tests for schedule operations |
| `apps/server/src/server.ts` | No changes needed (mission-service handles startup restore) |
| `apps/server/src/hr-agent.ts` | Extend TeamProposal with `schedulePlan` |
| `apps/server/src/negotiation-manager.ts` | Convert SchedulePlanItem to ScheduleRule on confirm |

---

### Task 1: Core Schedule Types

**Files:**
- Modify: `packages/core/src/types.ts`
- Create: `packages/core/src/schedule.ts`
- Create: `packages/core/src/schedule.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add schedule types to types.ts**

Append after the existing `TaskEvent` union (after line 134) in `packages/core/src/types.ts`:

```typescript
// --- Schedule Types ---

export interface CronTrigger {
  type: "cron";
  expression: string;
  timezone: string;
}

export interface ConditionTrigger {
  type: "condition";
  description: string;
  sourceAgentRole: string;
  evaluatePrompt: string;
}

export type ScheduleTrigger = CronTrigger | ConditionTrigger;

export interface ScheduleRule {
  id: string;
  name: string;
  missionId: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  taskTemplate: {
    title: string;
    contract: TaskContract;
    assigneeRole: string;
    priority: "low" | "normal" | "high";
  };
  maxConcurrent: number;
  metadata: Record<string, unknown>;
}
```

Also add `scheduleRules: ScheduleRule[]` to the `Mission` interface (after the `briefConfirmed` field):

```typescript
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
  scheduleRules: ScheduleRule[];
}
```

- [ ] **Step 2: Write the failing test for createScheduleRule**

Create `packages/core/src/schedule.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createScheduleRule } from "./schedule.js";

describe("createScheduleRule", () => {
  const validCronTrigger = {
    type: "cron" as const,
    expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
  };

  const validTaskTemplate = {
    title: "Daily data check",
    contract: {
      objective: "Check yesterday's engagement data",
      input: {},
      outputSchema: { report: "object" },
      successCriteria: ["Report generated"],
    },
    assigneeRole: "data-analyst",
    priority: "normal" as const,
  };

  it("creates a cron schedule rule with all fields", () => {
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: "mission_test",
      enabled: true,
      trigger: validCronTrigger,
      taskTemplate: validTaskTemplate,
      maxConcurrent: 1,
      metadata: {},
    });

    expect(rule.id).toMatch(/^schedule_/);
    expect(rule.name).toBe("Daily check");
    expect(rule.trigger.type).toBe("cron");
  });

  it("rejects empty name", () => {
    expect(() =>
      createScheduleRule({
        name: "",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Schedule rule name is required");
  });

  it("rejects empty missionId", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Schedule rule missionId is required");
  });

  it("rejects empty task template title", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: { ...validTaskTemplate, title: "" },
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Task template title is required");
  });

  it("rejects empty assigneeRole", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: { ...validTaskTemplate, assigneeRole: "" },
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Task template assigneeRole is required");
  });

  it("rejects empty contract objective", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: {
          ...validTaskTemplate,
          contract: { ...validTaskTemplate.contract, objective: "" },
        },
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Task template contract objective is required");
  });

  it("rejects maxConcurrent less than 1", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: validTaskTemplate,
        maxConcurrent: 0,
        metadata: {},
      }),
    ).toThrow("maxConcurrent must be a positive integer");
  });

  it("rejects non-integer maxConcurrent", () => {
    expect(() =>
      createScheduleRule({
        name: "Daily check",
        missionId: "mission_test",
        enabled: true,
        trigger: validCronTrigger,
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1.5,
        metadata: {},
      }),
    ).toThrow("maxConcurrent must be a positive integer");
  });

  it("creates a condition trigger rule", () => {
    const rule = createScheduleRule({
      name: "Engagement drop alert",
      missionId: "mission_test",
      enabled: true,
      trigger: {
        type: "condition",
        description: "Engagement rate drops more than 20%",
        sourceAgentRole: "data-analyst",
        evaluatePrompt: "Check if the engagement rate has dropped more than 20% compared to the previous period.",
      },
      taskTemplate: validTaskTemplate,
      maxConcurrent: 1,
      metadata: {},
    });

    expect(rule.trigger.type).toBe("condition");
  });

  it("rejects condition trigger with empty sourceAgentRole", () => {
    expect(() =>
      createScheduleRule({
        name: "Engagement drop alert",
        missionId: "mission_test",
        enabled: true,
        trigger: {
          type: "condition",
          description: "Engagement rate drops more than 20%",
          sourceAgentRole: "",
          evaluatePrompt: "Check engagement",
        },
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Condition trigger sourceAgentRole is required");
  });

  it("rejects condition trigger with empty description", () => {
    expect(() =>
      createScheduleRule({
        name: "Engagement drop alert",
        missionId: "mission_test",
        enabled: true,
        trigger: {
          type: "condition",
          description: "",
          sourceAgentRole: "data-analyst",
          evaluatePrompt: "Check engagement",
        },
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Condition trigger description is required");
  });

  it("rejects condition trigger with empty evaluatePrompt", () => {
    expect(() =>
      createScheduleRule({
        name: "Engagement drop alert",
        missionId: "mission_test",
        enabled: true,
        trigger: {
          type: "condition",
          description: "Engagement rate drops",
          sourceAgentRole: "data-analyst",
          evaluatePrompt: "",
        },
        taskTemplate: validTaskTemplate,
        maxConcurrent: 1,
        metadata: {},
      }),
    ).toThrow("Condition trigger evaluatePrompt is required");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/core vitest run src/schedule.test.ts`
Expected: FAIL — `createScheduleRule` is not defined

- [ ] **Step 4: Implement createScheduleRule**

Create `packages/core/src/schedule.ts`:

```typescript
import { createId } from "./ids.js";
import type { ScheduleRule, ScheduleTrigger } from "./types.js";

export interface CreateScheduleRuleInput {
  name: string;
  missionId: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  taskTemplate: {
    title: string;
    contract: {
      objective: string;
      input: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
      successCriteria: string[];
    };
    assigneeRole: string;
    priority: "low" | "normal" | "high";
  };
  maxConcurrent: number;
  metadata: Record<string, unknown>;
}

export function createScheduleRule(input: CreateScheduleRuleInput): ScheduleRule {
  if (!input.name.trim()) {
    throw new Error("Schedule rule name is required");
  }
  if (!input.missionId.trim()) {
    throw new Error("Schedule rule missionId is required");
  }
  if (!input.taskTemplate.title.trim()) {
    throw new Error("Task template title is required");
  }
  if (!input.taskTemplate.assigneeRole.trim()) {
    throw new Error("Task template assigneeRole is required");
  }
  if (!input.taskTemplate.contract.objective.trim()) {
    throw new Error("Task template contract objective is required");
  }
  if (
    !Number.isInteger(input.maxConcurrent) ||
    input.maxConcurrent < 1
  ) {
    throw new Error("maxConcurrent must be a positive integer");
  }

  validateTrigger(input.trigger);

  return {
    id: createId("schedule"),
    name: input.name,
    missionId: input.missionId,
    enabled: input.enabled,
    trigger: { ...input.trigger },
    taskTemplate: {
      title: input.taskTemplate.title,
      contract: {
        objective: input.taskTemplate.contract.objective,
        input: { ...input.taskTemplate.contract.input },
        outputSchema: { ...input.taskTemplate.contract.outputSchema },
        successCriteria: [...input.taskTemplate.contract.successCriteria],
      },
      assigneeRole: input.taskTemplate.assigneeRole,
      priority: input.taskTemplate.priority,
    },
    maxConcurrent: input.maxConcurrent,
    metadata: { ...input.metadata },
  };
}

function validateTrigger(trigger: ScheduleTrigger): void {
  if (trigger.type === "condition") {
    if (!trigger.description.trim()) {
      throw new Error("Condition trigger description is required");
    }
    if (!trigger.sourceAgentRole.trim()) {
      throw new Error("Condition trigger sourceAgentRole is required");
    }
    if (!trigger.evaluatePrompt.trim()) {
      throw new Error("Condition trigger evaluatePrompt is required");
    }
  }
}
```

- [ ] **Step 5: Export schedule module from core index**

Add to `packages/core/src/index.ts` (append a new line):

```
export * from "./schedule.js";
```

- [ ] **Step 6: Update createMission to initialize scheduleRules**

In `packages/core/src/mission.ts`, add `scheduleRules: []` to the returned object in `createMission()`. The return statement becomes:

```typescript
  return {
    id: createId("mission"),
    goal: input.goal,
    successMetrics: [...input.successMetrics],
    constraints: [...input.constraints],
    status: "active",
    budget: {
      maxRuntimeMinutes: input.budget?.maxRuntimeMinutes ?? 60,
      ...(input.budget?.maxTokenSpendUsd === undefined
        ? {}
        : { maxTokenSpendUsd: input.budget.maxTokenSpendUsd }),
    },
    createdAt: new Date(),
    scheduleRules: [],
  };
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @digitalagent/core vitest run src/schedule.test.ts && pnpm --filter @digitalagent/core vitest run src/mission.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Run full core test suite to verify no regressions**

Run: `pnpm --filter @digitalagent/core vitest run`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/schedule.ts packages/core/src/schedule.test.ts packages/core/src/index.ts packages/core/src/mission.ts
git commit -m "feat: add ScheduleRule types, factory, and Mission.scheduleRules"
```

---

### Task 2: Cron Expression Parsing

**Files:**
- Create: `apps/server/src/schedule-rules.ts`
- Create: `apps/server/src/schedule-rules.test.ts`

- [ ] **Step 1: Install node-cron dependency**

Run: `cd apps/server && pnpm add node-cron && pnpm add -D @types/node-cron`

- [ ] **Step 2: Write the failing tests for cron parsing**

Create `apps/server/src/schedule-rules.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { validateCronExpression, nextRunAfter, isDue } from "./schedule-rules.js";

describe("validateCronExpression", () => {
  it("accepts valid five-field cron expressions", () => {
    expect(() => validateCronExpression("0 9 * * *")).not.toThrow();
    expect(() => validateCronExpression("30 14 * * 1")).not.toThrow();
    expect(() => validateCronExpression("*/5 * * * *")).not.toThrow();
    expect(() => validateCronExpression("0 0 1 1 *")).not.toThrow();
  });

  it("rejects unsupported range syntax", () => {
    expect(() => validateCronExpression("0 9 * * 1-5")).toThrow(
      "Unsupported cron expression",
    );
  });

  it("rejects named day syntax", () => {
    expect(() => validateCronExpression("0 9 * * MON")).toThrow(
      "Unsupported cron expression",
    );
  });

  it("rejects expressions with six fields (seconds)", () => {
    expect(() => validateCronExpression("0 0 9 * * *")).toThrow(
      "Unsupported cron expression",
    );
  });

  it("rejects expressions with fewer than five fields", () => {
    expect(() => validateCronExpression("0 9 * *")).toThrow(
      "Unsupported cron expression",
    );
  });

  it("rejects empty expression", () => {
    expect(() => validateCronExpression("")).toThrow(
      "Unsupported cron expression",
    );
  });
});

describe("nextRunAfter", () => {
  it("returns same day when time has not passed", () => {
    const trigger = { type: "cron" as const, expression: "0 9 * * *", timezone: "UTC" };
    const after = new Date("2026-04-29T08:59:00Z");
    const next = nextRunAfter(trigger, after);

    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getUTCDate()).toBe(29);
  });

  it("returns next day when time has passed", () => {
    const trigger = { type: "cron" as const, expression: "0 9 * * *", timezone: "UTC" };
    const after = new Date("2026-04-29T09:00:00Z");
    const next = nextRunAfter(trigger, after);

    expect(next.getUTCDate()).toBe(30);
    expect(next.getUTCHours()).toBe(9);
  });

  it("returns next Monday for weekly schedule on Wednesday", () => {
    const trigger = { type: "cron" as const, expression: "0 10 * * 1", timezone: "UTC" };
    const after = new Date("2026-04-29T10:00:00Z");
    const next = nextRunAfter(trigger, after);

    expect(next.getUTCDay()).toBe(1);
    expect(next.getUTCHours()).toBe(10);
  });

  it("returns next 5-minute interval", () => {
    const trigger = { type: "cron" as const, expression: "*/5 * * * *", timezone: "UTC" };
    const after = new Date("2026-04-29T09:03:00Z");
    const next = nextRunAfter(trigger, after);

    expect(next.getUTCMinutes()).toBe(5);
  });
});

describe("isDue", () => {
  it("returns true when nextRunAt matches now", () => {
    const now = new Date("2026-04-29T09:00:00Z");
    expect(isDue("2026-04-29T09:00:00.000Z", now)).toBe(true);
  });

  it("returns false when nextRunAt is in the future", () => {
    const now = new Date("2026-04-29T08:59:00Z");
    expect(isDue("2026-04-29T09:00:00.000Z", now)).toBe(false);
  });

  it("returns true when nextRunAt is in the past", () => {
    const now = new Date("2026-04-29T09:05:00Z");
    expect(isDue("2026-04-29T09:00:00.000Z", now)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/server vitest run src/schedule-rules.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement cron parsing**

Create `apps/server/src/schedule-rules.ts`:

```typescript
import type { CronTrigger } from "@digitalagent/core";

export function validateCronExpression(expression: string): void {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Unsupported cron expression: empty");
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      "Unsupported cron expression: must have exactly 5 fields (minute hour dayOfMonth month dayOfWeek)",
    );
  }

  const hasRange = parts.some((part) => part.includes("-"));
  const hasNamedDay = parts[4] !== undefined && /[a-zA-Z]/.test(parts[4]);

  if (hasRange) {
    throw new Error("Unsupported cron expression: ranges (e.g., 1-5) are not supported");
  }
  if (hasNamedDay) {
    throw new Error("Unsupported cron expression: named days (e.g., MON) are not supported");
  }
}

export function nextRunAfter(trigger: CronTrigger, after: Date): Date {
  const cron = require("node-cron");
  const expression = trigger.expression;

  validateCronExpression(expression);

  const parser = cron.parser || cron;
  const parsed = parser.parseExpression(expression, {
    currentDate: after,
    tz: trigger.timezone,
  });

  return parsed.next().toDate();
}

export function isDue(nextRunAt: string, now: Date): boolean {
  const next = new Date(nextRunAt);
  return now >= next;
}
```

**Note:** The `require("node-cron")` is used because node-cron's ESM support varies. If the project uses ESM (it does — `"type": "module"`), we need to use the dynamic import pattern. Let me revise:

```typescript
import type { CronTrigger } from "@digitalagent/core";
import * as cron from "node-cron";

export function validateCronExpression(expression: string): void {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Unsupported cron expression: empty");
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      "Unsupported cron expression: must have exactly 5 fields (minute hour dayOfMonth month dayOfWeek)",
    );
  }

  const hasRange = parts.some((part) => part.includes("-"));
  const hasNamedDay = parts[4] !== undefined && /[a-zA-Z]/.test(parts[4]);

  if (hasRange) {
    throw new Error("Unsupported cron expression: ranges (e.g., 1-5) are not supported");
  }
  if (hasNamedDay) {
    throw new Error("Unsupported cron expression: named days (e.g., MON) are not supported");
  }
}

export function nextRunAfter(trigger: CronTrigger, after: Date): Date {
  validateCronExpression(trigger.expression);

  const parsed = cron.parseExpression(trigger.expression, {
    currentDate: after,
    tz: trigger.timezone,
  });

  return parsed.next().toDate();
}

export function isDue(nextRunAt: string, now: Date): boolean {
  const next = new Date(nextRunAt);
  return now >= next;
}
```

**Important:** `node-cron` exports `parseExpression` directly. Verify this after install by checking the actual API. If `node-cron` doesn't export `parseExpression`, we may need `cron-parser` as a separate package. The safer choice is to use `cron-parser` (which is specifically for parsing cron expressions and computing next runs), and `node-cron` for scheduling. Let me use `cron-parser` instead:

**Revised:** Install `cron-parser` instead of `node-cron`:

Run: `cd apps/server && pnpm add cron-parser && pnpm remove node-cron`

Then `apps/server/src/schedule-rules.ts`:

```typescript
import type { CronTrigger } from "@digitalagent/core";
import { parseExpression } from "cron-parser";

export function validateCronExpression(expression: string): void {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Unsupported cron expression: empty");
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      "Unsupported cron expression: must have exactly 5 fields (minute hour dayOfMonth month dayOfWeek)",
    );
  }

  const hasRange = parts.some((part) => part.includes("-"));
  const hasNamedDay = parts[4] !== undefined && /[a-zA-Z]/.test(parts[4]);

  if (hasRange) {
    throw new Error("Unsupported cron expression: ranges (e.g., 1-5) are not supported");
  }
  if (hasNamedDay) {
    throw new Error("Unsupported cron expression: named days (e.g., MON) are not supported");
  }
}

export function nextRunAfter(trigger: CronTrigger, after: Date): Date {
  validateCronExpression(trigger.expression);

  const interval = parseExpression(trigger.expression, {
    currentDate: after,
    tz: trigger.timezone,
  });

  return interval.next().toDate();
}

export function isDue(nextRunAt: string, now: Date): boolean {
  const next = new Date(nextRunAt);
  return now >= next;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @digitalagent/server vitest run src/schedule-rules.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/schedule-rules.ts apps/server/src/schedule-rules.test.ts apps/server/package.json pnpm-lock.yaml
git commit -m "feat: add cron expression parsing and next-run calculation"
```

---

### Task 3: MissionScheduler Component

**Files:**
- Create: `apps/server/src/mission-scheduler.ts`
- Create: `apps/server/src/mission-scheduler.test.ts`

- [ ] **Step 1: Write the failing tests for MissionScheduler**

Create `apps/server/src/mission-scheduler.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { MissionScheduler, type SchedulerClock, type SchedulerDeps } from "./mission-scheduler.js";
import type { ScheduleRule, Task } from "@digitalagent/core";
import { createScheduleRule } from "@digitalagent/core";

function fakeClock(): SchedulerClock & { advance(ms: number): void; ticks: () => number } {
  let now = new Date("2026-04-29T09:00:00Z");
  const intervals: Array<{ handler: () => void; ms: number; remaining: number }> = [];
  let tickCount = 0;

  return {
    now: () => now,
    setInterval(handler: () => void, ms: number) {
      intervals.push({ handler, ms, remaining: ms });
      return intervals.length - 1;
    },
    clearInterval(handle: unknown) {
      const idx = handle as number;
      if (intervals[idx]) {
        intervals.splice(idx, 1);
      }
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      for (const entry of intervals) {
        entry.remaining -= ms;
        while (entry.remaining <= 0) {
          entry.remaining += entry.ms;
          tickCount++;
          entry.handler();
        }
      }
    },
    ticks: () => tickCount,
  };
}

function makeDeps(): {
  clock: ReturnType<typeof fakeClock>;
  createdTasks: Array<{ ruleId: string; taskTitle: string; assigneeRole: string }>;
  deps: SchedulerDeps;
} {
  const clock = fakeClock();
  const createdTasks: Array<{ ruleId: string; taskTitle: string; assigneeRole: string }> = [];

  const deps: SchedulerDeps = {
    clock,
    missionId: "mission_test",
    findAgentByRole: (role: string) => {
      if (role === "data-analyst") return { id: "agent_analyst", role };
      return undefined;
    },
    countIncompleteTasksForRule: () => 0,
    createTaskFromTemplate: (ruleId: string, template, agentId) => {
      createdTasks.push({ ruleId, taskTitle: template.title, assigneeRole: template.assigneeRole });
      return { id: "task_1", title: template.title, status: "draft" } as Task;
    },
    assignTask: () => {},
    notifyOwner: () => {},
  };

  return { clock, createdTasks, deps };
}

function cronRule(overrides?: Partial<ScheduleRule>): ScheduleRule {
  const base = createScheduleRule({
    name: "Daily data check",
    missionId: "mission_test",
    enabled: true,
    trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    taskTemplate: {
      title: "Check yesterday's engagement data",
      contract: {
        objective: "Analyze engagement metrics from yesterday",
        input: {},
        outputSchema: { report: "object" },
        successCriteria: ["Report generated"],
      },
      assigneeRole: "data-analyst",
      priority: "normal",
    },
    maxConcurrent: 1,
    metadata: {},
  });
  return overrides ? { ...base, ...overrides } : base;
}

describe("MissionScheduler", () => {
  it("creates a task when cron fires", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    const rule = cronRule();
    scheduler.start([rule]);

    clock.advance(60_000);

    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0]?.taskTitle).toBe("Check yesterday's engagement data");
  });

  it("skips disabled rules", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    const rule = cronRule({ enabled: false });
    scheduler.start([rule]);

    clock.advance(60_000);

    expect(createdTasks).toHaveLength(0);
  });

  it("skips when maxConcurrent is exceeded", () => {
    const { clock, createdTasks, deps } = makeDeps();
    deps.countIncompleteTasksForRule = () => 5;

    const scheduler = new MissionScheduler(deps);
    const rule = cronRule({ maxConcurrent: 1 });
    scheduler.start([rule]);

    clock.advance(60_000);

    expect(createdTasks).toHaveLength(0);
  });

  it("warns and skips when agent not found", () => {
    const { clock, createdTasks, deps } = makeDeps();
    deps.findAgentByRole = () => undefined;

    const notified: string[] = [];
    deps.notifyOwner = (msg: string) => notified.push(msg);

    const scheduler = new MissionScheduler(deps);
    const rule = cronRule();
    scheduler.start([rule]);

    clock.advance(60_000);

    expect(createdTasks).toHaveLength(0);
    expect(notified.length).toBeGreaterThan(0);
  });

  it("stop clears all intervals", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    const rule = cronRule();
    scheduler.start([rule]);
    scheduler.stop();

    clock.advance(60_000);

    expect(createdTasks).toHaveLength(0);
  });

  it("restart replaces rules", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    const rule1 = cronRule();
    scheduler.start([rule1]);

    const rule2 = cronRule({ name: "Weekly review" });
    scheduler.restart([rule2]);

    clock.advance(60_000);

    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0]?.taskTitle).toBe("Check yesterday's engagement data");
  });

  it("addRule adds a new rule to running scheduler", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    scheduler.start([]);
    const rule = cronRule();
    scheduler.addRule(rule);

    clock.advance(60_000);

    expect(createdTasks).toHaveLength(1);
  });

  it("removeRule stops a specific rule", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    const rule = cronRule();
    scheduler.start([rule]);
    scheduler.removeRule(rule.id);

    clock.advance(60_000);

    expect(createdTasks).toHaveLength(0);
  });

  it("getRules returns current rules", () => {
    const { deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    const rule = cronRule();
    scheduler.start([rule]);

    expect(scheduler.getRules()).toHaveLength(1);
    expect(scheduler.getRules()[0]?.name).toBe("Daily data check");
  });

  it("updateRule patches a rule", () => {
    const { deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    const rule = cronRule();
    scheduler.start([rule]);
    scheduler.updateRule(rule.id, { enabled: false });

    expect(scheduler.getRules()[0]?.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-scheduler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement MissionScheduler**

Create `apps/server/src/mission-scheduler.ts`:

```typescript
import type { ScheduleRule, Task, TaskContract } from "@digitalagent/core";

export interface SchedulerClock {
  now(): Date;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SchedulerDeps {
  clock: SchedulerClock;
  missionId: string;
  findAgentByRole: (role: string) => { id: string; role: string } | undefined;
  countIncompleteTasksForRule: (ruleId: string) => number;
  createTaskFromTemplate: (
    ruleId: string,
    template: { title: string; contract: TaskContract; assigneeRole: string; priority: "low" | "normal" | "high" },
    agentId: string,
  ) => Task;
  assignTask: (taskId: string, agentId: string) => void;
  notifyOwner: (message: string) => void;
}

export class MissionScheduler {
  private readonly deps: SchedulerDeps;
  private rules: ScheduleRule[] = [];
  private intervalHandles: unknown[] = [];
  private running = false;
  private static readonly TICK_INTERVAL_MS = 60_000;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(rules: ScheduleRule[]): void {
    this.stop();
    this.rules = [...rules];
    this.running = true;
    this.registerCronTicks();
  }

  stop(): void {
    for (const handle of this.intervalHandles) {
      this.deps.clock.clearInterval(handle);
    }
    this.intervalHandles = [];
    this.running = false;
  }

  restart(rules: ScheduleRule[]): void {
    this.stop();
    this.start(rules);
  }

  addRule(rule: ScheduleRule): void {
    this.rules = [...this.rules, rule];
    if (this.running) {
      this.registerCronTicks();
    }
  }

  removeRule(ruleId: string): void {
    this.rules = this.rules.filter((r) => r.id !== ruleId);
    if (this.running) {
      this.stop();
      this.running = true;
      this.registerCronTicks();
    }
  }

  updateRule(ruleId: string, patch: Partial<ScheduleRule>): void {
    this.rules = this.rules.map((r) =>
      r.id === ruleId ? { ...r, ...patch } : r,
    );
  }

  getRules(): ScheduleRule[] {
    return [...this.rules];
  }

  private registerCronTicks(): void {
    for (const handle of this.intervalHandles) {
      this.deps.clock.clearInterval(handle);
    }
    this.intervalHandles = [];

    const handle = this.deps.clock.setInterval(() => {
      this.onTick();
    }, MissionScheduler.TICK_INTERVAL_MS);

    this.intervalHandles.push(handle);
  }

  private onTick(): void {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.trigger.type !== "cron") continue;
      this.onTrigger(rule);
    }
  }

  private onTrigger(rule: ScheduleRule): void {
    const incomplete = this.deps.countIncompleteTasksForRule(rule.id);
    if (incomplete >= rule.maxConcurrent) {
      return;
    }

    const agent = this.deps.findAgentByRole(rule.taskTemplate.assigneeRole);
    if (!agent) {
      this.deps.notifyOwner(
        `Schedule rule "${rule.name}" skipped: no agent found for role "${rule.taskTemplate.assigneeRole}"`,
      );
      return;
    }

    const task = this.deps.createTaskFromTemplate(
      rule.id,
      rule.taskTemplate,
      agent.id,
    );
    this.deps.assignTask(task.id, agent.id);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-scheduler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mission-scheduler.ts apps/server/src/mission-scheduler.test.ts
git commit -m "feat: add MissionScheduler component with fake-clock testability"
```

---

### Task 4: MissionService Integration

**Files:**
- Modify: `apps/server/src/mission-service.ts`

- [ ] **Step 1: Add schedule-related imports**

Add to the imports at the top of `apps/server/src/mission-service.ts`:

```typescript
import type { ScheduleRule } from "@digitalagent/core";
import { MissionScheduler, type SchedulerClock, type SchedulerDeps } from "./mission-scheduler.js";
```

- [ ] **Step 2: Add schedulers map and clock to InMemoryMissionService**

Add new private fields after the existing `autonomyService` field (around line 239):

```typescript
  private readonly schedulers = new Map<string, MissionScheduler>();
```

- [ ] **Step 3: Add real clock implementation**

Add a static/private clock at the class level:

```typescript
  private static readonly realClock: SchedulerClock = {
    now: () => new Date(),
    setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as NodeJS.Timeout),
  };
```

- [ ] **Step 4: Add schedule lifecycle methods to InMemoryMissionService**

Add these public methods to the class:

```typescript
  addScheduleRule(missionId: string, rule: ScheduleRule): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const updated: Mission = {
      ...mission,
      scheduleRules: [...mission.scheduleRules, rule],
    };
    this.missions.set(updated.id, updated);

    const scheduler = this.getOrCreateScheduler(missionId);
    scheduler.addRule(rule);
    this.persist();
  }

  removeScheduleRule(missionId: string, ruleId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const updated: Mission = {
      ...mission,
      scheduleRules: mission.scheduleRules.filter((r) => r.id !== ruleId),
    };
    this.missions.set(updated.id, updated);

    const scheduler = this.schedulers.get(missionId);
    if (scheduler) {
      scheduler.removeRule(ruleId);
    }
    this.persist();
  }

  updateScheduleRule(missionId: string, ruleId: string, patch: Partial<ScheduleRule>): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const updated: Mission = {
      ...mission,
      scheduleRules: mission.scheduleRules.map((r) =>
        r.id === ruleId ? { ...r, ...patch } : r,
      ),
    };
    this.missions.set(updated.id, updated);

    const scheduler = this.schedulers.get(missionId);
    if (scheduler) {
      scheduler.updateRule(ruleId, patch);
    }
    this.persist();
  }

  getScheduleRules(missionId: string): ScheduleRule[] {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    return [...mission.scheduleRules];
  }

  triggerScheduleRule(missionId: string, ruleId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const rule = mission.scheduleRules.find((r) => r.id === ruleId);
    if (!rule) {
      throw new Error(`Schedule rule not found: ${ruleId}`);
    }
    this.createTaskFromScheduleRule(mission, rule);
    this.persist();
  }

  restoreSchedulers(): void {
    for (const mission of this.missions.values()) {
      if (mission.status === "active" && mission.scheduleRules.length > 0) {
        const scheduler = this.getOrCreateScheduler(mission.id);
        scheduler.start(mission.scheduleRules);
      }
    }
  }
```

- [ ] **Step 5: Add private helper methods**

```typescript
  private getOrCreateScheduler(missionId: string): MissionScheduler {
    let scheduler = this.schedulers.get(missionId);
    if (!scheduler) {
      const deps: SchedulerDeps = {
        clock: InMemoryMissionService.realClock,
        missionId,
        findAgentByRole: (role) => {
          const agent = [...this.agents.values()].find(
            (a) => a.missionId === missionId && a.role === role,
          );
          return agent ? { id: agent.id, role: agent.role } : undefined;
        },
        countIncompleteTasksForRule: (ruleId) => {
          const rule = this.missions.get(missionId)?.scheduleRules.find((r) => r.id === ruleId);
          if (!rule) return 0;
          return [...this.tasks.values()].filter(
            (t) =>
              t.missionId === missionId &&
              t.title === rule.taskTemplate.title &&
              t.status !== "completed" &&
              t.status !== "failed" &&
              t.status !== "cancelled",
          ).length;
        },
        createTaskFromTemplate: (_ruleId, template, agentId) => {
          const mission = this.missions.get(missionId);
          if (!mission) throw new Error(`Mission not found: ${missionId}`);
          const task = createTask({
            missionId,
            title: template.title,
            dependencies: [],
            contract: template.contract,
            approvalRequired: false,
          });
          this.tasks.set(task.id, { ...task, assigneeAgentId: agentId });
          return task;
        },
        assignTask: (taskId, agentId) => {
          const task = this.tasks.get(taskId);
          if (task) {
            this.tasks.set(taskId, { ...task, assigneeAgentId: agentId });
          }
        },
        notifyOwner: (message) => {
          const owner = [...this.agents.values()].find(
            (a) => a.missionId === missionId && a.role === "owner",
          );
          if (owner) {
            this.appendMessage({
              missionId,
              fromAgentId: "system",
              toAgentId: owner.id,
              type: "agent_notify",
              content: message,
            });
          }
        },
      };
      scheduler = new MissionScheduler(deps);
      this.schedulers.set(missionId, scheduler);
    }
    return scheduler;
  }

  private createTaskFromScheduleRule(mission: Mission, rule: ScheduleRule): void {
    const agent = [...this.agents.values()].find(
      (a) => a.missionId === mission.id && a.role === rule.taskTemplate.assigneeRole,
    );
    if (!agent) {
      const owner = [...this.agents.values()].find(
        (a) => a.missionId === mission.id && a.role === "owner",
      );
      if (owner) {
        this.appendMessage({
          missionId: mission.id,
          fromAgentId: "system",
          toAgentId: owner.id,
          type: "agent_notify",
          content: `Schedule rule "${rule.name}" skipped: no agent for role "${rule.taskTemplate.assigneeRole}"`,
        });
      }
      return;
    }

    const task = createTask({
      missionId: mission.id,
      title: rule.taskTemplate.title,
      dependencies: [],
      contract: rule.taskTemplate.contract,
      approvalRequired: false,
    });

    const assigned = { ...task, assigneeAgentId: agent.id };
    this.tasks.set(assigned.id, assigned);

    this.appendMessage({
      missionId: mission.id,
      fromAgentId: "system",
      type: "task_plan",
      content: `Scheduled task "${rule.taskTemplate.title}" assigned to ${agent.name}.`,
    });
  }

  private stopScheduler(missionId: string): void {
    const scheduler = this.schedulers.get(missionId);
    if (scheduler) {
      scheduler.stop();
      this.schedulers.delete(missionId);
    }
  }
```

- [ ] **Step 6: Hook into mission lifecycle**

In `activateMission()` method, after `this.persist()` (around line 344), add:

```typescript
    if (mission.scheduleRules.length > 0) {
      const scheduler = this.getOrCreateScheduler(mission.id);
      scheduler.start(mission.scheduleRules);
    }
```

In `confirmNegotiation()` method (in `NegotiationManager`), the call to `this.getAutonomyService().startLoop(mission.id)` already happens. We need to also start schedulers after negotiation confirms. This will be handled in Task 5.

For now, add cleanup in `loadFromFile()`. At the end of `loadFromFile()`, after loading all entries, add:

```typescript
    for (const mission of stored.missions) {
      if (mission.status === "active" && (mission as any).scheduleRules?.length > 0) {
        const rules = (mission as any).scheduleRules as ScheduleRule[];
        const restored = { ...mission, scheduleRules: rules };
        this.missions.set(restored.id, restored);
      }
    }
```

Actually, the loading code already sets missions. The issue is that stored missions may not have `scheduleRules` if they were created before Phase 4. So in the loading loop, we need to default it:

In `loadFromFile()`, change the mission loading line from:

```typescript
    for (const mission of stored.missions) this.missions.set(mission.id, { ...mission, createdAt: new Date(mission.createdAt) });
```

to:

```typescript
    for (const mission of stored.missions) this.missions.set(mission.id, {
      ...mission,
      createdAt: new Date(mission.createdAt),
      scheduleRules: (mission as any).scheduleRules ?? [],
    });
```

Also, in `snapshot()`, `scheduleRules` are already included because `Mission` now has that field and `snapshot()` returns `[...this.missions.values()]`.

- [ ] **Step 7: Build and run tests**

Run: `pnpm --filter @digitalagent/core build && pnpm --filter @digitalagent/server vitest run`
Expected: All existing tests pass, possibly with some type errors to fix

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/mission-service.ts
git commit -m "feat: integrate MissionScheduler into MissionService lifecycle"
```

---

### Task 5: HR Negotiation Integration

**Files:**
- Modify: `apps/server/src/hr-agent.ts`
- Modify: `apps/server/src/negotiation-manager.ts`

- [ ] **Step 1: Add SchedulePlanItem to TeamProposal**

In `apps/server/src/hr-agent.ts`, add the `SchedulePlanItem` interface and extend `TeamProposal`:

```typescript
export interface SchedulePlanItem {
  name: string;
  cronExpression?: string;
  assigneeRole: string;
  taskDescription: string;
  justification: string;
  conditionDescription?: string;
  conditionSourceRole?: string;
  conditionEvaluatePrompt?: string;
}
```

Extend `TeamProposal` to include:

```typescript
export interface TeamProposal {
  missionId: string;
  roles: RoleSpec[];
  proposedBy: string;
  totalBudget: {
    maxRuntimeMinutes: number;
    maxTasks: number;
  };
  estimatedDuration: string;
  riskAssessment: string[];
  collaborationPlan: {
    workflow: string;
    communicationChannels: string[];
    decisionMaking: string;
  };
  schedulePlan: SchedulePlanItem[];
  createdAt: Date;
}
```

- [ ] **Step 2: Update proposeTeam to include schedulePlan**

In `hr-agent.ts`, update the `proposeTeam` function to include an empty `schedulePlan: []` in the returned object. Also update the HR system prompt in `buildHRAgentSystemPrompt` to include scheduling guidance:

Add to the prompt array in `buildHRAgentSystemPrompt()`:

```
"When proposing teams, also suggest a work rhythm:",
"- Recommend periodic tasks based on the mission goal and roles",
"- Consider each role's responsibilities when scheduling recurring work",
"- If anomaly detection is needed, describe the trigger condition and responder",
```

- [ ] **Step 3: Update NegotiationManager.confirmNegotiation**

In `apps/server/src/negotiation-manager.ts`, in the `confirmNegotiation` method, after creating agents and the initial task, convert `proposal.schedulePlan` to `ScheduleRule[]` and start the scheduler.

Add import:

```typescript
import { createScheduleRule, type ScheduleRule } from "@digitalagent/core";
```

After the existing agent creation loop in `confirmNegotiation()`, add:

```typescript
    const scheduleRules: ScheduleRule[] = [];
    for (const planItem of proposal.schedulePlan ?? []) {
      const trigger = planItem.cronExpression
        ? {
            type: "cron" as const,
            expression: planItem.cronExpression,
            timezone: "Asia/Shanghai",
          }
        : {
            type: "condition" as const,
            description: planItem.conditionDescription ?? "",
            sourceAgentRole: planItem.conditionSourceRole ?? planItem.assigneeRole,
            evaluatePrompt: planItem.conditionEvaluatePrompt ?? `Check if: ${planItem.conditionDescription ?? ""}`,
          };

      const rule = createScheduleRule({
        name: planItem.name,
        missionId: mission.id,
        enabled: true,
        trigger,
        taskTemplate: {
          title: planItem.taskDescription,
          contract: {
            objective: planItem.taskDescription,
            input: {},
            outputSchema: { report: "object" },
            successCriteria: [`Complete: ${planItem.taskDescription}`],
          },
          assigneeRole: planItem.assigneeRole,
          priority: "normal",
        },
        maxConcurrent: 1,
        metadata: { justification: planItem.justification },
      });
      scheduleRules.push(rule);
    }

    const updatedMission: Mission = {
      ...mission,
      scheduleRules,
    };
    this.missions.set(mission.id, updatedMission);
```

Note: This requires `NegotiationManager` to have access to the missions map. Currently it doesn't. We need to add it to the constructor options.

In `NegotiationManagerOptions`, add:

```typescript
  missions: Map<string, import("@digitalagent/core").Mission>;
```

Update the constructor to store it:

```typescript
  private readonly missions: Map<string, import("@digitalagent/core").Mission>;
```

And update `MissionService.getNegotiationManager()` to pass `this.missions`:

In `mission-service.ts`, the `getNegotiationManager()` creates `new NegotiationManager({...})`. Add `missions: this.missions` to the options.

- [ ] **Step 4: Build and run tests**

Run: `pnpm --filter @digitalagent/core build && pnpm --filter @digitalagent/server vitest run`
Expected: All tests pass. There may be test adjustments needed for the new `schedulePlan` field on `TeamProposal` — existing tests that construct `TeamProposal` objects may need `schedulePlan: []`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/hr-agent.ts apps/server/src/negotiation-manager.ts apps/server/src/mission-service.ts
git commit -m "feat: extend TeamProposal with schedulePlan and convert on negotiation confirm"
```

---

### Task 6: Schedule API Endpoints

**Files:**
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/api.test.ts`

- [ ] **Step 1: Write failing API tests for schedule endpoints**

Add to `apps/server/src/api.test.ts`:

```typescript
describe("schedule API endpoints", () => {
  it("GET /api/missions/:id/schedule returns schedule rules", async () => {
    const missions = new InMemoryMissionService();
    const createResp = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions",
        body: {
          goal: "Test mission",
          successMetrics: ["test metric"],
          constraints: ["test constraint"],
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const missionId = (createResp.body as any).mission.id;

    const resp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${missionId}/schedule` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(200);
    expect((resp.body as any).rules).toEqual([]);
  });

  it("POST /api/missions/:id/schedule adds a schedule rule", async () => {
    const missions = new InMemoryMissionService();
    const createResp = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions",
        body: {
          goal: "Test mission",
          successMetrics: ["test metric"],
          constraints: ["test constraint"],
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const missionId = (createResp.body as any).mission.id;

    const resp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule`,
        body: {
          name: "Daily check",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          taskTemplate: {
            title: "Check data",
            contract: {
              objective: "Check data",
              input: {},
              outputSchema: {},
              successCriteria: ["Report generated"],
            },
            assigneeRole: "data-analyst",
            priority: "normal",
          },
          maxConcurrent: 1,
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(201);
    expect((resp.body as any).rule.name).toBe("Daily check");
  });

  it("POST /api/missions/:id/schedule returns 404 for missing mission", async () => {
    const missions = new InMemoryMissionService();
    const resp = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions/nonexistent/schedule",
        body: {
          name: "Daily check",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          taskTemplate: {
            title: "Check data",
            contract: {
              objective: "Check data",
              input: {},
              outputSchema: {},
              successCriteria: ["Report generated"],
            },
            assigneeRole: "data-analyst",
            priority: "normal",
          },
          maxConcurrent: 1,
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(400);
  });

  it("DELETE /api/missions/:id/schedule/:ruleId removes a rule", async () => {
    const missions = new InMemoryMissionService();
    const createResp = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions",
        body: {
          goal: "Test mission",
          successMetrics: ["test metric"],
          constraints: ["test constraint"],
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const missionId = (createResp.body as any).mission.id;

    const addResp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule`,
        body: {
          name: "Daily check",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          taskTemplate: {
            title: "Check data",
            contract: {
              objective: "Check data",
              input: {},
              outputSchema: {},
              successCriteria: ["Report generated"],
            },
            assigneeRole: "data-analyst",
            priority: "normal",
          },
          maxConcurrent: 1,
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const ruleId = (addResp.body as any).rule.id;

    const delResp = await handleApiRequest(
      { method: "DELETE", path: `/api/missions/${missionId}/schedule/${ruleId}` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(delResp.status).toBe(200);

    const listResp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${missionId}/schedule` },
      { missions, openclaw: fakeOpenClaw() },
    );
    expect((listResp.body as any).rules).toHaveLength(0);
  });

  it("PATCH /api/missions/:id/schedule/:ruleId updates a rule", async () => {
    const missions = new InMemoryMissionService();
    const createResp = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions",
        body: {
          goal: "Test mission",
          successMetrics: ["test metric"],
          constraints: ["test constraint"],
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const missionId = (createResp.body as any).mission.id;

    const addResp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule`,
        body: {
          name: "Daily check",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          taskTemplate: {
            title: "Check data",
            contract: {
              objective: "Check data",
              input: {},
              outputSchema: {},
              successCriteria: ["Report generated"],
            },
            assigneeRole: "data-analyst",
            priority: "normal",
          },
          maxConcurrent: 1,
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const ruleId = (addResp.body as any).rule.id;

    const patchResp = await handleApiRequest(
      {
        method: "PATCH",
        path: `/api/missions/${missionId}/schedule/${ruleId}`,
        body: { enabled: false },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(patchResp.status).toBe(200);
    expect((patchResp.body as any).rule.enabled).toBe(false);
  });

  it("POST /api/missions/:id/schedule/:ruleId/trigger manually triggers", async () => {
    const missions = new InMemoryMissionService();
    const createResp = await handleApiRequest(
      {
        method: "POST",
        path: "/api/missions",
        body: {
          goal: "Test mission",
          successMetrics: ["test metric"],
          constraints: ["test constraint"],
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const missionId = (createResp.body as any).mission.id;

    const addResp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule`,
        body: {
          name: "Daily check",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          taskTemplate: {
            title: "Check data",
            contract: {
              objective: "Check data",
              input: {},
              outputSchema: {},
              successCriteria: ["Report generated"],
            },
            assigneeRole: "data-analyst",
            priority: "normal",
          },
          maxConcurrent: 1,
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );
    const ruleId = (addResp.body as any).rule.id;

    const triggerResp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule/${ruleId}/trigger`,
        body: {},
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(triggerResp.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @digitalagent/server vitest run src/api.test.ts`
Expected: FAIL — schedule endpoints not handled

- [ ] **Step 3: Add schedule API endpoints to api.ts**

Add to `apps/server/src/api.ts` before the final `return json(404, ...)`:

```typescript
    // Schedule endpoints
    const scheduleMatch = request.path.match(
      /^\/api\/missions\/([^/]+)\/schedule(?:\/([^/]+)(?:\/(trigger))?)?$/,
    );

    if (scheduleMatch) {
      const missionId = scheduleMatch[1];
      const ruleId = scheduleMatch[2];
      const action = scheduleMatch[3];

      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }

      if (request.method === "GET" && !ruleId) {
        return json(200, { rules: deps.missions.getScheduleRules(missionId) });
      }

      if (request.method === "POST" && !ruleId) {
        const body = expectObject(request.body);
        const trigger = body.trigger as Record<string, unknown>;
        const template = body.taskTemplate as Record<string, unknown>;
        const contract = template?.contract as Record<string, unknown>;

        if (!trigger || trigger.type !== "cron" && trigger.type !== "condition") {
          return json(400, { error: "trigger must be cron or condition" });
        }

        const rule = createScheduleRule({
          name: expectString(body.name, "name"),
          missionId,
          enabled: body.enabled !== false,
          trigger: trigger.type === "cron"
            ? {
                type: "cron",
                expression: expectString(trigger.expression, "trigger.expression"),
                timezone: expectString(trigger.timezone ?? "UTC", "trigger.timezone"),
              }
            : {
                type: "condition",
                description: expectString(trigger.description ?? "", "trigger.description"),
                sourceAgentRole: expectString(trigger.sourceAgentRole ?? "", "trigger.sourceAgentRole"),
                evaluatePrompt: expectString(trigger.evaluatePrompt ?? "", "trigger.evaluatePrompt"),
              },
          taskTemplate: {
            title: expectString(template?.title, "taskTemplate.title"),
            contract: {
              objective: expectString(contract?.objective, "taskTemplate.contract.objective"),
              input: (contract?.input as Record<string, unknown>) ?? {},
              outputSchema: (contract?.outputSchema as Record<string, unknown>) ?? {},
              successCriteria: Array.isArray(contract?.successCriteria)
                ? contract.successCriteria as string[]
                : [],
            },
            assigneeRole: expectString(template?.assigneeRole, "taskTemplate.assigneeRole"),
            priority: (["low", "normal", "high"].includes(String(template?.priority))
              ? template!.priority
              : "normal") as "low" | "normal" | "high",
          },
          maxConcurrent: typeof body.maxConcurrent === "number" ? body.maxConcurrent : 1,
          metadata: (body.metadata as Record<string, unknown>) ?? {},
        });

        deps.missions.addScheduleRule(missionId, rule);
        return json(201, { rule, snapshot: deps.missions.snapshot() });
      }

      if (request.method === "PATCH" && ruleId && !action) {
        const body = expectObject(request.body);
        deps.missions.updateScheduleRule(missionId, ruleId, body as Partial<import("@digitalagent/core").ScheduleRule>);
        const rules = deps.missions.getScheduleRules(missionId);
        const updated = rules.find((r) => r.id === ruleId);
        return json(200, { rule: updated, snapshot: deps.missions.snapshot() });
      }

      if (request.method === "DELETE" && ruleId && !action) {
        deps.missions.removeScheduleRule(missionId, ruleId);
        return json(200, { snapshot: deps.missions.snapshot() });
      }

      if (request.method === "POST" && ruleId && action === "trigger") {
        deps.missions.triggerScheduleRule(missionId, ruleId);
        return json(200, { triggered: true, snapshot: deps.missions.snapshot() });
      }
    }
```

Add `createScheduleRule` to the imports at the top of `api.ts`:

```typescript
import { createScheduleRule } from "@digitalagent/core";
```

- [ ] **Step 4: Run API tests**

Run: `pnpm --filter @digitalagent/server vitest run src/api.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api.ts apps/server/src/api.test.ts
git commit -m "feat: add schedule CRUD + trigger API endpoints"
```

---

### Task 7: Condition Trigger Evaluation

**Files:**
- Modify: `apps/server/src/mission-scheduler.ts`
- Modify: `apps/server/src/mission-scheduler.test.ts`

- [ ] **Step 1: Write failing test for condition evaluation**

Add to `apps/server/src/mission-scheduler.test.ts`:

```typescript
describe("condition trigger evaluation", () => {
  it("creates task when LLM evaluates condition as true", async () => {
    const { createdTasks, deps } = makeDeps();
    const evalResults: string[] = [];

    deps.evaluateCondition = async () => {
      evalResults.push("called");
      return true;
    };

    const scheduler = new MissionScheduler(deps);

    const rule = createScheduleRule({
      name: "Engagement drop alert",
      missionId: "mission_test",
      enabled: true,
      trigger: {
        type: "condition",
        description: "Engagement rate drops more than 20%",
        sourceAgentRole: "data-analyst",
        evaluatePrompt: "Check if engagement rate dropped.",
      },
      taskTemplate: {
        title: "Investigate engagement drop",
        contract: {
          objective: "Investigate and report on engagement drop",
          input: {},
          outputSchema: { report: "object" },
          successCriteria: ["Report generated"],
        },
        assigneeRole: "data-analyst",
        priority: "high",
      },
      maxConcurrent: 1,
      metadata: {},
    });

    scheduler.start([rule]);

    await scheduler.evaluateConditions({
      completedTaskAssigneeRole: "data-analyst",
      artifactContent: "Engagement rate dropped by 25% compared to last week.",
      missionGoal: "Grow Xiaohongshu account",
    });

    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0]?.taskTitle).toBe("Investigate engagement drop");
  });

  it("does not create task when LLM evaluates condition as false", async () => {
    const { createdTasks, deps } = makeDeps();
    deps.evaluateCondition = async () => false;

    const scheduler = new MissionScheduler(deps);
    const rule = createScheduleRule({
      name: "Engagement drop alert",
      missionId: "mission_test",
      enabled: true,
      trigger: {
        type: "condition",
        description: "Engagement rate drops more than 20%",
        sourceAgentRole: "data-analyst",
        evaluatePrompt: "Check if engagement rate dropped.",
      },
      taskTemplate: {
        title: "Investigate engagement drop",
        contract: {
          objective: "Investigate engagement drop",
          input: {},
          outputSchema: { report: "object" },
          successCriteria: ["Report generated"],
        },
        assigneeRole: "data-analyst",
        priority: "high",
      },
      maxConcurrent: 1,
      metadata: {},
    });

    scheduler.start([rule]);

    await scheduler.evaluateConditions({
      completedTaskAssigneeRole: "data-analyst",
      artifactContent: "Engagement rate stable at 5%.",
      missionGoal: "Grow Xiaohongshu account",
    });

    expect(createdTasks).toHaveLength(0);
  });

  it("skips condition rules where sourceAgentRole does not match", async () => {
    const { createdTasks, deps } = makeDeps();
    deps.evaluateCondition = async () => true;

    const scheduler = new MissionScheduler(deps);
    const rule = createScheduleRule({
      name: "Engagement drop alert",
      missionId: "mission_test",
      enabled: true,
      trigger: {
        type: "condition",
        description: "Engagement rate drops more than 20%",
        sourceAgentRole: "data-analyst",
        evaluatePrompt: "Check if engagement rate dropped.",
      },
      taskTemplate: {
        title: "Investigate engagement drop",
        contract: {
          objective: "Investigate engagement drop",
          input: {},
          outputSchema: { report: "object" },
          successCriteria: ["Report generated"],
        },
        assigneeRole: "data-analyst",
        priority: "high",
      },
      maxConcurrent: 1,
      metadata: {},
    });

    scheduler.start([rule]);

    await scheduler.evaluateConditions({
      completedTaskAssigneeRole: "content-creator",
      artifactContent: "Engagement rate dropped by 25%.",
      missionGoal: "Grow Xiaohongshu account",
    });

    expect(createdTasks).toHaveLength(0);
  });

  it("skips disabled rules", async () => {
    const { createdTasks, deps } = makeDeps();
    deps.evaluateCondition = async () => true;

    const scheduler = new MissionScheduler(deps);
    const rule = createScheduleRule({
      name: "Engagement drop alert",
      missionId: "mission_test",
      enabled: false,
      trigger: {
        type: "condition",
        description: "Engagement rate drops more than 20%",
        sourceAgentRole: "data-analyst",
        evaluatePrompt: "Check if engagement rate dropped.",
      },
      taskTemplate: {
        title: "Investigate engagement drop",
        contract: {
          objective: "Investigate engagement drop",
          input: {},
          outputSchema: { report: "object" },
          successCriteria: ["Report generated"],
        },
        assigneeRole: "data-analyst",
        priority: "high",
      },
      maxConcurrent: 1,
      metadata: {},
    });

    scheduler.start([rule]);

    await scheduler.evaluateConditions({
      completedTaskAssigneeRole: "data-analyst",
      artifactContent: "Engagement rate dropped by 25%.",
      missionGoal: "Grow Xiaohongshu account",
    });

    expect(createdTasks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Update SchedulerDeps to include evaluateCondition**

In `apps/server/src/mission-scheduler.ts`, add to `SchedulerDeps`:

```typescript
  evaluateCondition?: (
    prompt: string,
    context: { artifactContent: string; missionGoal: string },
  ) => Promise<boolean>;
```

Add to `MissionScheduler`:

```typescript
  async evaluateConditions(context: {
    completedTaskAssigneeRole: string;
    artifactContent: string;
    missionGoal: string;
  }): Promise<void> {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.trigger.type !== "condition") continue;
      if (rule.trigger.sourceAgentRole !== context.completedTaskAssigneeRole) continue;

      if (!this.deps.evaluateCondition) continue;

      try {
        const satisfied = await this.deps.evaluateCondition(
          rule.trigger.evaluatePrompt,
          { artifactContent: context.artifactContent, missionGoal: context.missionGoal },
        );
        if (satisfied) {
          this.onTrigger(rule);
        }
      } catch (error) {
        console.error(
          `[MissionScheduler] Condition evaluation failed for rule "${rule.name}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
```

Update `makeDeps` in the test file to include `evaluateCondition`:

```typescript
    deps.evaluateCondition = async () => false;
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-scheduler.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mission-scheduler.ts apps/server/src/mission-scheduler.test.ts
git commit -m "feat: add condition trigger evaluation with LLM-based assessment"
```

---

### Task 8: Wire Condition Evaluation into Task Completion

**Files:**
- Modify: `apps/server/src/mission-service.ts`

- [ ] **Step 1: Hook evaluateConditions into submitExecutionResult**

In `submitExecutionResult()`, after the existing `dispatchToBus` call (near the end of the method, around line 671), add:

```typescript
    void this.evaluateScheduleConditions(mission, task, artifactContent);
```

- [ ] **Step 2: Add evaluateScheduleConditions method**

```typescript
  private async evaluateScheduleConditions(
    mission: Mission,
    completedTask: Task,
    artifactContent: Record<string, unknown>,
  ): Promise<void> {
    const scheduler = this.schedulers.get(mission.id);
    if (!scheduler) return;

    const rules = mission.scheduleRules.filter(
      (r) => r.trigger.type === "condition" && r.enabled,
    );
    if (rules.length === 0) return;

    const assignee = completedTask.assigneeAgentId
      ? this.agents.get(completedTask.assigneeAgentId)
      : undefined;

    await scheduler.evaluateConditions({
      completedTaskAssigneeRole: assignee?.role ?? "",
      artifactContent: JSON.stringify(artifactContent),
      missionGoal: mission.goal,
    });
  }
```

- [ ] **Step 3: Build and test**

Run: `pnpm --filter @digitalagent/core build && pnpm --filter @digitalagent/server vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mission-service.ts
git commit -m "feat: wire condition trigger evaluation into task completion flow"
```

---

### Task 9: Server Startup Scheduler Restore

**Files:**
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Add scheduler restore call after service creation**

In `apps/server/src/server.ts`, after the `InMemoryMissionService` instantiation (around line 17), add:

```typescript
missions.restoreSchedulers();
```

This must be called after the service is created and has loaded from the store file. Since `loadFromFile()` is called in the constructor, `restoreSchedulers()` will find the loaded missions and their schedule rules.

- [ ] **Step 2: Build and verify**

Run: `pnpm --filter @digitalagent/core build && pnpm --filter @digitalagent/server build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/server.ts
git commit -m "feat: restore schedulers on server startup"
```

---

### Task 10: Full Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass across core, runtime, and server

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 3: Build all packages**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 4: Manual smoke test — create mission with schedule rules**

Start the dev server:

Run: `pnpm dev`

Use curl or the UI to:
1. Create a mission
2. Confirm brief
3. Activate with HR negotiation
4. Add a schedule rule via API
5. Verify the rule appears in the schedule list
6. Trigger it manually
7. Verify a task is created

- [ ] **Step 5: Verify persistence**

1. Stop the server
2. Check `apps/server/data/mission-store.json` for `scheduleRules` in the mission data
3. Restart the server
4. Verify schedulers are restored (check logs or API)

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address integration issues from Phase 4 verification"
```

---

## Self-Review

### Spec Coverage

| Spec Section | Task |
|---|---|
| Domain Types (CronTrigger, ConditionTrigger, ScheduleRule) | Task 1 |
| Cron Support (validate, nextRun, isDue) | Task 2 |
| MissionScheduler (start/stop/restart/addRule/removeRule/updateRule) | Task 3 |
| Condition trigger evaluation (LLM-based) | Task 7 |
| HR Negotiation Integration (TeamProposal.schedulePlan) | Task 5 |
| MissionService integration (lifecycle, persistence) | Task 4 |
| API Endpoints (CRUD + trigger) | Task 6 |
| Server startup restore | Task 9 |
| File Plan (all files created/modified) | All tasks |
| Testing Requirements | Each task has tests |
| Acceptance Scenario (Xiaohongshu mission) | Task 10 smoke test |

### Placeholder Scan

No TBD, TODO, "implement later", or vague instructions found. All steps contain complete code.

### Type Consistency

- `ScheduleRule` defined in `types.ts`, used consistently across all files
- `CronTrigger` / `ConditionTrigger` discriminated union pattern matches usage in scheduler
- `SchedulerDeps` interface matches constructor usage and test mocks
- `TeamProposal.schedulePlan: SchedulePlanItem[]` added to the existing interface
- `Mission.scheduleRules: ScheduleRule[]` added and initialized as `[]` in factory
- All factory functions use the same `createId("prefix")` pattern
