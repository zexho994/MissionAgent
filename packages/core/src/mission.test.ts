import { describe, expect, it } from "vitest";
import { createMission } from "./mission.js";

describe("createMission", () => {
  it("creates an active mission with explicit success metrics and constraints", () => {
    const mission = createMission({
      goal: "Grow a Xiaohongshu account to 1000 followers in 30 days",
      successMetrics: ["followers >= 1000", "daily review generated"],
      constraints: ["human approval before publishing"],
      budget: {
        maxRuntimeMinutes: 1800,
        maxTokenSpendUsd: 100,
      },
    });

    expect(mission.status).toBe("active");
    expect(mission.goal).toContain("1000 followers");
    expect(mission.successMetrics).toHaveLength(2);
    expect(mission.budget.maxTokenSpendUsd).toBe(100);
  });

  it("fails fast when a mission has no success metrics", () => {
    expect(() =>
      createMission({
        goal: "Grow a Xiaohongshu account",
        successMetrics: [],
        constraints: ["human approval before publishing"],
      }),
    ).toThrow("Mission requires at least one success metric");
  });
});
