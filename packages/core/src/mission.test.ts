import { describe, expect, it } from "vitest";
import {
  createMission,
  completeMission,
  cancelMission,
  pauseMission,
  resumeMission,
} from "./mission.js";

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

describe("pauseMission", () => {
  it("transitions active mission to paused", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const paused = pauseMission(mission);
    expect(paused.status).toBe("paused");
  });

  it("returns paused mission unchanged (idempotent)", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const first = pauseMission(mission);
    const second = pauseMission(first);
    expect(second.status).toBe("paused");
  });

  it("throws when mission is completed", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const completed = completeMission(mission);
    expect(() => pauseMission(completed)).toThrow("Cannot pause a completed mission");
  });

  it("throws when mission is cancelled", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const cancelled = cancelMission(mission);
    expect(() => pauseMission(cancelled)).toThrow("Cannot pause a cancelled mission");
  });
});

describe("resumeMission", () => {
  it("transitions paused mission back to active", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const paused = pauseMission(mission);
    const resumed = resumeMission(paused);
    expect(resumed.status).toBe("active");
  });

  it("returns active mission unchanged (idempotent)", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const resumed = resumeMission(mission);
    expect(resumed.status).toBe("active");
  });

  it("throws when mission is completed", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const completed = completeMission(mission);
    expect(() => resumeMission(completed)).toThrow("Cannot resume a completed mission");
  });

  it("throws when mission is cancelled", () => {
    const mission = createMission({ goal: "Test", successMetrics: ["done"], constraints: ["budget"] });
    const cancelled = cancelMission(mission);
    expect(() => resumeMission(cancelled)).toThrow("Cannot resume a cancelled mission");
  });
});
