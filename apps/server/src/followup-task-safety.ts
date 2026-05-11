export interface FollowupSafetyConfig {
  maxFollowupsPerEvent: number;
  maxTotalTasksPerMission: number;
}

export interface FollowupSafetyContext {
  missionId: string;
  triggeringEventId: string;
  totalTasksInMission: number;
  followupsAlreadyCreatedForEvent: number;
}

export type FollowupSafetyResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "per_event_limit" | "mission_cap" | "no_assignee";
      limit: number;
      escalateToUser?: boolean;
    };

export function checkFollowupSafety(
  config: FollowupSafetyConfig,
  ctx: FollowupSafetyContext,
): FollowupSafetyResult {
  if (ctx.totalTasksInMission >= config.maxTotalTasksPerMission) {
    return {
      allowed: false,
      reason: "mission_cap",
      limit: config.maxTotalTasksPerMission,
      escalateToUser: true,
    };
  }
  if (ctx.followupsAlreadyCreatedForEvent >= config.maxFollowupsPerEvent) {
    return {
      allowed: false,
      reason: "per_event_limit",
      limit: config.maxFollowupsPerEvent,
    };
  }
  return { allowed: true };
}

export const DEFAULT_FOLLOWUP_SAFETY: FollowupSafetyConfig = {
  maxFollowupsPerEvent: 1,
  maxTotalTasksPerMission: 50,
};
