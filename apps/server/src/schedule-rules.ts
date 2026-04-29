import type { CronTrigger } from "@digitalagent/core";
import { CronExpressionParser } from "cron-parser";

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

  try {
    CronExpressionParser.parse(trimmed);
  } catch (error) {
    throw new Error(`Unsupported cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function nextRunAfter(trigger: CronTrigger, after: Date): Date {
  validateCronExpression(trigger.expression);

  const interval = CronExpressionParser.parse(trigger.expression, {
    currentDate: after,
    tz: trigger.timezone,
  });

  return interval.next().toDate();
}

export function isDue(nextRunAt: string, now: Date): boolean {
  return now >= new Date(nextRunAt);
}
