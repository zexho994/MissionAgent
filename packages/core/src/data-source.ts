import { createId } from "./ids.js";
import type { HttpDataSourceConfig, MissionDataSource } from "./types.js";

export interface CreateMissionDataSourceInput {
  missionId: string;
  name: string;
  adapter: "http";
  config: HttpDataSourceConfig;
}

export function createMissionDataSource(input: CreateMissionDataSourceInput): MissionDataSource {
  if (!input.missionId.trim()) {
    throw new Error("Mission data source missionId is required");
  }
  if (!input.name.trim()) {
    throw new Error("Mission data source name is required");
  }
  if (!input.config.url.trim()) {
    throw new Error("Mission data source url is required");
  }
  return {
    id: createId("datasource"),
    missionId: input.missionId,
    name: input.name.trim(),
    adapter: input.adapter,
    config: {
      url: input.config.url,
      method: input.config.method,
      ...(input.config.headers ? { headers: { ...input.config.headers } } : {}),
      ...(input.config.body !== undefined ? { body: input.config.body } : {}),
    },
    status: "idle",
    fetchHistory: [],
    createdAt: new Date().toISOString(),
  };
}
