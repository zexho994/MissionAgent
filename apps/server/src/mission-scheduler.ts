import type { ScheduleRule, Task, TaskContract } from "@digitalagent/core";
import { isDue, nextRunAfter } from "./schedule-rules.js";

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
    template: {
      title: string;
      contract: TaskContract;
      assigneeRole: string;
      priority: "low" | "normal" | "high";
    },
    agentId: string,
  ) => Task;
  assignTask: (taskId: string, agentId: string) => void;
  notifyOwner: (message: string) => void;
  recordSkippedTrigger?: (rule: ScheduleRule) => void;
  evaluateCondition?: (
    prompt: string,
    context: { artifactContent: string; missionGoal: string },
  ) => Promise<boolean>;
}

export class MissionScheduler {
  private readonly deps: SchedulerDeps;
  private rules: ScheduleRule[] = [];
  private readonly nextRunByRuleId = new Map<string, string>();
  private intervalHandle: unknown | undefined;
  private running = false;
  private static readonly TICK_INTERVAL_MS = 60_000;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(rules: ScheduleRule[]): void {
    this.stop();
    this.rules = [...rules];
    this.seedNextRuns();
    this.running = true;
    this.intervalHandle = this.deps.clock.setInterval(() => {
      this.onTick();
    }, MissionScheduler.TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle !== undefined) {
      this.deps.clock.clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    this.rules = [];
    this.nextRunByRuleId.clear();
    this.running = false;
  }

  restart(rules: ScheduleRule[]): void {
    this.start(rules);
  }

  addRule(rule: ScheduleRule): void {
    this.rules = [...this.rules, rule];
    this.seedNextRun(rule);
  }

  removeRule(ruleId: string): void {
    this.rules = this.rules.filter((rule) => rule.id !== ruleId);
    this.nextRunByRuleId.delete(ruleId);
  }

  updateRule(ruleId: string, patch: Partial<ScheduleRule>): void {
    this.rules = this.rules.map((rule) => {
      if (rule.id !== ruleId) return rule;
      const updated = { ...rule, ...patch };
      if (updated.trigger.type === "cron") {
        this.seedNextRun(updated);
      } else {
        this.nextRunByRuleId.delete(ruleId);
      }
      return updated;
    });
  }

  getRules(): ScheduleRule[] {
    return [...this.rules];
  }

  isRunning(): boolean {
    return this.running;
  }

  getNextRunAt(ruleId: string): string | undefined {
    return this.nextRunByRuleId.get(ruleId);
  }

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
        const satisfied = await this.deps.evaluateCondition(rule.trigger.evaluatePrompt, {
          artifactContent: context.artifactContent,
          missionGoal: context.missionGoal,
        });
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

  private seedNextRuns(): void {
    this.nextRunByRuleId.clear();
    for (const rule of this.rules) {
      this.seedNextRun(rule);
    }
  }

  private seedNextRun(rule: ScheduleRule): void {
    if (rule.trigger.type !== "cron") return;
    this.nextRunByRuleId.set(rule.id, nextRunAfter(rule.trigger, this.deps.clock.now()).toISOString());
  }

  private onTick(): void {
    const now = this.deps.clock.now();
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.trigger.type !== "cron") continue;

      const nextRunAt = this.nextRunByRuleId.get(rule.id);
      if (!nextRunAt || !isDue(nextRunAt, now)) continue;

      this.onTrigger(rule);
      this.nextRunByRuleId.set(rule.id, nextRunAfter(rule.trigger, now).toISOString());
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
      this.deps.recordSkippedTrigger?.(rule);
      return;
    }

    const task = this.deps.createTaskFromTemplate(rule.id, rule.taskTemplate, agent.id);
    this.deps.assignTask(task.id, agent.id);
  }
}
