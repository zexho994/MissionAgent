import { describe, expect, it } from "vitest";
import { createAgentInstance, createRoleSpec } from "./agent-runtime.js";

describe("agent runtime", () => {
  it("creates an agent instance from a role spec with scoped tools and budget", () => {
    const role = createRoleSpec({
      name: "CompetitorResearchAgent",
      purpose: "Analyze competing Xiaohongshu accounts",
      responsibilities: ["collect notes", "summarize content patterns"],
      allowedTools: ["openclaw.browser", "xhs.collect_notes"],
      inputContract: { keywords: "string[]" },
      outputContract: { patterns: "array" },
      successCriteria: ["sources included"],
      budget: {
        maxRuntimeMinutes: 30,
        maxTasks: 3,
      },
    });

    const agent = createAgentInstance({
      missionId: "mission_1",
      roleSpec: role,
      memoryScope: "mission",
    });

    expect(agent.status).toBe("idle");
    expect(agent.roleSpec.name).toBe("CompetitorResearchAgent");
    expect(agent.toolPermissions).toEqual(["openclaw.browser", "xhs.collect_notes"]);
    expect(agent.budget.maxTasks).toBe(3);
  });

  it("fails fast when a role spec has no allowed tools", () => {
    expect(() =>
      createRoleSpec({
        name: "NoToolAgent",
        purpose: "Do undefined work",
        responsibilities: ["guess"],
        allowedTools: [],
        inputContract: {},
        outputContract: {},
        successCriteria: ["done"],
        budget: {
          maxRuntimeMinutes: 10,
          maxTasks: 1,
        },
      }),
    ).toThrow("RoleSpec requires at least one allowed tool");
  });
});
