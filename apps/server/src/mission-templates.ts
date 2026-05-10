import type {
  CreateMissionDataSourceInput,
  CreateMissionPublishTargetInput,
} from "@digitalagent/core";

export interface MissionTemplate {
  id: string;
  goal: string;
  successMetrics: string[];
  constraints: string[];
  budget?: {
    maxRuntimeMinutes?: number;
    maxTokenSpendUsd?: number;
    maxFollowupTasks?: number;
  };
  dataSources?: Array<Omit<CreateMissionDataSourceInput, "missionId">>;
  publishTargets?: Array<Omit<CreateMissionPublishTargetInput, "missionId">>;
}

export const MISSION_TEMPLATES: Record<string, MissionTemplate> = {
  "speakin-content": {
    id: "speakin-content",
    goal: "research and publish weekly content for speakin.cc to drive organic growth",
    successMetrics: [
      "weekly review of GSC keyword performance",
      "at least 1 new article published per week",
      "track article performance week over week",
    ],
    constraints: [
      "all content must be published to speakin.cc /api/posts",
      "GSC data must be referenced in topic selection",
    ],
    budget: { maxRuntimeMinutes: 1440, maxFollowupTasks: 30 },
    dataSources: [
      {
        name: "Google Search Console (speakin)",
        adapter: "http",
        config: {
          url: "https://www.googleapis.com/webmasters/v3/sites/speakin.cc/searchAnalytics/query",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            startDate: "auto",
            endDate: "auto",
            dimensions: ["query"],
          }),
        },
      },
    ],
    publishTargets: [
      {
        name: "speakin.cc blog",
        adapter: "http",
        config: { url: "https://speakin.cc/api/posts", method: "POST" },
        contentTypes: ["*"],
      },
    ],
  },
};

export function getMissionTemplate(id: string): MissionTemplate {
  const template = MISSION_TEMPLATES[id];
  if (!template) {
    throw new Error(`Unknown mission template: ${id}`);
  }
  return template;
}

export function listMissionTemplates(): Array<{ id: string; goal: string }> {
  return Object.values(MISSION_TEMPLATES).map((t) => ({ id: t.id, goal: t.goal }));
}
