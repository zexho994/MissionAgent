import { describe, expect, it } from "vitest";
import { MissionScheduler, type SchedulerClock, type SchedulerDeps } from "./mission-scheduler.js";
import type { ScheduleRule, Task } from "@digitalagent/core";
import { createScheduleRule } from "@digitalagent/core";

function fakeClock(): SchedulerClock & { advance(ms: number): void } {
  let now = new Date("2026-04-29T08:59:00Z");
  const intervals: Array<{ handler: () => void; ms: number; remaining: number; active: boolean }> = [];

  return {
    now: () => now,
    setInterval(handler: () => void, ms: number) {
      intervals.push({ handler, ms, remaining: ms, active: true });
      return intervals.length - 1;
    },
    clearInterval(handle: unknown) {
      const entry = intervals[handle as number];
      if (entry) {
        entry.active = false;
      }
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      for (const entry of intervals) {
        if (!entry.active) continue;
        entry.remaining -= ms;
        while (entry.remaining <= 0) {
          entry.remaining += entry.ms;
          entry.handler();
        }
      }
    },
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
    createTaskFromTemplate: (ruleId: string, template) => {
      createdTasks.push({ ruleId, taskTitle: template.title, assigneeRole: template.assigneeRole });
      return { id: "task_1", title: template.title, status: "draft" } as Task;
    },
    assignTask: () => {},
    notifyOwner: () => {},
    evaluateCondition: async () => false,
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

function conditionRule(overrides?: Partial<ScheduleRule>): ScheduleRule {
  const base = createScheduleRule({
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
  return overrides ? { ...base, ...overrides } : base;
}

describe("MissionScheduler", () => {
  it("creates a task when cron fires", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    scheduler.start([cronRule()]);
    clock.advance(60_000);

    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0]?.taskTitle).toBe("Check yesterday's engagement data");
  });

  it("skips disabled rules", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    scheduler.start([cronRule({ enabled: false })]);
    clock.advance(60_000);

    expect(createdTasks).toHaveLength(0);
  });

  it("skips when maxConcurrent is exceeded", () => {
    const { clock, createdTasks, deps } = makeDeps();
    deps.countIncompleteTasksForRule = () => 5;
    const scheduler = new MissionScheduler(deps);

    scheduler.start([cronRule({ maxConcurrent: 1 })]);
    clock.advance(60_000);

    expect(createdTasks).toHaveLength(0);
  });

  it("warns and skips when agent not found", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const notified: string[] = [];
    deps.findAgentByRole = () => undefined;
    deps.notifyOwner = (message: string) => notified.push(message);
    const scheduler = new MissionScheduler(deps);

    scheduler.start([cronRule()]);
    clock.advance(60_000);

    expect(createdTasks).toHaveLength(0);
    expect(notified.length).toBeGreaterThan(0);
  });

  it("stop clears all intervals", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    scheduler.start([cronRule()]);
    scheduler.stop();
    clock.advance(60_000);

    expect(createdTasks).toHaveLength(0);
    expect(scheduler.getRules()).toEqual([]);
  });

  it("restart replaces rules", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    scheduler.start([cronRule({ enabled: false })]);
    scheduler.restart([cronRule()]);
    clock.advance(60_000);

    expect(createdTasks).toHaveLength(1);
  });

  it("addRule adds a new rule to running scheduler", () => {
    const { clock, createdTasks, deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);

    scheduler.start([]);
    scheduler.addRule(cronRule());
    clock.advance(60_000);

    expect(createdTasks).toHaveLength(1);
  });

  it("invokes executeScheduledTask after creating and assigning a scheduled task", () => {
    const { clock, deps } = makeDeps();
    const executed: Array<{ taskId: string; message: string }> = [];
    deps.executeScheduledTask = (taskId, message) => {
      executed.push({ taskId, message });
    };
    const scheduler = new MissionScheduler(deps);

    scheduler.start([cronRule()]);
    clock.advance(60_000);

    expect(executed).toHaveLength(1);
    expect(executed[0]?.taskId).toBe("task_1");
    expect(executed[0]?.message).toContain("Daily data check");
  });

  it("addRule does not reset existing rule next run", () => {
    const { deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);
    const rule1 = cronRule();
    const rule2 = cronRule({ name: "Second rule" });

    scheduler.start([rule1]);
    const nextRunAt = scheduler.getNextRunAt(rule1.id);
    scheduler.addRule(rule2);

    expect(scheduler.getNextRunAt(rule1.id)).toBe(nextRunAt);
    expect(scheduler.getNextRunAt(rule2.id)).toBeDefined();
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

    scheduler.start([cronRule()]);

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

  it("updateRule clears next run when cron rule becomes condition rule", () => {
    const { deps } = makeDeps();
    const scheduler = new MissionScheduler(deps);
    const rule = cronRule();

    scheduler.start([rule]);
    expect(scheduler.getNextRunAt(rule.id)).toBeDefined();
    scheduler.updateRule(rule.id, { trigger: conditionRule().trigger });

    expect(scheduler.getNextRunAt(rule.id)).toBeUndefined();
  });
});

describe("condition trigger evaluation", () => {
  it("creates task when LLM evaluates condition as true", async () => {
    const { createdTasks, deps } = makeDeps();
    deps.evaluateCondition = async () => true;
    const scheduler = new MissionScheduler(deps);

    scheduler.start([conditionRule()]);
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

    scheduler.start([conditionRule()]);
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

    scheduler.start([conditionRule()]);
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

    scheduler.start([conditionRule({ enabled: false })]);
    await scheduler.evaluateConditions({
      completedTaskAssigneeRole: "data-analyst",
      artifactContent: "Engagement rate dropped by 25%.",
      missionGoal: "Grow Xiaohongshu account",
    });

    expect(createdTasks).toHaveLength(0);
  });
});
