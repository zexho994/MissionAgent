import { createId } from "./ids.js";
import type { HttpPublishTargetConfig, MissionPublishTarget } from "./types.js";

export interface CreateMissionPublishTargetInput {
  missionId: string;
  name: string;
  adapter: "http";
  config: HttpPublishTargetConfig;
  contentTypes: string[];
}

export function createMissionPublishTarget(
  input: CreateMissionPublishTargetInput,
): MissionPublishTarget {
  if (!input.missionId.trim()) {
    throw new Error("Mission publish target missionId is required");
  }
  if (!input.name.trim()) {
    throw new Error("Mission publish target name is required");
  }
  if (!input.config.url.trim()) {
    throw new Error("Mission publish target url is required");
  }
  const contentTypes = input.contentTypes.length > 0 ? [...input.contentTypes] : ["*"];
  return {
    id: createId("publishtarget"),
    missionId: input.missionId,
    name: input.name.trim(),
    adapter: input.adapter,
    config: {
      url: input.config.url,
      method: input.config.method,
      ...(input.config.headers ? { headers: { ...input.config.headers } } : {}),
    },
    status: "idle",
    contentTypes,
    attempts: [],
    createdAt: new Date().toISOString(),
  };
}
