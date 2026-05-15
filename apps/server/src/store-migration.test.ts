import { describe, expect, it } from "vitest";
import { migrateOpenClawToPi } from "./store-migration.js";

describe("migrateOpenClawToPi", () => {
  it("returns unchanged store when no openclaw key present", () => {
    const store = { missions: [] as unknown[], migrationDone: true };
    const result = migrateOpenClawToPi(JSON.stringify(store));
    expect(JSON.parse(result.json)).toEqual(store);
    expect(result.migrated).toBe(false);
  });

  it("rewrites openclaw substrings to pi in keys and values", () => {
    const store = {
      tasks: [
        {
          artifact: {
            content: { openclaw: { searchResults: [{ url: "https://x" }] } },
            evidence: ["openclaw:local"],
          },
          assignedTo: "openclaw_runner",
        },
      ],
    };
    const result = migrateOpenClawToPi(JSON.stringify(store));
    const parsed = JSON.parse(result.json);
    expect(parsed.tasks[0].artifact.content.pi).toBeDefined();
    expect(parsed.tasks[0].artifact.content.openclaw).toBeUndefined();
    expect(parsed.tasks[0].artifact.evidence).toEqual(["pi:local"]);
    expect(parsed.tasks[0].assignedTo).toBe("pi_runner");
    expect(parsed.migrationDone).toBe(true);
    expect(result.migrated).toBe(true);
  });

  it("rewrites stale OpenClaw UI messages and unclear feedback copy", () => {
    const store = {
      schemaVersion: 1,
      migrationDone: true,
      agentMessages: [
        {
          content: "Started local OpenClaw execution for the current task.",
        },
      ],
      taskEvents: [
        {
          summary: "接龙执行者 invoked OpenClaw local agent.",
        },
      ],
      feedback: [
        {
          proposedStrategy:
            'Reassess strategy after "修正知识库反馈记录" failed to produce usable Mission progress.',
          rationale: "Agent output is empty or too short",
        },
      ],
      reviews: [
        {
          comments: ["Artifact has no OpenClaw output"],
        },
      ],
    };

    const result = migrateOpenClawToPi(JSON.stringify(store));
    const parsed = JSON.parse(result.json);
    expect(parsed.agentMessages[0].content).toBe(
      "Started local pi-agent execution for the current task.",
    );
    expect(parsed.taskEvents[0].summary).toBe("接龙执行者 invoked local pi-agent runtime.");
    expect(parsed.feedback[0].proposedStrategy).toBe(
      "重新评估任务策略：当前任务“修正知识库反馈记录”没有产出可验收的 Mission 进展。",
    );
    expect(parsed.feedback[0].rationale).toBe("Agent 输出为空或过短，无法作为有效结果验收。");
    expect(parsed.reviews[0].comments).toEqual(["Artifact has no pi-agent output"]);
    expect(parsed.migrationDone).toBe(true);
    expect(result.migrated).toBe(true);
  });

  it("is idempotent on a store already migrated", () => {
    const store = { tasks: [{ content: { pi: 1 } }], migrationDone: true };
    const result = migrateOpenClawToPi(JSON.stringify(store));
    expect(JSON.parse(result.json)).toEqual(store);
    expect(result.migrated).toBe(false);
  });

  it("handles empty store", () => {
    const result = migrateOpenClawToPi("{}");
    expect(JSON.parse(result.json)).toEqual({ migrationDone: true });
    expect(result.migrated).toBe(false);
  });
});
