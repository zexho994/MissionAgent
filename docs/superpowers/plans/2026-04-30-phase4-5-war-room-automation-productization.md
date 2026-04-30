# Phase 4.5 War Room Automation Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mission automation visible and lightly controllable in the War Room through an automation pulse, schedule rule detail view, trigger-next action, pause/resume, and lightweight rule templates.

**Architecture:** Keep `Mission.scheduleRules` and `MissionScheduler` as the source of truth. Add server-local product methods to `InMemoryMissionService`, expose them through focused API routes, and update the current static frontend without adding a framework. Store schedule trigger history as structured server state so the UI never parses message text.

**Tech Stack:** TypeScript, Vitest, existing `@digitalagent/core` schedule/task types, current Node HTTP API, static browser UI in `apps/server/public`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/server/src/mission-service.ts` | Add `ScheduleTriggerEvent`, automation summary types, trigger history storage, trigger-next, template creation, pause/resume, persistence wiring. |
| `apps/server/src/mission-service.test.ts` | Service-level tests for summary, trigger-next, template creation, pause/resume, trigger events. |
| `apps/server/src/api.ts` | Add product-level schedule routes: automation summary, trigger-next, templates, pause, resume. |
| `apps/server/src/api.test.ts` | API tests for all new product routes and error cases. |
| `apps/server/public/app.js` | Add frontend automation state, API helpers, refresh integration, action handlers. |
| `apps/server/public/war-room.js` | Render automation pulse and real schedule tab with rule cards, trigger history, and template form. |
| `apps/server/public/styles.css` | Add layout and component styles for the pulse, rule cards, schedule form, and inline errors. |

Do not modify `packages/core` for this feature. `ScheduleTriggerEvent` is product/UI history, not core domain.

---

### Task 1: Structured Schedule Trigger Events

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write failing service tests for schedule trigger events**

Append these tests inside `describe("InMemoryMissionService", ...)` in `apps/server/src/mission-service.test.ts`:

```ts
  function addOwnerDailyRule(service: InMemoryMissionService, missionId: string) {
    const rule = createScheduleRule({
      name: "Daily check",
      missionId,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: { templateType: "daily_check" },
          outputSchema: { summary: "string" },
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "owner",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: { createdBy: "test" },
    });
    service.addScheduleRule(missionId, rule);
    return rule;
  }

  it("records a structured trigger event when a schedule rule is triggered", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const owner = service.snapshot().agents.find((agent) => agent.missionId === mission.id && agent.role === "owner");
    if (!owner) throw new Error("missing owner");

    const rule = addOwnerDailyRule(service, mission.id);

    service.triggerScheduleRule(mission.id, rule.id);

    const snapshot = service.snapshot();
    expect(snapshot.scheduleTriggerEvents).toHaveLength(1);
    expect(snapshot.scheduleTriggerEvents[0]).toEqual({
      id: expect.stringMatching(/^schedule_trigger_/),
      missionId: mission.id,
      ruleId: rule.id,
      ruleName: "Daily check",
      taskId: expect.stringMatching(/^task_/),
      status: "created",
      message: "Scheduled task \"Check yesterday's GitHub growth metrics\" created.",
      createdAt: expect.any(String),
    });
  });

  it("persists schedule trigger events across reloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digitalagent-trigger-events-"));
    try {
      const storageFile = join(dir, "mission-store.json");
      const service = new InMemoryMissionService({ storageFile });
      const mission = await service.createMission({ goal: "Track GitHub growth" });
      const rule = addOwnerDailyRule(service, mission.id);
      service.triggerScheduleRule(mission.id, rule.id);

      const reloaded = new InMemoryMissionService({ storageFile });

      expect(reloaded.snapshot().scheduleTriggerEvents).toHaveLength(1);
      expect(reloaded.snapshot().scheduleTriggerEvents[0]?.ruleId).toBe(rule.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

Ensure `apps/server/src/mission-service.test.ts` imports `createScheduleRule`:

```ts
import { createScheduleRule } from "@digitalagent/core";
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "schedule trigger events"
```

Expected: FAIL with TypeScript errors for missing `scheduleTriggerEvents`.

- [ ] **Step 3: Add trigger event interfaces and storage**

In `apps/server/src/mission-service.ts`, add this interface after `WarRoomTaskEvent`:

```ts
export interface ScheduleTriggerEvent {
  id: string;
  missionId: string;
  ruleId: string;
  ruleName: string;
  taskId?: string;
  status: "created" | "skipped" | "failed";
  message: string;
  createdAt: string;
}
```

Extend `MissionSnapshot`:

```ts
  scheduleTriggerEvents: ScheduleTriggerEvent[];
```

Add a map beside the other private collections:

```ts
  private readonly scheduleTriggerEvents = new Map<string, ScheduleTriggerEvent>();
```

Extend `snapshot()` with:

```ts
      scheduleTriggerEvents: [...this.scheduleTriggerEvents.values()],
```

Extend `loadFromFile()` after task events are loaded:

```ts
    for (const triggerEvent of stored.scheduleTriggerEvents ?? []) {
      this.scheduleTriggerEvents.set(triggerEvent.id, triggerEvent);
    }
```

- [ ] **Step 4: Add a trigger-event recorder**

Add this private method near `createTaskFromScheduleRule()`:

```ts
  private recordScheduleTriggerEvent(input: Omit<ScheduleTriggerEvent, "id" | "createdAt">): ScheduleTriggerEvent {
    const event: ScheduleTriggerEvent = {
      ...input,
      id: createId("schedule_trigger"),
      createdAt: new Date().toISOString(),
    };
    this.scheduleTriggerEvents.set(event.id, event);
    return event;
  }
```

- [ ] **Step 5: Make manual schedule triggers record created/skipped events**

Change `createTaskFromScheduleRule()` to return `Task | undefined`:

```ts
  private createTaskFromScheduleRule(mission: Mission, rule: ScheduleRule): Task | undefined {
```

In the missing-agent branch, before `return`, record a skipped event:

```ts
      this.recordScheduleTriggerEvent({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: rule.name,
        status: "skipped",
        message: `No agent found for role "${rule.taskTemplate.assigneeRole}".`,
      });
      return undefined;
```

At the end of the success path, after appending the message, record and return:

```ts
    this.recordScheduleTriggerEvent({
      missionId: mission.id,
      ruleId: rule.id,
      ruleName: rule.name,
      taskId: assigned.id,
      status: "created",
      message: `Scheduled task "${rule.taskTemplate.title}" created.`,
    });
    return assigned;
```

Change `triggerScheduleRule()` to persist after event creation:

```ts
    this.createTaskFromScheduleRule(mission, rule);
    this.persist();
```

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "schedule trigger events"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat: record schedule trigger events"
```

---

### Task 2: Automation Summary Service

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write failing automation summary tests**

Append these tests in `apps/server/src/mission-service.test.ts`:

```ts
  it("returns an empty automation summary when a mission has no schedule rules", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    expect(service.getAutomationSummary(mission.id)).toEqual({
      missionId: mission.id,
      rulesCount: 0,
      automationPaused: false,
      currentScheduledTasks: [],
    });
  });

  it("returns the next cron action in the automation summary", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: {},
          outputSchema: {},
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "owner",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
    });
    service.addScheduleRule(mission.id, rule);

    const summary = service.getAutomationSummary(mission.id);

    expect(summary.rulesCount).toBe(1);
    expect(summary.nextAction).toEqual({
      ruleId: rule.id,
      ruleName: "Daily check",
      nextRunAt: expect.any(String),
      assigneeRole: "owner",
      assigneeAgentId: expect.stringMatching(/^agent_/),
      taskTitle: "Check yesterday's GitHub growth metrics",
    });
  });

  it("includes current scheduled tasks and the latest trigger event in the automation summary", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: {},
          outputSchema: {},
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "owner",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
    });
    service.addScheduleRule(mission.id, rule);
    service.triggerScheduleRule(mission.id, rule.id);

    const summary = service.getAutomationSummary(mission.id);

    expect(summary.currentScheduledTasks).toEqual([
      {
        taskId: expect.stringMatching(/^task_/),
        ruleId: rule.id,
        title: "Check yesterday's GitHub growth metrics",
        status: "draft",
        assigneeAgentId: expect.stringMatching(/^agent_/),
      },
    ]);
    expect(summary.lastTrigger).toEqual({
      ruleId: rule.id,
      ruleName: "Daily check",
      taskId: expect.stringMatching(/^task_/),
      status: "created",
      message: "Scheduled task \"Check yesterday's GitHub growth metrics\" created.",
      createdAt: expect.any(String),
    });
  });
```

Ensure the test file imports `createScheduleRule`:

```ts
import { createScheduleRule } from "@digitalagent/core";
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "automation summary"
```

Expected: FAIL with `service.getAutomationSummary is not a function`.

- [ ] **Step 3: Add automation summary types**

In `apps/server/src/mission-service.ts`, add after `ScheduleTriggerEvent`:

```ts
export interface AutomationSummary {
  missionId: string;
  rulesCount: number;
  automationPaused: boolean;
  nextAction?: {
    ruleId: string;
    ruleName: string;
    nextRunAt: string;
    assigneeRole: string;
    assigneeAgentId?: string;
    taskTitle: string;
  };
  currentScheduledTasks: Array<{
    taskId: string;
    ruleId: string;
    title: string;
    status: string;
    assigneeAgentId?: string;
  }>;
  lastTrigger?: {
    ruleId: string;
    ruleName: string;
    taskId?: string;
    status: "created" | "skipped" | "failed";
    message: string;
    createdAt: string;
  };
}
```

- [ ] **Step 4: Implement `getAutomationSummary()`**

Add this public method after `getScheduleRuleNextRunAt()`:

```ts
  getAutomationSummary(missionId: string): AutomationSummary {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }

    const rules = mission.scheduleRules;
    const agents = [...this.agents.values()].filter((agent) => agent.missionId === missionId);
    const agentByRole = new Map(agents.map((agent) => [agent.role, agent]));
    const currentScheduledTasks = [...this.tasks.values()]
      .filter((task) => task.missionId === missionId && task.scheduleRuleId)
      .filter((task) => task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")
      .map((task) => ({
        taskId: task.id,
        ruleId: task.scheduleRuleId!,
        title: task.title,
        status: task.status,
        ...(task.assigneeAgentId ? { assigneeAgentId: task.assigneeAgentId } : {}),
      }));

    const nextAction = rules
      .filter((rule) => rule.enabled && rule.trigger.type === "cron")
      .map((rule) => {
        const nextRunAt = this.getScheduleRuleNextRunAt(missionId, rule.id);
        if (!nextRunAt) return undefined;
        const assignee = agentByRole.get(rule.taskTemplate.assigneeRole);
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          nextRunAt,
          assigneeRole: rule.taskTemplate.assigneeRole,
          ...(assignee ? { assigneeAgentId: assignee.id } : {}),
          taskTitle: rule.taskTemplate.title,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];

    const lastTriggerEvent = [...this.scheduleTriggerEvents.values()]
      .filter((event) => event.missionId === missionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    const automationPaused =
      rules.length > 0 &&
      rules.every((rule) => !rule.enabled) &&
      rules.some((rule) => rule.metadata.pausedByAutomationToggle === true);

    return {
      missionId,
      rulesCount: rules.length,
      automationPaused,
      currentScheduledTasks,
      ...(nextAction ? { nextAction } : {}),
      ...(lastTriggerEvent
        ? {
            lastTrigger: {
              ruleId: lastTriggerEvent.ruleId,
              ruleName: lastTriggerEvent.ruleName,
              ...(lastTriggerEvent.taskId ? { taskId: lastTriggerEvent.taskId } : {}),
              status: lastTriggerEvent.status,
              message: lastTriggerEvent.message,
              createdAt: lastTriggerEvent.createdAt,
            },
          }
        : {}),
    };
  }
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "automation summary"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat: add automation summary service"
```

---

### Task 3: User-Triggered Schedule Execution With Fast-Fail

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write failing trigger-next tests**

Append these tests in `apps/server/src/mission-service.test.ts`:

```ts
  it("triggerNextScheduleRule creates a task from the nearest enabled cron rule", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: {},
          outputSchema: {},
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "owner",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
    });
    service.addScheduleRule(mission.id, rule);

    const task = service.triggerNextScheduleRule(mission.id);

    expect(task.scheduleRuleId).toBe(rule.id);
    expect(task.title).toBe("Check yesterday's GitHub growth metrics");
    expect(service.getAutomationSummary(mission.id).lastTrigger?.status).toBe("created");
  });

  it("triggerNextScheduleRule rejects missions without enabled cron rules", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    expect(() => service.triggerNextScheduleRule(mission.id)).toThrow("No enabled cron schedule rule available");
  });

  it("triggerNextScheduleRule rejects missing assignee agents", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const rule = createScheduleRule({
      name: "Daily check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Check yesterday's GitHub growth metrics",
        contract: {
          objective: "Check yesterday's GitHub growth metrics",
          input: {},
          outputSchema: {},
          successCriteria: ["Metric check is summarized"],
        },
        assigneeRole: "data_analyst",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
    });
    service.addScheduleRule(mission.id, rule);

    expect(() => service.triggerNextScheduleRule(mission.id)).toThrow('No agent found for role "data_analyst"');
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "triggerNextScheduleRule"
```

Expected: FAIL with `triggerNextScheduleRule is not a function`.

- [ ] **Step 3: Add strict trigger helper**

In `apps/server/src/mission-service.ts`, add this private helper near `createTaskFromScheduleRule()`:

```ts
  private createTaskFromScheduleRuleStrict(mission: Mission, rule: ScheduleRule): Task {
    if (!rule.enabled) {
      this.recordScheduleTriggerEvent({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: rule.name,
        status: "failed",
        message: "Schedule rule is disabled.",
      });
      throw new Error("Schedule rule is disabled");
    }

    const incomplete = [...this.tasks.values()].filter(
      (task) =>
        task.missionId === mission.id &&
        task.scheduleRuleId === rule.id &&
        task.status !== "completed" &&
        task.status !== "failed" &&
        task.status !== "cancelled",
    ).length;
    if (incomplete >= rule.maxConcurrent) {
      this.recordScheduleTriggerEvent({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: rule.name,
        status: "failed",
        message: "Schedule rule is already at max concurrency.",
      });
      throw new Error("Schedule rule is already at max concurrency");
    }

    const agent = [...this.agents.values()].find(
      (candidate) => candidate.missionId === mission.id && candidate.role === rule.taskTemplate.assigneeRole,
    );
    if (!agent) {
      this.recordScheduleTriggerEvent({
        missionId: mission.id,
        ruleId: rule.id,
        ruleName: rule.name,
        status: "failed",
        message: `No agent found for role "${rule.taskTemplate.assigneeRole}".`,
      });
      throw new Error(`No agent found for role "${rule.taskTemplate.assigneeRole}"`);
    }

    const task = createTask({
      missionId: mission.id,
      title: rule.taskTemplate.title,
      dependencies: [],
      contract: rule.taskTemplate.contract,
      approvalRequired: false,
      scheduleRuleId: rule.id,
    });
    const assigned = { ...task, assigneeAgentId: agent.id };
    this.tasks.set(assigned.id, assigned);
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: "system",
      type: "task_plan",
      content: `Scheduled task "${rule.taskTemplate.title}" assigned to ${agent.name}.`,
    });
    this.recordScheduleTriggerEvent({
      missionId: mission.id,
      ruleId: rule.id,
      ruleName: rule.name,
      taskId: assigned.id,
      status: "created",
      message: `Scheduled task "${rule.taskTemplate.title}" created.`,
    });
    return assigned;
  }
```

- [ ] **Step 4: Implement `triggerNextScheduleRule()`**

Add this public method after `triggerScheduleRule()`:

```ts
  triggerNextScheduleRule(missionId: string): Task {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }

    const candidates = mission.scheduleRules
      .filter((rule) => rule.enabled && rule.trigger.type === "cron")
      .map((rule) => ({
        rule,
        nextRunAt: this.getScheduleRuleNextRunAt(missionId, rule.id) ?? "",
      }))
      .filter((candidate) => candidate.nextRunAt);

    if (candidates.length === 0) {
      throw new Error("No enabled cron schedule rule available");
    }

    const nowIso = new Date().toISOString();
    const overdue = candidates
      .filter((candidate) => candidate.nextRunAt <= nowIso)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
    const future = candidates.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
    const selected = (overdue[0] ?? future[0])?.rule;
    if (!selected) {
      throw new Error("No enabled cron schedule rule available");
    }

    const task = this.createTaskFromScheduleRuleStrict(mission, selected);
    this.persist();
    return task;
  }
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "triggerNextScheduleRule"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat: trigger next schedule rule"
```

---

### Task 4: Lightweight Rule Templates And Pause/Resume

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write failing tests for templates and pause/resume**

Append these tests in `apps/server/src/mission-service.test.ts`:

```ts
  it("creates a daily schedule rule from a lightweight template", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    const rule = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "daily_check",
      assigneeRole: "owner",
      taskGoal: "Check yesterday's GitHub growth metrics",
    });

    expect(rule.trigger).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "UTC" });
    expect(rule.taskTemplate.title).toBe("Check yesterday's GitHub growth metrics");
    expect(rule.taskTemplate.contract.objective).toBe("Check yesterday's GitHub growth metrics");
    expect(rule.metadata).toEqual({ createdBy: "user_template", templateType: "daily_check" });
  });

  it("creates a weekly schedule rule from a lightweight template", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    const rule = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "weekly_review",
      assigneeRole: "owner",
      taskGoal: "Review weekly GitHub growth and plan next actions",
    });

    expect(rule.trigger).toEqual({ type: "cron", expression: "0 9 * * 1", timezone: "UTC" });
    expect(rule.name).toBe("Weekly review");
  });

  it("creates a condition schedule rule from a lightweight template", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    const rule = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "condition_response",
      sourceAgentRole: "owner",
      condition: "Stars dropped for two consecutive days",
      responseAssigneeRole: "owner",
      responseTaskGoal: "Diagnose the drop and recommend a correction",
    });

    expect(rule.trigger).toEqual({
      type: "condition",
      description: "Stars dropped for two consecutive days",
      sourceAgentRole: "owner",
      evaluatePrompt: "Return true when this condition is met: Stars dropped for two consecutive days",
    });
    expect(rule.taskTemplate.assigneeRole).toBe("owner");
    expect(rule.taskTemplate.title).toBe("Diagnose the drop and recommend a correction");
  });

  it("rejects unsupported biweekly template explicitly", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });

    expect(() =>
      service.createScheduleRuleFromTemplate(mission.id, {
        templateType: "biweekly_review",
        assigneeRole: "owner",
        taskGoal: "Review every two weeks",
      } as never),
    ).toThrow("Unsupported schedule template: biweekly_review");
  });

  it("pauses and resumes only automation-toggle-paused rules", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Track GitHub growth" });
    const enabled = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "daily_check",
      assigneeRole: "owner",
      taskGoal: "Check yesterday's GitHub growth metrics",
    });
    const manuallyDisabled = service.createScheduleRuleFromTemplate(mission.id, {
      templateType: "weekly_review",
      assigneeRole: "owner",
      taskGoal: "Review weekly GitHub growth",
    });
    service.updateScheduleRule(mission.id, manuallyDisabled.id, { enabled: false });

    service.pauseMissionAutomation(mission.id);

    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === enabled.id)?.enabled).toBe(false);
    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === enabled.id)?.metadata.pausedByAutomationToggle).toBe(true);
    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === manuallyDisabled.id)?.metadata.pausedByAutomationToggle).toBeUndefined();
    expect(service.getAutomationSummary(mission.id).automationPaused).toBe(true);

    service.resumeMissionAutomation(mission.id);

    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === enabled.id)?.enabled).toBe(true);
    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === enabled.id)?.metadata.pausedByAutomationToggle).toBeUndefined();
    expect(service.getScheduleRules(mission.id).find((rule) => rule.id === manuallyDisabled.id)?.enabled).toBe(false);
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "lightweight template|pauses and resumes"
```

Expected: FAIL with missing methods.

- [ ] **Step 3: Add template request type**

In `apps/server/src/mission-service.ts`, add after `AutomationSummary`:

```ts
export type ScheduleTemplateRequest =
  | {
      templateType: "daily_check" | "weekly_review";
      assigneeRole: string;
      taskGoal: string;
    }
  | {
      templateType: "condition_response";
      sourceAgentRole: string;
      condition: string;
      responseAssigneeRole: string;
      responseTaskGoal: string;
    };
```

- [ ] **Step 4: Implement template creation**

Add this public method after `addScheduleRule()`:

```ts
  createScheduleRuleFromTemplate(missionId: string, input: ScheduleTemplateRequest): ScheduleRule {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }

    let ruleInput: Parameters<typeof createScheduleRule>[0];
    if (input.templateType === "daily_check" || input.templateType === "weekly_review") {
      const isDaily = input.templateType === "daily_check";
      ruleInput = {
        name: isDaily ? "Daily check" : "Weekly review",
        missionId,
        enabled: true,
        trigger: {
          type: "cron",
          expression: isDaily ? "0 9 * * *" : "0 9 * * 1",
          timezone: "UTC",
        },
        taskTemplate: {
          title: input.taskGoal,
          contract: {
            objective: input.taskGoal,
            input: {
              missionGoal: mission.goal,
              templateType: input.templateType,
            },
            outputSchema: { summary: "string", nextActions: "array" },
            successCriteria: ["The result directly addresses the task goal", "The result includes concrete next actions"],
          },
          assigneeRole: input.assigneeRole,
          priority: "normal",
        },
        maxConcurrent: 1,
        metadata: { createdBy: "user_template", templateType: input.templateType },
      };
    } else if (input.templateType === "condition_response") {
      ruleInput = {
        name: "Condition response",
        missionId,
        enabled: true,
        trigger: {
          type: "condition",
          description: input.condition,
          sourceAgentRole: input.sourceAgentRole,
          evaluatePrompt: `Return true when this condition is met: ${input.condition}`,
        },
        taskTemplate: {
          title: input.responseTaskGoal,
          contract: {
            objective: input.responseTaskGoal,
            input: {
              missionGoal: mission.goal,
              condition: input.condition,
              templateType: input.templateType,
            },
            outputSchema: { diagnosis: "string", recommendation: "string", nextActions: "array" },
            successCriteria: ["The response addresses the condition", "The recommendation is actionable"],
          },
          assigneeRole: input.responseAssigneeRole,
          priority: "high",
        },
        maxConcurrent: 1,
        metadata: { createdBy: "user_template", templateType: input.templateType },
      };
    } else {
      const unsupported = (input as { templateType?: string }).templateType;
      throw new Error(`Unsupported schedule template: ${String(unsupported)}`);
    }

    const rule = createScheduleRule(ruleInput);
    this.addScheduleRule(missionId, rule);
    return rule;
  }
```

Ensure the top import from `@digitalagent/core` already includes `createScheduleRule`. If not, add it:

```ts
  createScheduleRule,
```

- [ ] **Step 5: Implement pause/resume**

Add these public methods after `updateScheduleRule()`:

```ts
  pauseMissionAutomation(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const updatedRules = mission.scheduleRules.map((rule) => {
      if (!rule.enabled) return rule;
      return {
        ...rule,
        enabled: false,
        metadata: {
          ...rule.metadata,
          pausedByAutomationToggle: true,
        },
      };
    });
    this.missions.set(mission.id, { ...mission, scheduleRules: updatedRules });
    this.schedulers.get(missionId)?.restart(updatedRules);
    this.persist();
  }

  resumeMissionAutomation(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    const updatedRules = mission.scheduleRules.map((rule) => {
      if (rule.metadata.pausedByAutomationToggle !== true) return rule;
      const { pausedByAutomationToggle: _paused, ...metadata } = rule.metadata;
      return {
        ...rule,
        enabled: true,
        metadata,
      };
    });
    this.missions.set(mission.id, { ...mission, scheduleRules: updatedRules });
    this.schedulers.get(missionId)?.restart(updatedRules);
    this.persist();
  }
```

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "lightweight template|pauses and resumes"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat: add schedule templates and automation pause"
```

---

### Task 5: Product Schedule API Routes

**Files:**
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/api.test.ts`

- [ ] **Step 1: Write failing API tests**

Append these tests inside `describe("schedule API endpoints", ...)` in `apps/server/src/api.test.ts`:

```ts
  it("GET /api/missions/:id/automation-summary returns automation summary", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    await addScheduleRule(missions, missionId, { assigneeRole: "owner" });

    const resp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${missionId}/automation-summary` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(200);
    expect((resp.body as { summary: { rulesCount: number; nextAction?: { ruleName: string } } }).summary.rulesCount).toBe(1);
    expect((resp.body as { summary: { nextAction?: { ruleName: string } } }).summary.nextAction?.ruleName).toBe("Daily check");
  });

  it("POST /api/missions/:id/schedule/trigger-next creates the next scheduled task", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const ruleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner" });

    const resp = await handleApiRequest(
      { method: "POST", path: `/api/missions/${missionId}/schedule/trigger-next`, body: {} },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(200);
    expect((resp.body as { task: { scheduleRuleId: string } }).task.scheduleRuleId).toBe(ruleId);
    expect((resp.body as { snapshot: MissionSnapshot }).snapshot.scheduleTriggerEvents).toHaveLength(1);
  });

  it("POST /api/missions/:id/schedule/templates creates a daily rule", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);

    const resp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule/templates`,
        body: {
          templateType: "daily_check",
          assigneeRole: "owner",
          taskGoal: "Check yesterday's GitHub growth metrics",
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(201);
    expect((resp.body as { rule: { metadata: Record<string, unknown> } }).rule.metadata.templateType).toBe("daily_check");
  });

  it("POST /api/missions/:id/schedule/templates rejects biweekly rules", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);

    const resp = await handleApiRequest(
      {
        method: "POST",
        path: `/api/missions/${missionId}/schedule/templates`,
        body: {
          templateType: "biweekly_review",
          assigneeRole: "owner",
          taskGoal: "Review every two weeks",
        },
      },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toContain("Unsupported schedule template: biweekly_review");
  });

  it("POST pause and resume toggle automation without restoring manually disabled rules", async () => {
    const missions = new InMemoryMissionService();
    const missionId = await createMissionViaApi(missions);
    const enabledRuleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner" });
    const disabledRuleId = await addScheduleRule(missions, missionId, { assigneeRole: "owner", title: "Weekly review" });
    missions.updateScheduleRule(missionId, disabledRuleId, { enabled: false });

    const pauseResp = await handleApiRequest(
      { method: "POST", path: `/api/missions/${missionId}/schedule/pause`, body: {} },
      { missions, openclaw: fakeOpenClaw() },
    );
    const resumeResp = await handleApiRequest(
      { method: "POST", path: `/api/missions/${missionId}/schedule/resume`, body: {} },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(pauseResp.status).toBe(200);
    expect(resumeResp.status).toBe(200);
    expect(missions.getScheduleRules(missionId).find((rule) => rule.id === enabledRuleId)?.enabled).toBe(true);
    expect(missions.getScheduleRules(missionId).find((rule) => rule.id === disabledRuleId)?.enabled).toBe(false);
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts -t "automation-summary|trigger-next|schedule/templates|pause and resume"
```

Expected: FAIL with 404 responses.

- [ ] **Step 3: Import schedule template type**

In `apps/server/src/api.ts`, update the mission-service import if needed:

```ts
import type { InMemoryMissionService, ScheduleTemplateRequest } from "./mission-service.js";
```

If `InMemoryMissionService` is currently imported separately as a value, use:

```ts
import { InMemoryMissionService, type ScheduleTemplateRequest } from "./mission-service.js";
```

Only keep the form that matches the file's current import style.

- [ ] **Step 4: Add automation summary route**

In `handleApiRequest()`, before the generic schedule regex block, add:

```ts
    const automationSummaryMatch = request.path.match(/^\/api\/missions\/([^/]+)\/automation-summary$/);
    if (automationSummaryMatch) {
      const missionId = automationSummaryMatch[1];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      if (request.method === "GET") {
        return json(200, { summary: deps.missions.getAutomationSummary(missionId) });
      }
    }
```

- [ ] **Step 5: Add product schedule actions before the generic schedule regex actions**

Still before the existing `scheduleMatch` handler, add:

```ts
    const scheduleProductActionMatch = request.path.match(
      /^\/api\/missions\/([^/]+)\/schedule\/(trigger-next|templates|pause|resume)$/,
    );
    if (scheduleProductActionMatch) {
      const missionId = scheduleProductActionMatch[1];
      const action = scheduleProductActionMatch[2];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }

      if (request.method === "POST" && action === "trigger-next") {
        const task = deps.missions.triggerNextScheduleRule(missionId);
        return json(200, { task, snapshot: deps.missions.snapshot() });
      }

      if (request.method === "POST" && action === "templates") {
        const body = expectObject(request.body);
        const templateType = expectString(body.templateType, "templateType");
        let input: ScheduleTemplateRequest;
        if (templateType === "daily_check" || templateType === "weekly_review") {
          input = {
            templateType,
            assigneeRole: expectString(body.assigneeRole, "assigneeRole"),
            taskGoal: expectString(body.taskGoal, "taskGoal"),
          };
        } else if (templateType === "condition_response") {
          input = {
            templateType,
            sourceAgentRole: expectString(body.sourceAgentRole, "sourceAgentRole"),
            condition: expectString(body.condition, "condition"),
            responseAssigneeRole: expectString(body.responseAssigneeRole, "responseAssigneeRole"),
            responseTaskGoal: expectString(body.responseTaskGoal, "responseTaskGoal"),
          };
        } else {
          throw new Error(`Unsupported schedule template: ${templateType}`);
        }
        const rule = deps.missions.createScheduleRuleFromTemplate(missionId, input);
        return json(201, { rule, snapshot: deps.missions.snapshot() });
      }

      if (request.method === "POST" && action === "pause") {
        deps.missions.pauseMissionAutomation(missionId);
        return json(200, { summary: deps.missions.getAutomationSummary(missionId), snapshot: deps.missions.snapshot() });
      }

      if (request.method === "POST" && action === "resume") {
        deps.missions.resumeMissionAutomation(missionId);
        return json(200, { summary: deps.missions.getAutomationSummary(missionId), snapshot: deps.missions.snapshot() });
      }
    }
```

This block must come before the existing schedule regex so `trigger-next`, `templates`, `pause`, and `resume` are not treated as rule IDs.

- [ ] **Step 6: Run API tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts -t "automation-summary|trigger-next|schedule/templates|pause and resume"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/api.ts apps/server/src/api.test.ts
git commit -m "feat: expose automation schedule APIs"
```

---

### Task 6: Frontend Automation State And War Room Pulse

**Files:**
- Modify: `apps/server/public/app.js`
- Modify: `apps/server/public/war-room.js`
- Modify: `apps/server/public/styles.css`

- [ ] **Step 1: Add frontend state**

In `apps/server/public/app.js`, extend `state`:

```js
  automationSummaryByMissionId: {},
  scheduleRulesByMissionId: {},
  scheduleActionPending: false,
  scheduleFormOpen: false,
  scheduleError: "",
```

Update `emptySnapshot()` to include trigger events so frontend code can safely read them:

```js
    scheduleTriggerEvents: [],
```

- [ ] **Step 2: Add automation API helpers**

In `apps/server/public/app.js`, after `api()` add:

```js
async function loadAutomationState(missionId) {
  if (!missionId) return;
  const [summaryResult, scheduleResult] = await Promise.all([
    api(`/api/missions/${missionId}/automation-summary`),
    api(`/api/missions/${missionId}/schedule`),
  ]);
  state.automationSummaryByMissionId[missionId] = summaryResult.summary;
  state.scheduleRulesByMissionId[missionId] = scheduleResult.rules;
}

async function refreshMissionAutomation() {
  const mission = currentMission();
  if (!mission) return;
  await loadAutomationState(mission.id);
}

async function triggerNextSchedule(missionId) {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  renderAll();
  try {
    const result = await api(`/api/missions/${missionId}/schedule/trigger-next`, { method: "POST", body: {} });
    state.snapshot = result.snapshot;
    await loadAutomationState(missionId);
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}

async function pauseAutomation(missionId) {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  renderAll();
  try {
    const result = await api(`/api/missions/${missionId}/schedule/pause`, { method: "POST", body: {} });
    state.snapshot = result.snapshot;
    state.automationSummaryByMissionId[missionId] = result.summary;
    await loadAutomationState(missionId);
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}

async function resumeAutomation(missionId) {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  renderAll();
  try {
    const result = await api(`/api/missions/${missionId}/schedule/resume`, { method: "POST", body: {} });
    state.snapshot = result.snapshot;
    state.automationSummaryByMissionId[missionId] = result.summary;
    await loadAutomationState(missionId);
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}
```

- [ ] **Step 3: Load automation state when refreshing and entering War Room**

In `refresh()`, after `syncSelectedMission();`, add:

```js
  if (state.view === "mission" && currentMission()) {
    await refreshMissionAutomation();
  }
```

In the `[data-open-war-room]` click handler, before `renderAll()` when switching into mission view, add:

```js
      await loadAutomationState(mission.id);
```

Use it in both branches: the branch that activates async and the branch that only opens the War Room.

- [ ] **Step 4: Add automation pulse rendering**

In `apps/server/public/war-room.js`, update `renderWarOverview(data)` to place the pulse after `.war-head`:

```js
    ${renderAutomationPulse(data, state.automationSummaryByMissionId[data.mission.id])}
```

Add these functions before `renderAgentNetwork(data)`:

```js
function renderAutomationPulse(data, summary) {
  if (!summary) {
    return `
      <div class="automation-pulse">
        <div>
          <strong>自动运行</strong>
          <p>正在读取 Mission 自动运行状态。</p>
        </div>
      </div>
    `;
  }

  const next = summary.nextAction;
  const current = summary.currentScheduledTasks || [];
  const paused = summary.automationPaused;
  const actionDisabled = state.scheduleActionPending ? "disabled" : "";
  return `
    <div class="automation-pulse ${paused ? "paused" : ""}">
      <div class="pulse-main">
        <span class="pulse-label">${paused ? "自动运行已暂停" : "下一次自动动作"}</span>
        <strong>${next ? esc(next.ruleName) : "还没有自动运行节奏"}</strong>
        <p>${next ? `${esc(formatTime(next.nextRunAt))} · ${esc(next.assigneeRole)} · ${esc(next.taskTitle)}` : "去定时任务页添加每日检查或每周复盘。"}</p>
      </div>
      <div class="pulse-side">
        <span>当前运行</span>
        <strong>${current.length ? `${current.length} 个任务` : "无排队任务"}</strong>
        <p>${summary.lastTrigger ? esc(summary.lastTrigger.message) : "暂无触发记录"}</p>
      </div>
      <div class="pulse-actions">
        <button type="button" data-trigger-next ${actionDisabled}>${state.scheduleActionPending ? "处理中..." : "立即触发下一步"}</button>
        <button type="button" data-toggle-automation="${paused ? "resume" : "pause"}" ${actionDisabled}>${paused ? "恢复自动运行" : "暂停自动运行"}</button>
      </div>
      ${state.scheduleError ? `<div class="inline-error">${esc(state.scheduleError)}</div>` : ""}
    </div>
  `;
}
```

- [ ] **Step 5: Bind pulse actions**

In `renderWarRoom()`, after binding `[data-war-tab]`, add:

```js
  const triggerNext = document.querySelector("[data-trigger-next]");
  if (triggerNext) {
    triggerNext.addEventListener("click", () => {
      const mission = currentMission();
      if (mission) void triggerNextSchedule(mission.id);
    });
  }
  const toggleAutomation = document.querySelector("[data-toggle-automation]");
  if (toggleAutomation) {
    toggleAutomation.addEventListener("click", () => {
      const mission = currentMission();
      if (!mission) return;
      if (toggleAutomation.dataset.toggleAutomation === "resume") {
        void resumeAutomation(mission.id);
      } else {
        void pauseAutomation(mission.id);
      }
    });
  }
```

- [ ] **Step 6: Add pulse styles**

In `apps/server/public/styles.css`, add near other War Room styles:

```css
.automation-pulse {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(220px, 0.8fr) auto;
  gap: 14px;
  align-items: center;
  margin-bottom: 18px;
  border: 1px solid #cfd7e3;
  border-radius: 12px;
  background: #ffffff;
  padding: 16px;
}
.automation-pulse.paused {
  border-color: #f2c94c;
  background: #fffaf0;
}
.pulse-label,
.pulse-side span {
  display: block;
  margin-bottom: 5px;
  color: #667085;
  font-size: 12px;
  font-weight: 800;
}
.pulse-main strong,
.pulse-side strong {
  display: block;
  margin-bottom: 4px;
  font-size: 16px;
}
.pulse-main p,
.pulse-side p {
  margin: 0;
  color: #5d6675;
  font-size: 13px;
  line-height: 1.5;
}
.pulse-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.pulse-actions button {
  border: 1px solid #15181d;
  border-radius: 8px;
  background: #15181d;
  color: #ffffff;
  padding: 9px 12px;
  font-weight: 800;
  cursor: pointer;
}
.pulse-actions button + button {
  border-color: #cfd7e3;
  background: #ffffff;
  color: #15181d;
}
.pulse-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.inline-error {
  grid-column: 1 / -1;
  border: 1px solid #f4b4b4;
  border-radius: 8px;
  background: #fff1f1;
  color: #b42318;
  padding: 9px 11px;
  font-size: 13px;
  font-weight: 700;
}
```

- [ ] **Step 7: Build and smoke test**

Run:

```bash
pnpm --filter @digitalagent/server build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/public/app.js apps/server/public/war-room.js apps/server/public/styles.css
git commit -m "feat: add war room automation pulse"
```

---

### Task 7: Frontend Schedule Tab And Template Form

**Files:**
- Modify: `apps/server/public/app.js`
- Modify: `apps/server/public/war-room.js`
- Modify: `apps/server/public/styles.css`

- [ ] **Step 1: Add template creation helper**

In `apps/server/public/app.js`, add after `resumeAutomation()`:

```js
async function createScheduleTemplate(missionId, payload, runNow) {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  renderAll();
  try {
    const result = await api(`/api/missions/${missionId}/schedule/templates`, {
      method: "POST",
      body: payload,
    });
    state.snapshot = result.snapshot;
    if (runNow) {
      const trigger = await api(`/api/missions/${missionId}/schedule/${result.rule.id}/trigger`, {
        method: "POST",
        body: {},
      });
      state.snapshot = trigger.snapshot || state.snapshot;
    }
    await loadAutomationState(missionId);
    state.scheduleFormOpen = false;
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}
```

If the existing manual trigger endpoint does not return `snapshot`, leave the `trigger.snapshot || state.snapshot` guard as shown.

- [ ] **Step 2: Replace the static schedule map entry**

In `apps/server/public/war-room.js`, change `renderWarTab(data)` so schedule is handled before the map:

```js
  if (state.warTab === "schedule") {
    return renderScheduleTab(data, state.scheduleRulesByMissionId[data.mission.id] || [], state.automationSummaryByMissionId[data.mission.id]);
  }
```

Remove the old `schedule` entry from the `map` object or leave it unreachable.

- [ ] **Step 3: Add schedule tab render functions**

Add these functions before `renderConversationFeed(data)`:

```js
function renderScheduleTab(data, rules, summary) {
  return `
    <div class="tab-panel schedule-panel">
      <div class="schedule-head">
        <div>
          <h1>定时任务</h1>
          <p>查看 Mission 的自动运行节奏，并用业务语言补充每日检查、每周复盘或条件响应。</p>
        </div>
        <button type="button" data-toggle-schedule-form>${state.scheduleFormOpen ? "收起" : "新增规则"}</button>
      </div>
      ${state.scheduleError ? `<div class="inline-error">${esc(state.scheduleError)}</div>` : ""}
      ${summary ? renderTriggerHistory(summary) : ""}
      ${state.scheduleFormOpen ? renderScheduleTemplateForm(data) : ""}
      <div class="schedule-rules">
        ${rules.length ? rules.map((rule) => renderScheduleRuleCard(data, rule)).join("") : `<div class="empty-state">还没有自动运行节奏。先新增每日检查或每周复盘。</div>`}
      </div>
    </div>
  `;
}

function renderScheduleRuleCard(data, rule) {
  const assignee = data.agents.find((agent) => agent.role === rule.taskTemplate.assigneeRole);
  const triggerText = rule.trigger.type === "cron"
    ? `周期：${esc(rule.trigger.expression)} · ${esc(rule.trigger.timezone)}`
    : `条件：${esc(rule.trigger.description)}`;
  return `
    <article class="schedule-card">
      <div>
        <strong>${esc(rule.name)}</strong>
        <p>${triggerText}</p>
        <p>负责人：${esc(assignee?.name || rule.taskTemplate.assigneeRole)} · 任务：${esc(rule.taskTemplate.title)}</p>
      </div>
      <span class="${rule.enabled ? "rule-enabled" : "rule-disabled"}">${rule.enabled ? "启用" : "暂停"}</span>
    </article>
  `;
}

function renderTriggerHistory(summary) {
  if (!summary.lastTrigger) {
    return `<div class="trigger-history">最近触发：暂无记录</div>`;
  }
  return `
    <div class="trigger-history">
      最近触发：${esc(summary.lastTrigger.ruleName)} · ${esc(summary.lastTrigger.status)} · ${esc(summary.lastTrigger.message)}
    </div>
  `;
}

function renderScheduleTemplateForm(data) {
  const roleOptions = data.agents
    .map((agent) => `<option value="${esc(agent.role)}">${esc(agent.name)} · ${esc(agent.role)}</option>`)
    .join("");
  return `
    <form id="schedule-template-form" class="schedule-form">
      <label>
        类型
        <select name="templateType">
          <option value="daily_check">每日检查</option>
          <option value="weekly_review">每周复盘</option>
          <option value="condition_response">条件响应</option>
        </select>
      </label>
      <label>
        负责人 Agent
        <select name="assigneeRole">${roleOptions}</select>
      </label>
      <label>
        任务目标
        <input name="taskGoal" placeholder="例如：检查昨日增长数据并给出下一步建议" />
      </label>
      <label>
        条件描述
        <input name="condition" placeholder="仅条件响应使用，例如：互动率连续两天下降" />
      </label>
      <label class="checkbox-line">
        <input name="runNow" type="checkbox" />
        现在执行一次
      </label>
      <button type="submit" ${state.scheduleActionPending ? "disabled" : ""}>创建规则</button>
    </form>
  `;
}
```

- [ ] **Step 4: Bind schedule tab interactions**

In `renderWarRoom()`, after pulse action bindings, add:

```js
  const scheduleFormToggle = document.querySelector("[data-toggle-schedule-form]");
  if (scheduleFormToggle) {
    scheduleFormToggle.addEventListener("click", () => {
      state.scheduleFormOpen = !state.scheduleFormOpen;
      renderWarRoom();
    });
  }
  const scheduleForm = document.getElementById("schedule-template-form");
  if (scheduleForm) {
    scheduleForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const mission = currentMission();
      if (!mission) return;
      const formData = new FormData(scheduleForm);
      const templateType = String(formData.get("templateType") || "");
      const assigneeRole = String(formData.get("assigneeRole") || "");
      const taskGoal = String(formData.get("taskGoal") || "").trim();
      const condition = String(formData.get("condition") || "").trim();
      const runNow = formData.get("runNow") === "on";
      const payload = templateType === "condition_response"
        ? {
            templateType,
            sourceAgentRole: assigneeRole,
            condition,
            responseAssigneeRole: assigneeRole,
            responseTaskGoal: taskGoal,
          }
        : { templateType, assigneeRole, taskGoal };
      void createScheduleTemplate(mission.id, payload, runNow);
    });
  }
```

- [ ] **Step 5: Add schedule tab styles**

In `apps/server/public/styles.css`, add:

```css
.schedule-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.schedule-head button,
.schedule-form button {
  border: 1px solid #15181d;
  border-radius: 8px;
  background: #15181d;
  color: #ffffff;
  padding: 9px 12px;
  font-weight: 800;
  cursor: pointer;
}
.trigger-history {
  margin-bottom: 14px;
  border: 1px solid #d8dee8;
  border-radius: 8px;
  background: #f9fafc;
  padding: 10px 12px;
  color: #4b5565;
  font-size: 13px;
  font-weight: 700;
}
.schedule-rules {
  display: grid;
  gap: 10px;
}
.schedule-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid #d8dee8;
  border-radius: 10px;
  background: #ffffff;
  padding: 14px;
}
.schedule-card strong {
  display: block;
  margin-bottom: 5px;
}
.schedule-card p {
  margin: 0 0 4px;
  color: #5d6675;
  font-size: 13px;
  line-height: 1.5;
}
.rule-enabled,
.rule-disabled {
  border-radius: 999px;
  padding: 5px 8px;
  font-size: 12px;
  font-weight: 800;
}
.rule-enabled {
  background: #ecfdf3;
  color: #067647;
}
.rule-disabled {
  background: #f2f4f7;
  color: #667085;
}
.schedule-form {
  display: grid;
  gap: 12px;
  margin-bottom: 16px;
  border: 1px solid #d8dee8;
  border-radius: 10px;
  background: #ffffff;
  padding: 14px;
}
.schedule-form label {
  display: grid;
  gap: 6px;
  color: #4b5565;
  font-size: 13px;
  font-weight: 800;
}
.schedule-form input,
.schedule-form select {
  width: 100%;
  border: 1px solid #cfd7e3;
  border-radius: 8px;
  padding: 9px 10px;
  color: #15181d;
  background: #ffffff;
}
.schedule-form .checkbox-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.schedule-form .checkbox-line input {
  width: auto;
}
```

- [ ] **Step 6: Build**

Run:

```bash
pnpm --filter @digitalagent/server build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/public/app.js apps/server/public/war-room.js apps/server/public/styles.css
git commit -m "feat: add schedule rule product UI"
```

---

### Task 8: Full Verification And Browser Acceptance

**Files:**
- No code changes expected unless verification finds defects.

- [ ] **Step 1: Run server tests**

Run:

```bash
pnpm --filter @digitalagent/server test
```

Expected: PASS.

- [ ] **Step 2: Run workspace tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Start local server**

Run:

```bash
pnpm dev
```

Expected output includes:

```text
DigitalAgent running at http://127.0.0.1:3000
```

- [ ] **Step 5: Verify War Room overview in browser**

Open `http://127.0.0.1:3000`.

Use an active Mission with schedule rules. If none exists, create a Mission, confirm the brief, enter War Room, and add a daily rule in the schedule tab.

Expected:

- Automation pulse appears above the agent network.
- Pulse shows next action or an empty state that points to the schedule tab.
- Pulse has `立即触发下一步`.
- Pulse has `暂停自动运行` or `恢复自动运行`.

- [ ] **Step 6: Verify trigger-next**

Click `立即触发下一步`.

Expected:

- A scheduled task is created.
- Automation pulse shows a current scheduled task or latest trigger message.
- `/api/snapshot` includes a task with `scheduleRuleId`.
- `/api/snapshot` includes a `scheduleTriggerEvents` entry.

- [ ] **Step 7: Verify schedule tab**

Open `定时任务`.

Expected:

- Rule cards render.
- Enabled/paused state is visible.
- Trigger history appears.
- `新增规则` opens the lightweight form.

- [ ] **Step 8: Verify template creation**

Create a daily rule:

- Type: `每日检查`
- Responsible Agent: any available owner or operational agent
- Task goal: `检查昨日增长数据并给出下一步建议`
- Check `现在执行一次`

Expected:

- Rule appears in the schedule tab.
- A scheduled task is created.
- Automation pulse updates after returning to overview.

- [ ] **Step 9: Verify pause/resume semantics**

Pause automation.

Expected:

- Summary shows paused state.
- Enabled rules become disabled.
- Rules manually disabled before pause remain disabled after resume.

Resume automation.

Expected:

- Rules paused by the automation toggle are enabled again.
- Manually disabled rules remain disabled.

- [ ] **Step 10: Commit fixes if verification found defects**

If verification required code changes:

```bash
git add apps/server/src apps/server/public
git commit -m "fix: stabilize automation productization flow"
```

If no code changes were needed, do not create an empty commit.
