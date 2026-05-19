import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadAgentSystemConfig } from "./system-config.js";

function baseConfig() {
  return {
    owner: {
      prompts: {
        systemPrompt: "owner",
        gatheringInstruction: "gather",
        briefSchema: "{}",
        maxGatheringTurns: 5,
      },
      brief: {
        summaryTemplate: "summary",
        successMetrics: ["metric"],
        constraints: ["constraint"],
      },
      followup: {
        template: "followup {{message}}",
      },
    },
    teamPlanner: {
      baseAgents: [
        {
          role: "owner",
          name: "Owner Agent",
          responsibility: "Own mission",
          status: "idle",
          currentTask: false,
          lastAction: "idle",
          avatarSeed: "owner",
        },
      ],
      capabilityMatchers: {
        plan: ["plan"],
        execute: ["execute"],
        review: ["review"],
      },
    },
    ui: {
      emptyPrompt: "empty",
      starterPrompts: [],
    },
  };
}

function writeConfig(value: unknown) {
  const dir = join(tmpdir(), `digitalagent-config-${Date.now()}-${Math.random()}`);
  mkdirSync(join(dir, "config", "skills"), { recursive: true });
  const file = join(dir, "config", "agent-system.json");
  writeFileSync(file, JSON.stringify(value, null, 2));
  return { dir, file };
}

describe("loadAgentSystemConfig skills config", () => {
  it("loads skills.rootDir when configured", () => {
    const config = baseConfig();
    const { file } = writeConfig({
      ...config,
      skills: { rootDir: "config/skills" },
    });

    expect(loadAgentSystemConfig(file).skills).toEqual({ rootDir: "config/skills" });
  });

  it("fails fast when skills.rootDir is missing", () => {
    const { file } = writeConfig(baseConfig());

    expect(() => loadAgentSystemConfig(file)).toThrow("skills.rootDir is required");
  });

  it("fails fast when skills.rootDir is empty", () => {
    const { file } = writeConfig({
      ...baseConfig(),
      skills: { rootDir: "" },
    });

    expect(() => loadAgentSystemConfig(file)).toThrow("skills.rootDir is required");
  });
});