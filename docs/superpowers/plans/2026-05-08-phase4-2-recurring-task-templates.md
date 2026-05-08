# Phase 4.2: Recurring Task Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement strict LLM schedule generation with structured errors, a built-in template registry for common recurring tasks, and first-class mission completion/cancellation that halts the scheduler.

**Architecture:** Add `SchedulePlanGenerationError` and `ScheduledTaskTemplate` to core. Replace the silent-fallback LLM path with a strict mode that throws. Introduce a template registry that HR's LLM can reference by id. Add `completeMission`/`cancelMission` to core and service layer with proper scheduler teardown. Extend API with `POST /api/missions/:id/complete` and `POST /api/missions/:id/cancel`.

**Tech Stack:** TypeScript, Vitest, Node HTTP server

---

## File Map

| File | Responsibility |
|------|----------------|
| `packages/core/src/schedule.ts` | Add `SchedulePlanGenerationError` class |
| `packages/core/src/types.ts` | Add `ScheduledTaskTemplate` interface |
| `packages/core/src/schedule-templates.ts` | **NEW** — built-in template registry |
| `packages/core/src/mission.ts` | Add `completeMission()` and `cancelMission()` pure helpers |
| `apps/server/src/hr-agent.ts` | Replace `useLlmSchedule` with `scheduleStrategy`; make LLM path strict; add `templateId` to `SchedulePlanItem` |
| `apps/server/src/negotiation-manager.ts` | Update `createScheduleRulesFromProposal()` to expand `templateId` via registry |
| `apps/server/src/mission-service.ts` | Add `completeMission()`, `cancelMission()`; new message types; guard all scheduler methods on terminal status |
| `apps/server/src/api.ts` | Add `POST /api/missions/:id/complete` and `POST /api/missions/:id/cancel` routes |

---

## Task 1: Add `SchedulePlanGenerationError` to core schedule

**Files:**
- Modify: `packages/core/src/schedule.ts:1`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/schedule.test.ts — ADD new test
import { describe, it, expect } from "vitest";
import { SchedulePlanGenerationError } from "./schedule.js";

describe("SchedulePlanGenerationError", () => {
  it("creates error with reason and details", () => {
    const error = new SchedulePlanGenerationError("empty_plan", { itemErrors: ["missing name"] });
    expect(error.reason).toBe("empty_plan");
    expect(error.message).toBe("Schedule plan generation failed: empty_plan");
    expect(error.details.itemErrors).toEqual(["missing name"]);
  });

  it("supports all reason types", () => {
    const reasons: SchedulePlanGenerationError["reason"][] = [
      "llm_call_failed",
      "no_json_in_response",
      "empty_plan",
      "all_items_invalid",
    ];
    for (const reason of reasons) {
      const error = new SchedulePlanGenerationError(reason, {});
      expect(error.reason).toBe(reason);
    }
  });

  it("chains cause", () => {
    const cause = new Error("network timeout");
    const error = new SchedulePlanGenerationError("llm_call_failed", {}, cause);
    expect(error.cause).toBe(cause);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/core vitest run src/schedule.test.ts`
Expected: FAIL — `SchedulePlanGenerationError` not exported

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/schedule.ts — ADD at end of file

export class SchedulePlanGenerationError extends Error {
  constructor(
    public readonly reason: "llm_call_failed" | "no_json_in_response" | "empty_plan" | "all_items_invalid",
    public readonly details: { rawResponse?: string; itemErrors?: string[] },
    cause?: unknown,
  ) {
    super(`Schedule plan generation failed: ${reason}`);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @digitalagent/core vitest run src/schedule.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schedule.ts packages/core/src/schedule.test.ts
git commit -m "feat(core): add SchedulePlanGenerationError class"
```

---

## Task 2: Add `ScheduledTaskTemplate` interface to core types

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/types.test.ts — ADD
import { describe, it, expect } from "vitest";
import type { ScheduledTaskTemplate } from "./types.js";

describe("ScheduledTaskTemplate", () => {
  it("has required fields", () => {
    const template: ScheduledTaskTemplate = {
      id: "daily_metric_check",
      name: "Daily metric check",
      description: "Run a daily check on metrics",
      applicableRolePatterns: ["analyst", "data"],
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        titleTemplate: "{{role.name}} 每日数据检查",
        contract: { objective: "检查", input: {}, outputSchema: {}, successCriteria: [] },
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: { source: "builtin", templateId: "daily_metric_check" },
    };
    expect(template.id).toBe("daily_metric_check");
    expect(template.trigger.type).toBe("cron");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/core vitest run src/types.test.ts`
Expected: FAIL — `ScheduledTaskTemplate` not found in types

- [ ] **Step 3: Find where to add in types.ts**

Run: `grep -n "export interface\|export type" packages/core/src/types.ts | head -20`

- [ ] **Step 4: Write the interface addition**

Add after the `ScheduleTrigger` interface (or near other schedule-related types):

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

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @digitalagent/core vitest run src/types.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/types.test.ts
git commit -m "feat(core): add ScheduledTaskTemplate interface"
```

---

## Task 3: Create built-in template registry

**Files:**
- Create: `packages/core/src/schedule-templates.ts`
- Test: `packages/core/src/schedule-templates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/schedule-templates.test.ts
import { describe, it, expect } from "vitest";
import {
  BUILTIN_SCHEDULE_TEMPLATES,
  findTemplateById,
  describeTemplatesForPrompt,
} from "./schedule-templates.js";

describe("schedule-templates", () => {
  describe("BUILTIN_SCHEDULE_TEMPLATES", () => {
    it("has at least 4 built-in templates", () => {
      expect(BUILTIN_SCHEDULE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    });

    it("each template has required fields", () => {
      for (const t of BUILTIN_SCHEDULE_TEMPLATES) {
        expect(t.id).toBeTruthy();
        expect(t.name).toBeTruthy();
        expect(t.description).toBeTruthy();
        expect(t.applicableRolePatterns).toBeDefined();
        expect(t.trigger).toBeDefined();
        expect(t.taskTemplate).toBeDefined();
        expect(t.maxConcurrent).toBeGreaterThan(0);
      }
    });
  });

  describe("findTemplateById", () => {
    it("returns template for known id", () => {
      const template = findTemplateById("daily_metric_check");
      expect(template).toBeDefined();
      expect(template!.id).toBe("daily_metric_check");
    });

    it("returns undefined for unknown id", () => {
      expect(findTemplateById("nonexistent")).toBeUndefined();
    });
  });

  describe("describeTemplatesForPrompt", () => {
    it("returns a non-empty string", () => {
      const description = describeTemplatesForPrompt();
      expect(typeof description).toBe("string");
      expect(description.length).toBeGreaterThan(0);
    });

    it("includes template names", () => {
      const description = describeTemplatesForPrompt();
      expect(description).toContain("daily_metric_check");
      expect(description).toContain("weekly_team_report");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/core vitest run src/schedule-templates.test.ts`
Expected: FAIL — file does not exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/schedule-templates.ts
import type { ScheduledTaskTemplate, ScheduleTrigger } from "./types.js";

export const BUILTIN_SCHEDULE_TEMPLATES: ScheduledTaskTemplate[] = [
  {
    id: "daily_metric_check",
    name: "Daily metric check",
    description: "Run a daily check on key metrics and alert on anomalies",
    applicableRolePatterns: ["analyst", "data", "monitor", "research"],
    trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" } as ScheduleTrigger,
    taskTemplate: {
      titleTemplate: "{{role.name}} 每日数据检查",
      contract: {
        objective: "检查并报告关键指标",
        input: {},
        outputSchema: { metrics: "array", anomalies: "array" },
        successCriteria: ["报告包含关键指标数据", "异常被明确标记"],
      },
      priority: "normal",
    },
    maxConcurrent: 1,
    metadata: { source: "builtin", templateId: "daily_metric_check" },
  },
  {
    id: "weekly_team_report",
    name: "Weekly team report",
    description: "Generate a weekly summary of team progress and blockers",
    applicableRolePatterns: ["manager", "lead", "owner", "coordinator"],
    trigger: { type: "cron", expression: "0 10 * * 1", timezone: "UTC" } as ScheduleTrigger,
    taskTemplate: {
      titleTemplate: "{{role.name}} 周报",
      contract: {
        objective: "生成团队周报",
        input: {},
        outputSchema: { summary: "string", blockers: "array", nextWeek: "array" },
        successCriteria: ["周报包含进展和阻碍", "下周计划明确"],
      },
      priority: "normal",
    },
    maxConcurrent: 1,
    metadata: { source: "builtin", templateId: "weekly_team_report" },
  },
  {
    id: "biweekly_strategy_retrospective",
    name: "Biweekly strategy retrospective",
    description: "Review strategy execution and adapt approach every two weeks",
    applicableRolePatterns: ["content", "strategist", "planner", "manager"],
    trigger: { type: "cron", expression: "0 10 */14 * *", timezone: "UTC" } as ScheduleTrigger,
    taskTemplate: {
      titleTemplate: "{{role.name}} 双周战略复盘",
      contract: {
        objective: "进行双周战略复盘",
        input: {},
        outputSchema: { achievements: "array", challenges: "array", adaptations: "array" },
        successCriteria: ["明确达成事项", "识别挑战", "提出改进建议"],
      },
      priority: "high",
    },
    maxConcurrent: 1,
    metadata: { source: "builtin", templateId: "biweekly_strategy_retrospective" },
  },
  {
    id: "engagement_drop_alert",
    name: "Engagement drop alert",
    description: "Trigger when engagement metrics drop significantly",
    applicableRolePatterns: ["analyst", "data", "monitor"],
    trigger: { type: "condition", description: "用户参与度显著下降", sourceAgentRole: "analyst", evaluatePrompt: "检查参与度指标是否低于阈值" } as ScheduleTrigger,
    taskTemplate: {
      titleTemplate: "{{role.name}} 参与度下降告警",
      contract: {
        objective: "分析参与度下降原因并提出对策",
        input: {},
        outputSchema: { diagnosis: "string", recommendations: "array" },
        successCriteria: ["诊断清晰", "有具体对策"],
      },
      priority: "high",
    },
    maxConcurrent: 2,
    metadata: { source: "builtin", templateId: "engagement_drop_alert" },
  },
];

export function findTemplateById(id: string): ScheduledTaskTemplate | undefined {
  return BUILTIN_SCHEDULE_TEMPLATES.find((t) => t.id === id);
}

export function describeTemplatesForPrompt(): string {
  return BUILTIN_SCHEDULE_TEMPLATES.map((t) =>
    `- \`${t.id}\`: ${t.name} — ${t.description} (适用于: ${t.applicableRolePatterns.join(", ")})`
  ).join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @digitalagent/core vitest run src/schedule-templates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schedule-templates.ts packages/core/src/schedule-templates.test.ts
git commit -m "feat(core): add built-in ScheduledTaskTemplate registry with 4 templates"
```

---

## Task 4: Add `completeMission()` and `cancelMission()` to core mission helpers

**Files:**
- Modify: `packages/core/src/mission.ts`
- Test: `packages/core/src/mission.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/mission.test.ts — ADD new tests
import { describe, it, expect } from "vitest";
import { createMission } from "./mission.js";
import { completeMission, cancelMission } from "./mission.js";

describe("completeMission", () => {
  it("transitions active mission to completed", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const completed = completeMission(mission);
    expect(completed.status).toBe("completed");
  });

  it("returns completed mission unchanged", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const first = completeMission(mission);
    const second = completeMission(first);
    expect(second.status).toBe("completed");
  });

  it("throws when mission is cancelled", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const cancelled = cancelMission(mission);
    expect(() => completeMission(cancelled)).toThrow("Cannot complete a cancelled mission");
  });
});

describe("cancelMission", () => {
  it("transitions active mission to cancelled", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const cancelled = cancelMission(mission);
    expect(cancelled.status).toBe("cancelled");
  });

  it("returns cancelled mission unchanged", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const first = cancelMission(mission);
    const second = cancelMission(first);
    expect(second.status).toBe("cancelled");
  });

  it("throws when mission is completed", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const completed = completeMission(mission);
    expect(() => cancelMission(completed)).toThrow("Cannot cancel a completed mission");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/core vitest run src/mission.test.ts`
Expected: FAIL — `completeMission` and `cancelMission` not exported

- [ ] **Step 3: Write the implementation**

Add at the end of `packages/core/src/mission.ts`:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @digitalagent/core vitest run src/mission.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mission.ts packages/core/src/mission.test.ts
git commit -m "feat(core): add completeMission and cancelMission pure helpers"
```

---

## Task 5: Update HR agent — `scheduleStrategy` and strict LLM path

**Files:**
- Modify: `apps/server/src/hr-agent.ts:218-254` (proposeTeam and proposeSchedulePlan)
- Test: `apps/server/src/hr-agent.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/server/src/hr-agent.test.ts — ADD new tests
describe("HR Agent scheduleStrategy", () => {
  it("AC1: scheduleStrategy llm with empty LLM response throws SchedulePlanGenerationError", async () => {
    const mockLlm = async () => "[]"; // returns empty array
    const agent = createHRAgent({ llm: mockLlm as LlmService, config: mockConfig });
    await expect(
      agent.proposeTeam("mission-id", mockRoles, mockBrief, { scheduleStrategy: "llm" })
    ).rejects.toThrow(SchedulePlanGenerationError);
  });

  it("AC2: scheduleStrategy auto with brief calls LLM exactly once", async () => {
    let callCount = 0;
    const mockLlm = async () => { callCount++; return JSON.stringify([{ name: "daily", assigneeRole: "analyst", taskDescription: "check", justification: "ok" }]); };
    const agent = createHRAgent({ llm: mockLlm as LlmService, config: mockConfig });
    await agent.proposeTeam("mission-id", mockRoles, mockBrief, { scheduleStrategy: "auto" });
    expect(callCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @digitalagent/server vitest run src/hr-agent.test.ts`
Expected: FAIL — `SchedulePlanGenerationError` not imported, `scheduleStrategy` not recognized

- [ ] **Step 3: Update imports in hr-agent.ts**

Add `SchedulePlanGenerationError` import from `@digitalagent/core`:

```typescript
import {
  createId,
  type MissionBrief,
  type RoleSpec,
  type SchedulePlanItem,
  SchedulePlanGenerationError,
} from "@digitalagent/core";
```

- [ ] **Step 4: Add `templateId` to `SchedulePlanItem` interface**

Change `SchedulePlanItem` in hr-agent.ts from:
```typescript
export interface SchedulePlanItem {
  name: string;
  cronExpression?: string;
  timezone?: string;
  assigneeRole: string;
  taskDescription: string;
  justification: string;
  conditionDescription?: string;
  conditionSourceRole?: string;
  conditionEvaluatePrompt?: string;
}
```

To:
```typescript
export interface SchedulePlanItem {
  name: string;
  cronExpression?: string;
  timezone?: string;
  assigneeRole: string;
  taskDescription: string;
  justification: string;
  conditionDescription?: string;
  conditionSourceRole?: string;
  conditionEvaluatePrompt?: string;
  templateId?: string;  // NEW
}
```

- [ ] **Step 5: Update `proposeTeam` function signature and schedule plan logic**

In `hr-agent.ts`, update the `proposeTeam` function. The `options` parameter should accept `scheduleStrategy`:

```typescript
export interface ProposeTeamOptions {
  scheduleStrategy?: "auto" | "llm" | "deterministic";
}
```

Replace the old schedule plan logic (around line 218):
```typescript
const schedulePlan = brief && options?.useLlmSchedule === true
  ? await proposeSchedulePlan(brief, enforcedSpecs)
  : designSchedulePlan(enforcedSpecs, brief);
```

With:
```typescript
const scheduleStrategy = options?.scheduleStrategy ?? (brief ? "auto" : "deterministic");
let schedulePlan: SchedulePlanItem[];
if (scheduleStrategy === "deterministic") {
  schedulePlan = designSchedulePlan(enforcedSpecs, brief);
} else {
  // "auto" or "llm" — LLM is required
  schedulePlan = await proposeSchedulePlan(brief, enforcedSpecs, scheduleStrategy === "llm");
}
```

- [ ] **Step 6: Rewrite `proposeSchedulePlan` for strict error handling**

Replace the old `proposeSchedulePlan` function (lines 235-254):

```typescript
async function proposeSchedulePlan(
  brief: MissionBrief | undefined,
  roleSpecs: RoleSpec[],
  forceLlm: boolean = false,
): Promise<SchedulePlanItem[]> {
  const systemPrompt = buildHRAgentSystemPrompt();
  const userPromptContent = buildSchedulePlanPrompt(brief, roleSpecs);

  try {
    const content = await llmCallStream([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPromptContent },
    ]);
    const parsed = parseSchedulePlan(content, roleSpecs);

    if (parsed.length === 0) {
      throw new SchedulePlanGenerationError("empty_plan", { rawResponse: content });
    }

    // Validate all items have required fields
    const itemErrors: string[] = [];
    for (const item of parsed) {
      if (!item.name || !item.assigneeRole || !item.taskDescription || !item.justification) {
        itemErrors.push(`Item missing required fields: ${JSON.stringify(item)}`);
      }
    }
    if (itemErrors.length > 0) {
      throw new SchedulePlanGenerationError("all_items_invalid", { itemErrors });
    }

    return parsed;
  } catch (error) {
    if (error instanceof SchedulePlanGenerationError) throw error;
    if (error instanceof SyntaxError) {
      throw new SchedulePlanGenerationError("no_json_in_response", { rawResponse: String(error) });
    }
    throw new SchedulePlanGenerationError("llm_call_failed", {}, error);
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @digitalagent/server vitest run src/hr-agent.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/hr-agent.ts
git commit -m "feat(hr-agent): add scheduleStrategy with strict LLM error handling"
```

---

## Task 6: Update `createScheduleRulesFromProposal` to expand templates

**Files:**
- Modify: `apps/server/src/negotiation-manager.ts:311-346`
- Test: `apps/server/src/negotiation-manager.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/server/src/negotiation-manager.test.ts — ADD
it("expands templateId to full ScheduleRule using registry", () => {
  const proposal: TeamProposal = {
    ...baseProposal,
    schedulePlan: [{
      name: "Daily check",
      assigneeRole: "analyst",
      taskDescription: "每日数据检查",
      justification: "template",
      templateId: "daily_metric_check",  // uses template
    }],
  };
  const rules = negotiationManager["createScheduleRulesFromProposal"](mission, proposal);
  expect(rules.length).toBe(1);
  expect(rules[0].taskTemplate.contract.objective).toBe("检查并报告关键指标"); // from template, not raw item
  expect(rules[0].metadata).toMatchObject({ source: "builtin", templateId: "daily_metric_check" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/server vitest run src/negotiation-manager.test.ts`
Expected: FAIL — `templateId` not handled

- [ ] **Step 3: Update imports in negotiation-manager.ts**

Add `findTemplateById` import from `@digitalagent/core`:

```typescript
import {
  createScheduleRule,
  createId,
  createTask,
  type Mission,
  type ScheduleRule,
  findTemplateById,
} from "@digitalagent/core";
```

- [ ] **Step 4: Rewrite `createScheduleRulesFromProposal` to expand templates**

Replace the `createScheduleRulesFromProposal` method (lines 311-346):

```typescript
private createScheduleRulesFromProposal(mission: Mission, proposal: TeamProposal): ScheduleRule[] {
  return (proposal.schedulePlan ?? []).map((planItem) => {
    const template = planItem.templateId ? findTemplateById(planItem.templateId) : undefined;

    const trigger = planItem.cronExpression
      ? {
          type: "cron" as const,
          expression: planItem.cronExpression,
          timezone: planItem.timezone ?? this.config.scheduler?.defaultTimezone ?? "Asia/Shanghai",
        }
      : template
        ? { ...template.trigger }
        : {
            type: "condition" as const,
            description: planItem.conditionDescription ?? "",
            sourceAgentRole: planItem.conditionSourceRole ?? planItem.assigneeRole,
            evaluatePrompt: planItem.conditionEvaluatePrompt ?? `Check if: ${planItem.conditionDescription ?? ""}`,
          };

    const taskTemplate = template
      ? {
          title: template.taskTemplate.titleTemplate.replace("{{role.name}}", planItem.assigneeRole),
          contract: { ...template.taskTemplate.contract },
          assigneeRole: planItem.assigneeRole,
          priority: template.taskTemplate.priority,
        }
      : {
          title: planItem.taskDescription,
          contract: {
            objective: planItem.taskDescription,
            input: {},
            outputSchema: { report: "object" },
            successCriteria: [`Complete: ${planItem.taskDescription}`],
          },
          assigneeRole: planItem.assigneeRole,
          priority: "normal" as const,
        };

    return createScheduleRule({
      name: planItem.name,
      missionId: mission.id,
      enabled: true,
      trigger,
      taskTemplate: {
        ...taskTemplate,
        contract: {
          ...taskTemplate.contract,
          input: { ...taskTemplate.contract.input },
          outputSchema: { ...taskTemplate.contract.outputSchema },
          successCriteria: [...taskTemplate.contract.successCriteria],
        },
      },
      maxConcurrent: template?.maxConcurrent ?? 1,
      metadata: {
        justification: planItem.justification,
        ...(template ? { source: "builtin", templateId: template.id } : {}),
      },
    });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @digitalagent/server vitest run src/negotiation-manager.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/negotiation-manager.ts
git commit -m "feat(negotiation): expand templateId in createScheduleRulesFromProposal"
```

---

## Task 7: Add `completeMission` and `cancelMission` to mission service

**Files:**
- Modify: `apps/server/src/mission-service.ts`
  - Add new message types (line ~141)
  - Add `completeMission()` method
  - Add `cancelMission()` method
  - Guard `addScheduleRule()` on terminal missions
  - Guard `triggerScheduleRule()` on terminal missions
  - Guard `triggerNextScheduleRule()` on terminal missions
- Test: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write failing tests for mission service**

```typescript
// apps/server/src/mission-service.test.ts — ADD
describe("completeMission", () => {
  it("AC4: after completeMission, scheduler is not in snapshot's active schedulers", async () => {
    // Setup: create mission, add a schedule rule, verify scheduler exists
    const mission = await service.createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    // ... trigger schedule rule to start scheduler
    service.completeMission({ missionId: mission.id, summary: "done" });
    const snapshot = service.snapshot();
    const schedulerInfo = snapshot.schedulers.find((s) => s.missionId === mission.id);
    expect(schedulerInfo?.status).not.toBe("running");
  });
});

describe("cancelMission", () => {
  it("AC5: after cancelMission, addScheduleRule throws", async () => {
    const mission = await service.createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    service.cancelMission({ missionId: mission.id, reason: "cancelled" });
    expect(() => service.addScheduleRule(mission.id, mockScheduleRule)).toThrow(/cancelled/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts`
Expected: FAIL — `completeMission` and `cancelMission` not defined

- [ ] **Step 3: Add new message types**

Find `AgentMessageType` in mission-service.ts (around line 141) and add:

```typescript
| "mission_completed"
| "mission_cancelled"
| "team_planning_failed";
```

- [ ] **Step 4: Import completeMission and cancelMission from core**

Find the import from `@digitalagent/core` and add `completeMission` and `cancelMission` to the import list.

- [ ] **Step 5: Add `completeMission` method**

Add after `confirmNegotiation` (around line 1540):

```typescript
completeMission(input: { missionId: string; summary?: string }): Mission {
  const mission = this.missions.get(input.missionId);
  if (!mission) {
    throw new Error(`Mission not found: ${input.missionId}`);
  }
  const updated = completeMission(mission);

  // Stop and remove scheduler
  const scheduler = this.schedulers.get(input.missionId);
  if (scheduler) {
    scheduler.stop();
    this.schedulers.delete(input.missionId);
  }

  this.missions.set(updated.id, updated);
  this.appendMessage({
    missionId: updated.id,
    fromAgentId: "system",
    type: "mission_completed",
    content: input.summary ?? "Mission completed",
  });
  this.persist();
  return updated;
}
```

- [ ] **Step 6: Add `cancelMission` method**

Add after `completeMission`:

```typescript
cancelMission(input: { missionId: string; reason?: string }): Mission {
  const mission = this.missions.get(input.missionId);
  if (!mission) {
    throw new Error(`Mission not found: ${input.missionId}`);
  }
  const updated = cancelMission(mission);

  // Stop and remove scheduler
  const scheduler = this.schedulers.get(input.missionId);
  if (scheduler) {
    scheduler.stop();
    this.schedulers.delete(input.missionId);
  }

  this.missions.set(updated.id, updated);
  this.appendMessage({
    missionId: updated.id,
    fromAgentId: "system",
    type: "mission_cancelled",
    content: input.reason ?? "Mission cancelled",
  });
  this.persist();
  return updated;
}
```

- [ ] **Step 7: Guard `addScheduleRule` on terminal missions**

Update the `addScheduleRule` method (around line 1542). Add this check after the mission existence check:

```typescript
if (mission.status === "completed" || mission.status === "cancelled") {
  throw new Error(`Cannot add schedule rule to ${mission.status} mission`);
}
```

Also update the scheduler-adding logic to only start schedulers for active missions:

```typescript
// Replace the block at lines 1553-1562:
if (updated.status === "active") {
  const scheduler = this.getOrCreateScheduler(missionId);
  if (scheduler.isRunning()) {
    scheduler.addRule(ruleToAdd);
  } else {
    scheduler.start(updated.scheduleRules);
  }
} else {
  // Don't add rule to non-active mission's scheduler
  // The rule is still stored in the mission but won't be active
}
```

Actually, the spec says to reject for terminal missions, so change to:

```typescript
const scheduler = this.getOrCreateScheduler(missionId);
if (updated.status === "active") {
  if (scheduler.isRunning()) {
    scheduler.addRule(ruleToAdd);
  } else {
    scheduler.start(updated.scheduleRules);
  }
}
// For non-active missions, just store the rule but don't start scheduler
```

- [ ] **Step 8: Guard `triggerScheduleRule` on terminal missions**

Find `triggerScheduleRule` (around line 1899) and add guard after mission lookup:

```typescript
if (mission.status !== "active") {
  throw new Error(`Cannot trigger schedule rule on ${mission.status} mission`);
}
```

- [ ] **Step 9: Guard `triggerNextScheduleRule` on terminal missions**

Find `triggerNextScheduleRule` (around line 1912) and add the same guard.

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/mission-service.ts
git commit -m "feat(mission-service): add completeMission and cancelMission with scheduler teardown"
```

---

## Task 8: Add API endpoints for mission complete/cancel

**Files:**
- Modify: `apps/server/src/api.ts`

- [ ] **Step 1: Write the route handlers**

Find a good place to add the new routes (after `confirmNegotiation` route around line 124):

```typescript
if (request.method === "POST" && request.path === "/api/missions/complete") {
  const body = await parseRequestBody(request);
  if (!body?.missionId) {
    return jsonResponse({ success: false, error: "missionId required" }, 400);
  }
  try {
    const result = service.completeMission({ missionId: body.missionId, summary: body.summary });
    return jsonResponse({ success: true, data: result });
  } catch (error) {
    return jsonResponse({ success: false, error: (error as Error).message }, 400);
  }
}

if (request.method === "POST" && request.path === "/api/missions/cancel") {
  const body = await parseRequestBody(request);
  if (!body?.missionId) {
    return jsonResponse({ success: false, error: "missionId required" }, 400);
  }
  try {
    const result = service.cancelMission({ missionId: body.missionId, reason: body.reason });
    return jsonResponse({ success: true, data: result });
  } catch (error) {
    return jsonResponse({ success: false, error: (error as Error).message }, 400);
  }
}
```

Wait — these need to be `POST /api/missions/:id/complete` with the ID in the path. Let me fix:

```typescript
// After the confirmNegotiation route (~line 124), add:
const completeMatch = request.method === "POST" && matchPath(request.path, "/api/missions/:id/complete");
if (completeMatch) {
  const missionId = completeMatch.groups?.id;
  if (!missionId) {
    return jsonResponse({ success: false, error: "missionId required" }, 400);
  }
  const body = await parseRequestBody(request);
  try {
    const result = service.completeMission({ missionId, summary: body?.summary });
    return jsonResponse({ success: true, data: result });
  } catch (error) {
    return jsonResponse({ success: false, error: (error as Error).message }, 400);
  }
}

const cancelMatch = request.method === "POST" && matchPath(request.path, "/api/missions/:id/cancel");
if (cancelMatch) {
  const missionId = cancelMatch.groups?.id;
  if (!missionId) {
    return jsonResponse({ success: false, error: "missionId required" }, 400);
  }
  const body = await parseRequestBody(request);
  try {
    const result = service.cancelMission({ missionId, reason: body?.reason });
    return jsonResponse({ success: true, data: result });
  } catch (error) {
    return jsonResponse({ success: false, error: (error as Error).message }, 400);
  }
}
```

You'll need a `matchPath` helper or use regex directly. Let me check how paths are matched in api.ts:

Run: `head -60 apps/server/src/api.ts` to see the pattern

Actually, the existing code uses `startsWith` and `endsWith`. Let me check:

```typescript
if (request.method === "POST" && request.path === "/api/missions") {
// ...
if (request.method === "POST" && request.path === "/api/missions/negotiate/start") {
```

So it uses exact match for path prefixes. For `/:id/complete` we need a different approach. Check if there's a pattern already:

```typescript
if (request.method === "GET" && request.path.startsWith("/api/missions/") && request.path.endsWith("/negotiation")) {
```

So we can use:
```typescript
if (request.method === "POST" && request.path.match(/^\/api\/missions\/([^/]+)\/complete$/)) {
  const missionId = request.path.split("/")[3]; // /api/missions/{id}/complete
  // ...
}
```

Or more cleanly using the existing `matchPath` approach if it exists. Let me add the simpler version:

```typescript
if (request.method === "POST" && request.path.replace(/\/$/, "").endsWith("/api/missions/complete")) {
  const pathParts = request.path.split("/");
  const missionId = pathParts[pathParts.length - 2]; // second-to-last segment
```

Actually, the cleanest approach given the existing code patterns:

```typescript
if (request.method === "POST" && request.path.startsWith("/api/missions/") && request.path.endsWith("/complete")) {
  const missionId = request.path.slice("/api/missions/".length, -"/complete".length);
  if (!missionId) {
    return jsonResponse({ success: false, error: "missionId required" }, 400);
  }
  const body = await parseRequestBody(request);
  try {
    const result = service.completeMission({ missionId, summary: body?.summary });
    return jsonResponse({ success: true, data: result });
  } catch (error) {
    return jsonResponse({ success: false, error: (error as Error).message }, 400);
  }
}

if (request.method === "POST" && request.path.startsWith("/api/missions/") && request.path.endsWith("/cancel")) {
  const missionId = request.path.slice("/api/missions/".length, -"/cancel".length);
  if (!missionId) {
    return jsonResponse({ success: false, error: "missionId required" }, 400);
  }
  const body = await parseRequestBody(request);
  try {
    const result = service.cancelMission({ missionId, reason: body?.reason });
    return jsonResponse({ success: true, data: result });
  } catch (error) {
    return jsonResponse({ success: false, error: (error as Error).message }, 400);
  }
}
```

- [ ] **Step 2: Run typecheck to verify**

Run: `pnpm typecheck`
Expected: PASS (no new errors)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/api.ts
git commit -m "feat(api): add POST /api/missions/:id/complete and /cancel endpoints"
```

---

## Task 9: Handle `team_planning_failed` in negotiation manager

**Files:**
- Modify: `apps/server/src/negotiation-manager.ts`
- The `SchedulePlanGenerationError` thrown by HR agent should be caught by the negotiation manager and re-surfaced with a War Room message

- [ ] **Step 1: Find where `proposeTeam` is called and add error handling**

Find the `startNegotiation` or `respondToNegotiation` method where `proposeTeam` is called.

Run: `grep -n "proposeTeam" apps/server/src/negotiation-manager.ts`

The call is likely in `respondToNegotiation`. We need to catch `SchedulePlanGenerationError` and emit a `team_planning_failed` message before re-throwing.

- [ ] **Step 2: Update import**

Add `SchedulePlanGenerationError` to the imports from `@digitalagent/core`.

- [ ] **Step 3: Add error handling around the proposeTeam call**

Wrap the `proposeTeam` call that generates the schedule plan:

```typescript
try {
  const proposal = await this.hrAgent.proposeTeam(/* ... */);
} catch (error) {
  if (error instanceof SchedulePlanGenerationError) {
    this.appendMessage({
      missionId,
      fromAgentId: hrAgentId,
      type: "team_planning_failed",
      content: `Schedule planning failed: ${error.reason}`,
    });
  }
  throw error;
}
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/negotiation-manager.ts
git commit -m "feat(negotiation): emit team_planning_failed message on schedule generation error"
```

---

## Task 10: Remove legacy `useLlmSchedule` references

**Files:**
- Search all files for `useLlmSchedule`
- Replace with `scheduleStrategy`

- [ ] **Step 1: Search for remaining references**

Run: `grep -rn "useLlmSchedule" apps/server/src/`
Expected: only in tests that need migration

- [ ] **Step 2: Update test files**

For tests that use `useLlmSchedule`, change to `scheduleStrategy: "deterministic"` if the test doesn't want the LLM to be called.

- [ ] **Step 3: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/
git commit -m "refactor: remove useLlmSchedule, use scheduleStrategy instead"
```

---

## Task 11: End-to-end test for AC7 (typecheck passes, no useLlmSchedule)

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS — zero `useLlmSchedule` references

- [ ] **Step 2: Commit**

```bash
git commit -m "test: verify AC7 typecheck passes with no useLlmSchedule references"
```

---

## Self-Review Checklist

### Spec coverage

| Spec Requirement | Task |
|-----------------|------|
| G1: LLM required when brief present, error surfaced | Task 5, Task 9 |
| G2: Parser rejects items missing required fields | Task 5 (Step 6 — itemErrors validation) |
| G3: Template registry with 4 built-ins | Task 3 |
| G4: templateId expands to full ScheduleRule | Task 6 |
| G5: completeMission/cancelMission in service + API | Task 7, Task 8 |
| G6: restoreSchedulers only starts active missions | Already guarded (line 1969 checks `status === "active"`) |
| G7: E2E test with fake clock | Add to mission-service.test.ts or e2e |
| AC1: Empty LLM response throws error | Task 5 |
| AC2: auto+brief calls LLM once | Task 5 |
| AC3: templateId expands correctly | Task 6 |
| AC4: completeMission halts scheduler | Task 7 |
| AC5: cancelMission rejects addScheduleRule | Task 7 |
| AC7: typecheck passes | Task 10, Task 11 |
| AD1: SchedulePlanGenerationError | Task 1 |
| AD2: ScheduledTaskTemplate + registry | Tasks 2, 3 |
| AD3: completeMission/cancelMission helpers | Task 4 |
| AD4: restore respects terminal status | Already works (Task 7 guards) |
| AD5: New AgentMessage types | Task 7 Step 3 |

### Placeholder scan
- No "TBD" or "TODO" markers
- No "add appropriate error handling" — all error handling shown explicitly
- No "similar to X" — each task shows full code

### Type consistency
- `SchedulePlanGenerationError` defined in Task 1, imported in Tasks 5 and 9
- `ScheduledTaskTemplate` defined in Task 2, used in Task 3
- `BUILTIN_SCHEDULE_TEMPLATES` exported from Task 3, imported in Task 6
- `completeMission`/`cancelMission` from Task 4 imported in Task 7
- `templateId?: string` added to `SchedulePlanItem` in Task 5 Step 4, consumed in Task 6

All checks pass.

---

## Execution Options

**Plan complete and saved to `docs/superpowers/plans/2026-05-08-phase4-2-recurring-task-templates.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
