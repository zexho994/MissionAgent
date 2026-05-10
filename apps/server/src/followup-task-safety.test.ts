import { describe, expect, it } from "vitest";
import {
  checkFollowupSafety,
  type FollowupSafetyConfig,
  type FollowupSafetyContext,
} from "./followup-task-safety.js";

const config: FollowupSafetyConfig = {
  maxFollowupsPerEvent: 1,
  maxTotalTasksPerMission: 50,
};

const baseCtx: FollowupSafetyContext = {
  missionId: "m-1",
  triggeringEventId: "ev-1",
  totalTasksInMission: 5,
  followupsAlreadyCreatedForEvent: 0,
};

describe("checkFollowupSafety", () => {
  it("approves when within all limits", () => {
    expect(checkFollowupSafety(config, baseCtx)).toEqual({ allowed: true });
  });

  it("blocks when per-event limit reached", () => {
    expect(
      checkFollowupSafety(config, { ...baseCtx, followupsAlreadyCreatedForEvent: 1 }),
    ).toEqual({ allowed: false, reason: "per_event_limit", limit: 1 });
  });

  it("blocks and signals escalation when mission cap reached", () => {
    expect(
      checkFollowupSafety(config, { ...baseCtx, totalTasksInMission: 50 }),
    ).toEqual({
      allowed: false,
      reason: "mission_cap",
      limit: 50,
      escalateToUser: true,
    });
  });

  it("blocks at mission_cap when both limits hit (mission cap is more severe)", () => {
    const result = checkFollowupSafety(config, {
      ...baseCtx,
      followupsAlreadyCreatedForEvent: 1,
      totalTasksInMission: 50,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("mission_cap");
      expect(result.escalateToUser).toBe(true);
    }
  });
});
