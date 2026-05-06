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
    expect(() => validateCronExpression("0 9 * * 1-5")).toThrow("Unsupported cron expression");
  });

  it("rejects named day syntax", () => {
    expect(() => validateCronExpression("0 9 * * MON")).toThrow("Unsupported cron expression");
  });

  it("rejects expressions with six fields", () => {
    expect(() => validateCronExpression("0 0 9 * * *")).toThrow("Unsupported cron expression");
  });

  it("rejects expressions with fewer than five fields", () => {
    expect(() => validateCronExpression("0 9 * *")).toThrow("Unsupported cron expression");
  });

  it("rejects empty expression", () => {
    expect(() => validateCronExpression("")).toThrow("Unsupported cron expression");
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
